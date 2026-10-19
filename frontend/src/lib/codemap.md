# Frontend Library (`frontend/src/lib/`)

## Responsibility
Browser-side API and blockchain helper layer for the SOFA ONE dashboard. Three modules:
- `api.ts` — typed HTTP client for the backend: two transport helpers (`authFetch` for Openfort IAM bearer tokens, `apiFetch` for explicit API keys), normalized error handling, and one wrapper function per backend route (auth, MFA/TOTP, API-key management, withdrawals, balances, security notifications, transaction/signing history, billing/USDC payments).
- `calibur.ts` — viem-based Calibur smart-account helpers: key hashing/settings packing, calldata encoders for the Calibur registry contract, and an EIP-7702-authorized EntryPoint v0.8 smart account factory.
- `chains.ts` — static supported-chain metadata (id, name, native symbol, explorer URLs, faucet URLs) plus lookup helpers.

## Design/Patterns

### `api.ts`
- **Two typed transports**: `authFetch<T>(path, getToken, options)` injects `Authorization: Bearer <token>` (token fetched lazily via injected `getToken` callback, never stored in this module); `apiFetch<T>(path, apiKey, options)` injects `X-API-Key`. Both default to `Content-Type: application/json`, merge caller headers last, throw `ApiError` on non-2xx, and parse JSON (204/empty body → `undefined`).
- **Base URL**: `API_BASE` = `VITE_API_URL` or `/api` (Vite proxy). Throws at module load in production builds if `VITE_API_URL` is unset. `getApiBaseUrlForDisplay()` and `getApiBaseUrlModeLabel()` expose the resolved base for the Docs page.
- **Normalized errors**: `ApiError` class carries `statusCode`, `code`, `details`, `requestId`, `path`; `friendlyErrorMessage()` maps known backend codes (`VALIDATION_ERROR`, `INVALID_API_KEY`, `IP_NOT_ALLOWED`, `IDEMPOTENCY_CONFLICT`, etc.) to human-readable text. Helpers `isApiError`, `hasApiErrorCode`, `getApiErrorMessage` for callers.
- **Wrapper convention**: one exported async function per route, named `*Auth` (bearer) or `*WithApiKey` (API key). Step-up-protected routes (`createApiKeyAuth`, `updateApiKeyCapabilitiesAuth`, `revokeApiKeyAuth`, `revokeAllApiKeysAuth`, `withdrawAuth`, withdrawal-address mutations, `payUsdcFromWalletAuth`) accept/send `X-Step-Up-Token`. The reviewed DeFi catalog comes from `listDefiCapabilitiesAuth`; key grants use `allowedCapabilityIds`.
- **Idempotency**: `withdrawAuth` defaults to a generated key per invocation and accepts an optional trailing caller-owned `idempotencyKey` for reuse across retry calls; callers own retry-key lifecycle.
- **Access-control split respected**: public API-key wrappers include `POST /v1/wallets/sign`, `POST /v1/transactions`, `GET /v1/transactions/:id`, and `GET /v1/wallets`; everything else is bearer-token dashboard-only.
- **Types**: all request/response DTOs are exported interfaces co-located with their wrappers (auth session, wallet info, balances, withdrawals, signing, transactions, API keys and capability catalog, MFA/TOTP, security notifications, billing, USDC claim status union).
- **Signing contract**: `SignRequest` only accepts approved Polymarket `typed_data` (`ClobAuth`, `TypedDataSign`, `Batch`) with optional EOA-only execution mode; omission defaults to EOA. `SignResponse` reports the EOA agent signer. This does not change transaction sending's default `session_key` mode.

### `calibur.ts`
- **Shared pure primitives**: imports `src/common/calibur/calibur-primitives.ts` directly for deployment constants, delegation codes, `KeyType`, `CaliburKey`, `CaliburKeySettings`, key hashing, settings packing and register/update/UserOp encoding. This leaf has no Nest, Prisma, provider signing or private-key dependency and is not re-exported through either account factory.
- **Browser-only helpers**: `encodeSelfCall` and direct `encodeExecute` compose the owner's registration calls.
- **EntryPoint v0.8 integration**: `createCaliburAccount` remains the browser owner-account factory with EIP-7702 authorization, root-key signature wrapping and viem typed-data signing. It uses the shared `encodeCaliburExecuteUserOpCalls` for selector + BatchedCall encoding; the backend session-account factory remains separate.

