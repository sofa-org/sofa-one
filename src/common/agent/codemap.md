# src/common/agent/

## Responsibility
Defines the canonical set of agent-registration statuses for a wallet's per-chain authorization. This folder is a single-source-of-truth constants/type module: it enumerates the lifecycle states a `WalletChainAuthorization` row can be in as the backend registers an Openfort agent key on a chain. It holds no logic, services, or persistence — only the shared status vocabulary and its derived TypeScript type.

## Design / Patterns
- **Single file, single concern**: `agent-status.ts` exports one frozen constant object (`as const`) plus a derived union type. No classes, no runtime behavior, no dependencies.
- **String-enum via `as const`**: `AgentStatus` is a plain object of string literals, giving compile-time literal types while remaining plain runtime strings that map directly to the `status` column (`VARCHAR(30)`) of `WalletChainAuthorization`.
- **Derived union type**: `AgentStatusValue` is computed from the constant object (`(typeof AgentStatus)[keyof typeof AgentStatus]`), so the type can never drift from the runtime values.
- **Status vocabulary** (5 states):
  - `RegistrationRequired` (`'registration_required'`) — chain authorization exists but no agent registration tx has been submitted.
  - `PendingRegistration` (`'pending_registration'`) — registration tx hash recorded, awaiting on-chain confirmation.
  - `Registered` (`'registered'`) — agent key verified on-chain; the only status that authorizes signing/transaction API access.
  - `RegistrationFailed` (`'registration_failed'`) — on-chain registration reported/verified as failed.
  - `Expired` (`'expired'`) — reserved terminal state for expired authorizations (expiry is also enforced by `expiresAt`).

## Flow
- **Provisioning** (`AuthService`): when a wallet is created/updated with a `chainId` + `expiresAt`, a `WalletChainAuthorization` row is upserted with `status = AgentStatus.RegistrationRequired`.
- **Submission** (`AuthService.markAgentRegistrationTransaction`): after the client submits the registration tx, the row transitions to `AgentStatus.PendingRegistration` and stores `registrationTxHash`.
- **Confirmation** (`AuthService.markAgentRegistrationResult`): on reported `'registered'`, the service calls `OpenfortService.verifyAgentKeyRegistration` (account address + chainId + `agentKeyHash`); only on successful verification does it set `AgentStatus.Registered`. Any other report (or failed verification) sets `AgentStatus.RegistrationFailed`.
- **Consumption** (`WalletService`, `TransactionsService`): before signing or sending, `assertChainAuthorizationReady` requires `authorization.status === AgentStatus.Registered` and a non-expired `expiresAt`; otherwise the request is rejected (`BadRequestException`).

## Integration
- **Consumers** (import `AgentStatus` from `../../common/agent/agent-status`):
  - `src/modules/auth/auth.service.ts` — writes and transitions the status during the agent-registration lifecycle; also imports `AgentStatusValue` for the local status variable.
  - `src/modules/wallet/wallet.service.ts` — `assertChainAuthorizationReady` gates signing/withdraw/balance operations on `AgentStatus.Registered`.
  - `src/modules/transactions/transactions.service.ts` — `assertChainAuthorizationReady` gates transaction submission on `AgentStatus.Registered`.
- **Persistence**: values are stored in `WalletChainAuthorization.status` (`prisma/schema.prisma`, `@@map("wallet_chain_authorizations")`, `VARCHAR(30)`), keyed by composite `(walletId, chainId)`.
- **No external dependencies**: the module imports nothing and is imported only by the modules above.
