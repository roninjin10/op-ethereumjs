import {
  bytesToInt,
  bytesToUnprefixedHex,
  equalsBytes,
  unprefixedHexToBytes,
  utf8ToBytes,
} from '@ethereumjs/util'
import debugDefault from 'debug'
import { secp256k1 } from 'ethereum-cryptography/secp256k1.js'
import { EventEmitter } from 'events'
import * as net from 'net'
import * as os from 'os'

import { DISCONNECT_REASON } from '../types.js'
import { createDeferred, devp2pDebug, formatLogId, pk2id } from '../util.js'

import { Peer } from './peer.js'

import type { DPT } from '../dpt/index.js'
import type { Capabilities, PeerInfo, RLPxOptions } from '../types.js'
import type { Common } from '@ethereumjs/common'
import type { Debugger } from 'debug'
import type LRUCache from 'lru-cache'
const { debug: createDebugLogger } = debugDefault

// note: relative path only valid in .js file in dist

const LRU = require('lru-cache')

const DEBUG_BASE_NAME = 'rlpx'
const verbose = createDebugLogger('verbose').enabled

export class RLPx {
  public events: EventEmitter
  protected _privateKey: Uint8Array
  public readonly id: Uint8Array
  private _debug: Debugger
  protected _timeout: number
  protected _maxPeers: number
  public readonly clientId: Uint8Array
  protected _remoteClientIdFilter?: string[]
  protected _capabilities: Capabilities[]
  protected _common: Common
  protected _listenPort: number | null
  protected _dpt: DPT | null

  protected _peersLRU: LRUCache<string, boolean>
  protected _peersQueue: { peer: PeerInfo; ts: number }[]
  protected _server: net.Server | null
  protected _peers: Map<string, net.Socket | Peer>

  protected _refillIntervalId: NodeJS.Timeout
  protected _refillIntervalSelectionCounter: number = 0

  constructor(privateKey: Uint8Array, options: RLPxOptions) {
    this.events = new EventEmitter()
    this._privateKey = privateKey
    this.id = pk2id(secp256k1.getPublicKey(this._privateKey, false))

    // options
    this._timeout = options.timeout ?? 10000 // 10 sec * 1000
    this._maxPeers = options.maxPeers ?? 10

    this.clientId = options.clientId
      ? options.clientId
      : utf8ToBytes(`ethereumjs-devp2p/${os.platform()}-${os.arch()}/nodejs`)

    this._remoteClientIdFilter = options.remoteClientIdFilter
    this._capabilities = options.capabilities
    this._common = options.common
    this._listenPort = options.listenPort ?? null

    // DPT
    this._dpt = options.dpt ?? null
    if (this._dpt !== null) {
      this._dpt.events.on('peer:new', (peer: PeerInfo) => {
        if (peer.tcpPort === null || peer.tcpPort === undefined) {
          this._dpt!.banPeer(peer, 300000) // 5 min * 60 * 1000
          this._debug(`banning peer with missing tcp port: ${peer.address}`)
          return
        }
        const key = bytesToUnprefixedHex(peer.id!)
        if (this._peersLRU.has(key)) return
        this._peersLRU.set(key, true)

        if (this._getOpenSlots() > 0) {
          return this._connectToPeer(peer)
        } else if (this._getOpenQueueSlots() > 0) {
          this._peersQueue.push({ peer, ts: 0 }) // save to queue
        }
      })
      this._dpt.events.on('peer:removed', (peer: PeerInfo) => {
        // remove from queue
        this._peersQueue = this._peersQueue.filter(
          (item) => !equalsBytes(item.peer.id! as Uint8Array, peer.id as Uint8Array)
        )
      })
    }
    // internal
    this._server = net.createServer()
    this._server.once('listening', () => this.events.emit('listening'))
    this._server.once('close', () => this.events.emit('close'))
    this._server.on('error', (err) => this.events.emit('error', err))
    this._server.on('connection', (socket) => this._onConnect(socket, null))
    const serverAddress = this._server.address()
    this._debug =
      serverAddress !== null
        ? devp2pDebug.extend(DEBUG_BASE_NAME).extend(serverAddress as string)
        : devp2pDebug.extend(DEBUG_BASE_NAME)
    this._peers = new Map()
    this._peersQueue = []
    this._peersLRU = new LRU({ max: 25000 })
    const REFILL_INTERVALL = 10000 // 10 sec * 1000
    const refillIntervalSubdivided = Math.floor(REFILL_INTERVALL / 10)
    this._refillIntervalId = setInterval(() => this._refillConnections(), refillIntervalSubdivided)
  }

  listen(...args: any[]) {
    this._isAliveCheck()
    this._debug('call .listen')

    if (this._server) this._server.listen(...args)
  }

  destroy(...args: any[]) {
    this._isAliveCheck()
    this._debug('call .destroy')

    clearInterval(this._refillIntervalId)

    if (this._server) this._server.close(...args)
    this._server = null

    for (const peerKey of this._peers.keys()) this.disconnect(unprefixedHexToBytes(peerKey))
  }