### `chains.ts`
- **Static registry**: `SUPPORTED_CHAINS` `as const` array of 14 chains (Base Sepolia 84532, Base 8453, Ethereum 1, Ethereum Sepolia 11155111, Polygon 137, Polygon Amoy 80002, Arbitrum One 42161, OP Mainnet 10, OP Sepolia 11155420, BNB 56, BNB Testnet 97, Monad 143, Monad Testnet 10143). Testnets carry an optional `gasHelpUrl` faucet link.
- **Lookup helpers**: `formatChainName`, `getExplorerAddressUrl`, `getExplorerTransactionUrl`, `getChainGasHelpUrl`, `getNativeCurrencySymbol`, `isMonadChain` (Monad chains use a different native-token/faucet flow).

## Flow
- **Auth session**: `syncSession` (`POST /auth/session`) and `getMe` (`GET /auth/me`) return `AuthSessionResponse` (`userId`, `wallet`, optional `apiKey`).
- **Wallet provisioning**: `authorizeEmbeddedWallet` (`POST /auth/embedded-wallet/authorize`) links an embedded wallet; `markAgentRegistrationResult` / `markAgentRegistrationTransaction` report Calibur agent-key registration outcomes.
- **API-key rotation**: `refreshApiKey` (`POST /api-keys/rotations`) requires `{ walletId }` and an `X-Step-Up-Token`; it revokes all of the user's active keys across wallets, then binds the replacement to that wallet.
- **MFA/TOTP**: `getMfaStatusAuth`, `setupTotpAuth`, `enableTotpAuth`, `verifyTotpAuth`, `disableTotpAuth` use unversioned `/auth/mfa/*`. Verify/enable return a `proofToken` used as the step-up token for sensitive mutations.
- **Dashboard data**: API-key CRUD (`/api-keys`), balances, deposit information via `GET /wallets/deposits`, withdrawals (`/wallets/withdrawals`) and withdrawal-address allowlist, security notifications, IAM transaction/signing-request history, billing and USDC payment.
- **Public API examples**: `signWithApiKey`, `sendTransactionWithApiKey`, `getTransactionStatusWithApiKey` — the only wrappers that use `apiFetch` with an explicit API key.
- **Calibur flow**: dashboard wallet setup uses shared pure register/update encoders with browser self-call/execute helpers and `createCaliburAccount` to obtain the owner account for Openfort submission.

## Integration
- `api.ts` is consumed by dashboard pages (`Wallet`, `ApiKeys`, `Transactions`, `Billing`, `SecurityNotifications`, `DashboardLayout`, `WithdrawForm`, `BalanceDisplay`, `UsdcPaymentPanel`, `step-up.ts`, `wallet-helpers.ts`), shared components (`DashboardStepUpGate`, `AuthProviders`), and `Docs.tsx` (base-URL display). `getToken` callbacks come from the Openfort IAM provider; `DEFAULT_CHAIN_ID` (84532) is exported from `api.ts` and used across the dashboard.
- `chains.ts` is consumed by `Docs`, `Step2AuthorizeAccess`, `BalanceDisplay`, `WithdrawForm`, `Wallet`, and `wallet-helpers.ts` for chain labels, explorer links, faucet links, and Monad-specific behavior.
- `calibur.ts` is consumed by `Wallet.tsx` for agent-key registration and Calibur account creation.
- Depends on browser `fetch`, `crypto.randomUUID`, viem and Vite env (`VITE_API_URL`). The sole backend-tree import is the browser-safe Calibur primitive leaf; runtime backend services remain separated by HTTP + typed DTOs. Vite/Vitest deduplicate viem and frontend TypeScript resolves that leaf against the frontend package's own viem dependency.
