# Code Map for /src/modules/session-key

## Responsibility

Centralized runtime policy gate for **session-key (agent-key) execution** — the
`session_key` execution mode used by API-key-driven signing and transaction sending.
Before any operation proceeds, `SessionKeyPolicyService` verifies that the wallet's
agent key is actually usable **on-chain** (Calibur EIP-7702 delegation, registration,
settings), detects policy drift between backend API-key constraints and what Calibur
enforces on-chain, checks expiration alignment between the API key and the on-chain key,
and records every decision as a security event. It also generates the calldata needed to
revoke an agent key on-chain.

This is the enforcement counterpart to the Calibur helpers in
`src/common/calibur/`: that folder owns the *how* (ABI encoding, on-chain reads), this
module owns the *policy* (should this API-key operation be allowed?).

## Design/Patterns

- **Single service + thin module.** `SessionKeyModule` provides and exports only
  `SessionKeyPolicyService`; it imports `SecurityEventModule` for telemetry.
- **Fail-closed on-chain verification.** `verifyOnChainKeyStatus` wraps all RPC reads in
  try/catch and throws `ServiceUnavailableException` on any error — if the key's on-chain
  status cannot be confirmed, the operation is blocked (prevents use of revoked keys when
  RPC is unavailable).
- **Defense in depth.** Generic transaction contract calls are authorized by the DeFi
  capability policy before session-key submission. Calibur checks delegation and key
  usability; it does not substitute for backend capability authorization.
- **Expiration alignment check.** If the on-chain key expires before the API key, on-chain
  enforcement would stop working before the API key does; this is recorded as
  `session_key.expiration_mismatch` (allowed, but warned).
- **Optional telemetry dependency.** `SecurityEventService` is injected with `@Optional()`;
  `recordDecision` is a no-op when absent (keeps the service usable in isolation/tests).
- **Context object pattern.** Callers build a `SessionKeyPolicyContext` describing the
  operation; the service never queries the API key itself.
- **Event-type mapping.** `SESSION_KEY_EVENT_TYPES` maps internal reason codes
  (`session_key_policy_drift`, `session_key_expiration_mismatch`) to dotted event types;
  all other reasons fall through to `session_key.allowed` / `session_key.denied`.

## Flow

1. **Caller builds context.** `TransactionsService.sendTransaction` (operation
   `'send_transaction'`) constructs a `SessionKeyPolicyContext` from the API-key record
   (`expiresAt`) and wallet (`accountAddress`, `agentKeyHash`). Session-key API-key signing
   is unsupported; the separate narrowly scoped ClobAuth bootstrap uses EOA mode and does
   not reach this service.
2. **On-chain key status** (`verifyOnChainKeyStatus`):
   - `getSupportedChain(chainId)` → viem `createPublicClient` (default `http()` transport).
   - `hasCaliburDelegation` — account `code` must equal the EIP-7702 delegation designator
     + current or legacy Calibur address; else `not_delegated`.
   - `isCaliburKeyRegistered` — Calibur `isRegistered(keyHash)` view; else `not_registered`.
   - `getCaliburKeySettings` → `getAgentKeyUsabilityFailure`: key must be **non-admin**,
     **unexpired**, and have a **zero hook**; else the failure string is returned.
   - Any RPC error → `ServiceUnavailableException` (fail-closed).
3. **Deny path.** If not usable, `recordDecision('denied', 'session_key_<reason>')` is
   written and `ForbiddenException` is thrown — the operation never reaches signing or
   submission.
 4. **Allow path.** Expiration mismatch is recorded as an allowed event with warning
    metadata, then a final `session_key.allowed` event is recorded.
5. **Revocation.** `generateRevocationCalldata(keyHash)` encodes a Calibur
   `update(keyHash, settings)` call with `expiration: 0`, `isAdmin: false`,
   `hook: ZERO_ADDRESS`. The calldata is returned to the caller (the account owner) who
   must sign and submit it from their EOA — the backend never submits it.

## Permission Boundaries

- **Gate for `session_key` execution mode only.** The service is invoked exclusively when
  `executionMode === 'session_key'`; `eoa` mode uses `EoaExecutionPolicyService` instead.
- **On-chain truth wins.** A key must be delegated, registered, and usable on-chain
  regardless of backend state; backend-only restrictions cannot *add* on-chain capability.
- **Capability policy is authoritative for backend API calls.** Calibur usability
  checks are independent and do not confer contract-call permission.
- **Fail-closed, never fail-open.** RPC unavailability blocks the operation.
- **Telemetry actor is the API key.** All events are recorded with `actorType: 'api_key'`,
  `riskLevel: low` for allowed and `high` for denied, including `operation`, `chainId`,
  `walletId`, and `apiKeyPrefix` in metadata.

## Integration

- **Consumers:** `WalletModule` and `TransactionsModule` both import `SessionKeyModule`.
  `WalletService` and `TransactionsService` inject `SessionKeyPolicyService` as
  `@Optional()` and call `assertSessionKeyAllowed` before signing / transaction creation.
- **Dependencies:**
  - `SecurityEventService` (via `SecurityEventModule`) — decision telemetry.
  - `PrismaService` — injected but **currently unused** in this service's methods
    (retained for DI wiring).
  - `src/common/calibur/calibur.ts` — `hasCaliburDelegation`, `isCaliburKeyRegistered`,
    `getCaliburKeySettings`, `getAgentKeyUsabilityFailure`, `encodeUpdateKeySettings`,
    `ZERO_ADDRESS`.
  - `src/common/chains/supported-chains.ts` — `getSupportedChain` for the viem chain.
  - `viem` — `createPublicClient`, `http`, `Hex`.
- **Related execution path:** after this policy passes, transaction submission for
  `session_key` mode records `execution: 'calibur_agent_user_operation'` and uses the
  Calibur smart-account factory (`createCaliburSessionAccount`) in
  `src/core/openfort/openfort.service.ts`; wallet signing wraps the raw agent signature
  via `wrapCaliburSignature` in `WalletService`.
- **Tests:** `session-key-policy.service.spec.ts` (unit) covers all branches; the service
  is overridden/mocked in `wallet.service.spec.ts`, `transactions.service.spec.ts`, and
  `test/api-key-flow.e2e-spec.ts`.

### Key symbols

- `SessionKeyPolicyService` — `assertSessionKeyAllowed`, `verifyOnChainKeyStatus`,
  `detectPolicyDrift`, `generateRevocationCalldata`, private `recordDecision`.
- Types: `SessionKeyPolicyContext`, `OnChainKeyStatus`, `PolicyDriftAssessment`.
- `SessionKeyModule` — imports `SecurityEventModule`, exports `SessionKeyPolicyService`.
