[@ethereumjs/evm](../README.md) / EVMResult

# Interface: EVMResult

Result of executing a message via the EVM.

## Table of contents

### Properties

- [createdAddress](EVMResult.md#createdaddress)
- [execResult](EVMResult.md#execresult)

## Properties

### createdAddress

• `Optional` **createdAddress**: `Address`

Address of created account during transaction, if any

#### Defined in

[types.ts:276](https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/evm/src/types.ts#L276)

___

### execResult

• **execResult**: [`ExecResult`](ExecResult.md)

Contains the results from running the code, if any, as described in runCode

#### Defined in

[types.ts:280](https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/evm/src/types.ts#L280)
