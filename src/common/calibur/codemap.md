# src/common/calibur/

## Responsibility

Pure, framework-agnostic helpers for interacting with the **Calibur** smart-contract
account (EIP-7702 delegated EOA) used for server-side session-key signing. This folder
owns all Calibur-specific ABI encoding, key hashing/settings packing, on-chain status
queries, and the construction of a viem "smart account" that signs UserOperations with a
backend agent key. It contains no NestJS services, DI, or HTTP logic — it is a leaf
library consumed by services elsewhere in the backend.

Key job: translate between the backend's notion of an "agent key" (a Calibur session key
owned by an Openfort TEE-managed wallet) and the on-chain Calibur contract + ERC-4337
EntryPoint v0.8 representation.

## Design / Patterns

- **Single file, pure functions + one factory.** `calibur.ts` exports constants, types,
  pure encoding/decoding helpers, async on-chain readers, and a single smart-account
  factory. No classes, no state.
- **EIP-7702 delegation.** An EOA is "Calibur-enabled" when its `code` equals
  `0xef0100 <caliburAddress>` (the EIP-7702 delegation designator + implementation
  address). Two supported deployments: current `CALIBUR_ADDRESS` and `LEGACY_CALIBUR_ADDRESS`
  (fallback for chains not yet migrated).
- **Key identity = `keyHash`.** A Calibur key is identified by `keccak256(abi.encode(keyType, keccak256(publicKey)))`
  (`hashKey`). The backend stores this hash (`agentKeyHash`) rather than the raw public key.
- **Packed settings bitfield.** `CaliburKeySettings { isAdmin, expiration, hook }` is
  packed into a single `uint256`: bits `[0,160)` = hook address, `[160,200)` = expiration
  (40-bit unix seconds), bit `200` = isAdmin. `packSettings`/`unpackSettings` are exact
  inverses.
- **Agent-key usability policy** (`getAgentKeyUsabilityFailure`): a usable agent key must
  be non-admin, unexpired, and have a zero hook. Returns a human-readable failure string
  or `null` when usable.
- **Smart-account factory** (`createCaliburSessionAccount`) wraps viem's `toSmartAccount`
  against EntryPoint v0.8, delegating all signing to the provided `signer` (an Openfort
  backend account). UserOp signatures are ABI-encoded as
  `(bytes32 keyHash, bytes signature, bytes authData)`; the `signature` field is a
  normalized EIP-2098 `serializeSignature` of the signer's typed-data signature.
- **Calibur-specific call encoding.** `encodeCaliburExecuteUserOpCalls` prepends the
  `executeUserOp` selector `0x8dd7712f` to `abi.encode((Call[], bool))` because Calibur's
  EntryPoint path decodes `userOp.callData` (minus the 4-byte selector) as
  `BatchedCall({ calls, revertOnFailure })` — distinct from the public direct `execute(...)`
  ABI used for browser self-registration.

## Flow

1. **Delegation check** — `hasCaliburDelegation(client, account)` reads account `code`
   via `getCode` and compares against both delegation codes.
2. **Registration check** — `isCaliburKeyRegistered(client, account, keyHash)` calls the
   Calibur `isRegistered(bytes32)` view.
3. **Settings read** — `getCaliburKeySettings(client, account, keyHash)` calls
   `getKeySettings(bytes32)` and `unpackSettings` the returned `uint256`.
4. **Usability decision** — `getAgentKeyUsabilityFailure(settings)` decides whether the
   key may be used for agent operations.
5. **UserOp submission** — `createCaliburSessionAccount` produces a smart account whose
   `encodeCalls` → `encodeCaliburExecuteUserOpCalls`, `getNonce` reads EntryPoint v0.8,
   `getStubSignature`/`signUserOperation` build the `(keyHash, signature, authData)` blob,
   and `sign*` delegate to the Openfort signer.

## Integration

- **`src/core/openfort/openfort.service.ts`** — primary consumer. Imports
  `CALIBUR_ADDRESSES`, `createCaliburSessionAccount`, `getCaliburKeySettings`,
  `hasCaliburDelegation`, `isCaliburKeyRegistered`. Uses `hasCaliburDelegation` +
  `isCaliburKeyRegistered` + `getCaliburKeySettings` to validate the agent key before
  signing (`assertCaliburContractAvailable` checks `CALIBUR_ADDRESSES` for deployment),
  and `createCaliburSessionAccount` in `sendUserOperation` to submit UserOps with the
  backend agent key.
- **`src/modules/session-key/session-key-policy.service.ts`** — imports
  `hasCaliburDelegation`, `isCaliburKeyRegistered`, `getCaliburKeySettings`,
  `getAgentKeyUsabilityFailure`, `encodeUpdateKeySettings`, `ZERO_ADDRESS`. `verifyOnChainKeyStatus`
  runs the delegation → registration → settings → usability flow (fail-closed on RPC
  error); `generateRevocationCalldata` encodes a Calibur `update(keyHash, settings)` call
  with `expiration: 0` to revoke a key on-chain.
- **`src/modules/wallet/wallet.service.ts`** — `wrapCaliburSignature` wraps a raw agent
  signature into the Calibur `(keyHash, signature, authData)` ABI envelope for submission.
- **`src/modules/transactions/transactions.service.ts`** — records `execution:
  'calibur_agent_user_operation'` when a transaction is executed via a session key.
- **`src/modules/auth/auth.controller.ts`** — records the receipt result of the Calibur
  agent-key registration transaction.
- **`src/common/chains/supported-chains.ts`** — chain support is gated on Calibur
  deployment (chains without Calibur are rejected).
- **`src/modules/billing/...`** — references `calibur_agent_user_operation` execution mode
  in reconciliation.
- **Tests** — `calibur.spec.ts` (unit) plus mocks of this module in
  `session-key-policy.service.spec.ts` and `openfort.service.spec.ts`.

### Key symbols

- Constants: `CALIBUR_ADDRESS`, `LEGACY_CALIBUR_ADDRESS`, `CALIBUR_ADDRESSES`,
  `ENTRYPOINT_V08_ADDRESS`, `EIP7702_DELEGATION_PREFIX`, `ZERO_ADDRESS`, `STUB_SIGNATURE`.
- Types/enums: `KeyType` (P256=0, WebAuthnP256=1, Secp256k1=2), `CaliburKey`,
  `CaliburKeySettings`, `CaliburSessionAccountParams`.
- Pure helpers: `getCaliburDelegationCode`, `getCaliburDelegationCodes`, `hashKey`,
  `packSettings`, `unpackSettings`, `getAgentKeyUsabilityFailure`,
  `encodeUpdateKeySettings`, `encodeRegisterKey`, `encodeCaliburExecuteUserOpCalls`.
- Async on-chain readers: `hasCaliburDelegation`, `isCaliburKeyRegistered`,
  `getCaliburKeySettings`.
- Factory: `createCaliburSessionAccount`.