  async connect(peer: PeerInfo) {
    if (peer.tcpPort === undefined || peer.tcpPort === null || peer.address === undefined) return
    this._isAliveCheck()

    if (!(peer.id instanceof Uint8Array)) throw new TypeError('Expected peer.id as Uint8Array')
    const peerKey = bytesToUnprefixedHex(peer.id)

    if (this._peers.has(peerKey)) throw new Error('Already connected')
    if (this._getOpenSlots() === 0) throw new Error('Too many peers already connected')

    this._debug(`connect to ${peer.address}:${peer.tcpPort} (id: ${formatLogId(peerKey, verbose)})`)
    const deferred = createDeferred()

    const socket = new net.Socket()
    this._peers.set(peerKey, socket)
    socket.once('close', () => {
      this._peers.delete(peerKey)
      this._refillConnections()
    })

    socket.once('error', deferred.reject)
    socket.setTimeout(this._timeout, () => deferred.reject(new Error('Connection timeout')))
    socket.connect(peer.tcpPort, peer.address, deferred.resolve)

    await deferred.promise
    this._onConnect(socket, peer.id)
  }

  getPeers() {
    return Array.from(this._peers.values()).filter((item) => item instanceof Peer)
  }

  disconnect(id: Uint8Array) {
    const peer = this._peers.get(bytesToUnprefixedHex(id))
    if (peer instanceof Peer) {
      peer.disconnect(DISCONNECT_REASON.CLIENT_QUITTING)
    }
  }

  _isAlive() {
    return this._server !== null
  }

  _isAliveCheck() {
    if (!this._isAlive()) throw new Error('Server already destroyed')
  }

  _getOpenSlots() {
    return Math.max(this._maxPeers - this._peers.size, 0)
  }

  _getOpenQueueSlots() {
    return this._maxPeers * 2 - this._peersQueue.length
  }

  _connectToPeer(peer: PeerInfo) {
    this.connect(peer).catch((err) => {
      if (this._dpt === null) return
      if (err.code === 'ECONNRESET' || (err.toString() as string).includes('Connection timeout')) {
        this._dpt.banPeer(peer, 300000) // 5 min * 60 * 1000
      }
    })
  }

  _onConnect(socket: net.Socket, peerId: Uint8Array | null) {
    this._debug(`connected to ${socket.remoteAddress}:${socket.remotePort}, handshake waiting..`)

    const peer: Peer = new Peer({
      socket,
      remoteId: peerId!,
      privateKey: this._privateKey,
      id: this.id,
      timeout: this._timeout,
      clientId: this.clientId,
      remoteClientIdFilter: this._remoteClientIdFilter,
      capabilities: this._capabilities,
      common: this._common,
      port: this._listenPort!,
    })
    peer.events.on('error', (err) => this.events.emit('peer:error', peer, err))

    // handle incoming connection
    if (peerId === null && this._getOpenSlots() === 0) {
      peer.events.once('connect', () => peer.disconnect(DISCONNECT_REASON.TOO_MANY_PEERS))
      socket.once('error', () => {})
      return
    }

    peer.events.once('connect', () => {
      let msg = `handshake with ${socket.remoteAddress}:${socket.remotePort} was successful`

      if (peer['_eciesSession']['_gotEIP8Auth'] === true) {
        msg += ` (peer eip8 auth)`
      }

      if (peer['_eciesSession']['_gotEIP8Ack'] === true) {
        msg += ` (peer eip8 ack)`
      }
      this._debug(msg)
      const id = peer.getId()
      if (id && equalsBytes(id, this.id)) {
        return peer.disconnect(DISCONNECT_REASON.SAME_IDENTITY)
      }

      const peerKey = bytesToUnprefixedHex(id!)
      const item = this._peers.get(peerKey)
      if (item && item instanceof Peer) {
        return peer.disconnect(DISCONNECT_REASON.ALREADY_CONNECTED)
      }

      this._peers.set(peerKey, peer)
      this.events.emit('peer:added', peer)
    })

    peer.events.once('close', (reason, disconnectWe) => {
      if (disconnectWe === true) {
        this._debug(
          `disconnect from ${socket.remoteAddress}:${socket.remotePort}, reason: ${DISCONNECT_REASON[reason]}`,
          `disconnect`
        )
      }

      if (disconnectWe !== true && reason === DISCONNECT_REASON.TOO_MANY_PEERS) {
        // hack
        if (this._getOpenQueueSlots() > 0) {
          this._peersQueue.push({
            peer: {
              id: peer.getId()!,
              // @ts-ignore
              address: peer._socket.remoteAddress,
              // @ts-ignore
              tcpPort: peer._socket.remotePort,
            },
            ts: (Date.now() + 300000) as number, // 5 min * 60 * 1000
          })
        }
      }

      const id = peer.getId()
      if (id) {
        const peerKey = bytesToUnprefixedHex(id)
        this._peers.delete(peerKey)
        this.events.emit('peer:removed', peer, reason, disconnectWe)
      }
    })
  }

  _refillConnections() {
    if (!this._isAlive()) return
    if (this._refillIntervalSelectionCounter === 0) {
      this._debug(
        `Restart connection refill .. with selector ${
          this._refillIntervalSelectionCounter
        } peers: ${this._peers.size}, queue size: ${
          this._peersQueue.length
        }, open slots: ${this._getOpenSlots()}`
      )
    }
    // Rotating selection counter going in loop from 0..9
    this._refillIntervalSelectionCounter = (this._refillIntervalSelectionCounter + 1) % 10

    this._peersQueue = this._peersQueue.filter((item) => {
      if (this._getOpenSlots() === 0) return true
      if (item.ts > Date.now()) return true

      // Randomly distributed selector based on peer ID
      // to decide on subdivided execution
      const selector = bytesToInt((item.peer.id! as Uint8Array).subarray(0, 1)) % 10
      if (selector === this._refillIntervalSelectionCounter) {
        this._connectToPeer(item.peer)
        return false
      } else {
        // Still keep peer in queue
        return true
      }
    })
  }
}
