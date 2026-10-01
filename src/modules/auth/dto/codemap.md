# Code Map for /src/modules/auth/dto

## Responsibility
Validated request-body shapes for the embedded-wallet authorization and Calibur agent-key registration endpoints of the auth module. These DTOs define the contract between the frontend dashboard and the `POST /auth/embedded-wallet/*` routes.

## Design/Patterns
- Plain NestJS DTO classes annotated with `class-validator` decorators; no inheritance or shared base class.
- Validation is enforced by the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`), so unknown fields 400 and values are coerced to declared types before reaching the controller.
- Strict input contracts: EVM address via `@IsEthereumAddress`, 32-byte hex tx hash via `@Matches(/^0x[a-fA-F0-9]{64}$/)`, positive chain id via `@IsInt() @Min(1)`, and a closed enum for registration status via `@IsIn([...])`.
- Optional fields (`embeddedOpenfortAccountId`, `chainId`, `agentExpiresAt`) are marked `@IsOptional()`; `agentExpiresAt` is validated as an ISO date string (`@IsDateString`).

## Flow
- `POST /auth/embedded-wallet/authorize` → body validated into `AuthorizeEmbeddedWalletDto` → `AuthService.authorizeEmbeddedWallet(openfortUserId, openfortAccessToken, dto)`:
  - `embeddedWalletAddress` is verified against the Openfort IAM session via `OpenfortService.authorizeEmbeddedAddress`.
  - `embeddedOpenfortAccountId` (optional) overrides the Openfort account id on the `UserWallet` upsert; otherwise the authorized account id is used.
  - `chainId` (optional) gates agent expiry validation (`agentExpiration(dto.agentExpiresAt)`) and agent-wallet provisioning.
  - `agentExpiresAt` (optional) bounds the backend agent key lifetime.
- `POST /auth/embedded-wallet/registration-transaction` → body validated into `AgentRegistrationTransactionDto` → fields destructured and passed to `AuthService.markAgentRegistrationTransaction(openfortUserId, chainId, txHash)`, which flips the `WalletChainAuthorization` status to `PendingRegistration` and stores `registrationTxHash`.
- `POST /auth/embedded-wallet/registration-result` → body validated into `AgentRegistrationResultDto` → fields destructured and passed to `AuthService.markAgentRegistrationResult(openfortUserId, chainId, status, txHash)`, which (for `registered`) verifies the agent key on-chain via Openfort before persisting the final `Registered`/`RegistrationFailed` status.

## Integration
- Consumed exclusively by `AuthController` (`src/modules/auth/auth.controller.ts`) as `@Body()` parameters on the three `POST /auth/embedded-wallet/*` routes, all guarded by `OpenfortAuthGuard` (Bearer Openfort IAM token) with route-level throttling.
- `AuthorizeEmbeddedWalletDto` is the only DTO passed whole into `AuthService` (`src/modules/auth/auth.service.ts`); the other two are destructured into primitive arguments at the controller boundary.
- No cross-module usage; the DTOs are internal to the auth module.
- Depends only on `class-validator`; validation behavior depends on the global `ValidationPipe` configured in `src/main.ts`.