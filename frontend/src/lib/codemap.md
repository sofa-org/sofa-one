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
- **Wrapper convention**: one exported async function per route, named `*Auth` (bearer) or `*WithApiKey` (API key). Step-up-protected routes (`createApiKeyAuth`, `revokeApiKeyAuth`, `revokeAllApiKeysAuth`, `withdrawAuth`, withdrawal-address mutations, `payUsdcFromWalletAuth`) accept an optional `stepUpToken` sent as `X-Step-Up-Token`. List endpoints build query strings with `URLSearchParams` and accept an optional `AbortSignal`.
- **Idempotency**: `withdrawAuth` generates `idempotencyKey: crypto.randomUUID()` per call.
- **Access-control split respected**: public API-key wrappers are limited to `POST /v1/wallets/sign`, `POST /v1/transactions/send`, `GET /v1/transactions/:id`; everything else is bearer-token dashboard-only.
- **Types**: all request/response DTOs are exported interfaces co-located with their wrappers (auth session, wallet info, balances, withdrawals, signing, transactions, API keys, MFA/TOTP, security notifications, billing, USDC claim status union).

### `calibur.ts`
- **Constants**: `CALIBUR_ADDRESS`, `LEGACY_CALIBUR_ADDRESS`, `CALIBUR_ADDRESSES`, `CALIBUR_DELEGATION_CODE`/`CALIBUR_DELEGATION_CODES` (`0xef0100` + address) for EIP-7702 delegation detection.
- **Pure encoders**: `hashKey` (keccak of `(keyType, keccak(publicKey))`), `packSettings` (bit-packed `isAdmin | expiration | hook` into a `uint256`), `encodeRegisterKey`, `encodeUpdateKeySettings`, `encodeSelfCall`, `encodeExecute` (batched `execute(calls, revertOnFailure=true)`).
- **EntryPoint v0.8 integration**: `createCaliburAccount` builds a `toSmartAccount` with `entryPoint08Abi`/`entryPoint08Address`, EIP-7702 authorization (`factory: '0x7702'`), `getUserOperationTypedData` signing, and a `ROOT_KEY` + stub-signature wrapper. `encodeExecuteUserOp` (private) emits the `0x8dd7712f` selector + ABI-encoded `BatchedCall` that EntryPoint v0.8 rewrites into `executeUserOp`. `normalizeSignature` (private) fixes low-`v` ECDSA signatures before serialization.
- **Key types**: `KeyType` enum (`P256`, `WebAuthnP256`, `Secp256k1`); `CaliburKey`, `KeySettings`, `CaliburCall` types.

### `chains.ts`
- **Static registry**: `SUPPORTED_CHAINS` `as const` array of 14 chains (Base Sepolia 84532, Base 8453, Ethereum 1, Ethereum Sepolia 11155111, Polygon 137, Polygon Amoy 80002, Arbitrum One 42161, OP Mainnet 10, OP Sepolia 11155420, BNB 56, BNB Testnet 97, Monad 143, Monad Testnet 10143). Testnets carry an optional `gasHelpUrl` faucet link.
- **Lookup helpers**: `formatChainName`, `getExplorerAddressUrl`, `getExplorerTransactionUrl`, `getChainGasHelpUrl`, `getNativeCurrencySymbol`, `isMonadChain` (Monad chains use a different native-token/faucet flow).

## Flow
- **Auth session**: `syncSession` (`POST /auth/session`) and `getMe` (`GET /auth/me`) return `AuthSessionResponse` (`userId`, `wallet`, optional `apiKey`). `socialLogin` is a deprecated alias of `syncSession`.
- **Wallet provisioning**: `authorizeEmbeddedWallet` (`POST /auth/embedded-wallet/authorize`) links an embedded wallet; `markAgentRegistrationResult` / `markAgentRegistrationTransaction` report Calibur agent-key registration outcomes.
- **API-key refresh**: `refreshApiKey` (`POST /auth/refresh-api-key`) requires an `X-Step-Up-Token`.
- **MFA/TOTP**: `getMfaStatusAuth`, `setupTotpAuth`, `enableTotpAuth`, `verifyTotpAuth`, `disableTotpAuth` under `/v1/auth/mfa/*`; verify/enable return a `proofToken` used as the step-up token for sensitive mutations.
- **Dashboard data**: API-key CRUD (`/v1/api-keys`), balances (`GET /v1/wallets/balances?chainId=`), withdrawals and withdrawal-address allowlist (`/v1/wallets/withdraw`, `/v1/wallets/withdrawal-addresses`), security notifications (`/v1/security-notifications` + read/mark-all), transaction and signing-request history/detail (`/v1/transactions`, `/v1/wallets/signing-requests`), billing (`/v1/billing/plans|summary|invoices`, checkout session, USDC quote/claim, quote-bound wallet pay `POST .../usdc/pay-from-wallet` + `GET .../usdc/payment-status`).
- **Public API examples**: `signWithApiKey`, `sendTransactionWithApiKey`, `getTransactionStatusWithApiKey` — the only wrappers that use `apiFetch` with an explicit API key.
- **Calibur flow**: dashboard wallet setup uses `calibur.ts` encoders to build `register`/`update`/`execute` calldata and `createCaliburAccount` to obtain a smart account whose user operations are signed by the owner account and submitted through Openfort.

## Integration
- `api.ts` is consumed by dashboard pages (`Wallet`, `ApiKeys`, `Transactions`, `Billing`, `SecurityNotifications`, `DashboardLayout`, `WithdrawForm`, `BalanceDisplay`, `UsdcPaymentPanel`, `step-up.ts`, `wallet-helpers.ts`), shared components (`DashboardStepUpGate`, `AuthProviders`), and `Docs.tsx` (base-URL display). `getToken` callbacks come from the Openfort IAM provider; `DEFAULT_CHAIN_ID` (84532) is exported from `api.ts` and used across the dashboard.
- `chains.ts` is consumed by `Docs`, `Step2AuthorizeAccess`, `BalanceDisplay`, `WithdrawForm`, `Wallet`, and `wallet-helpers.ts` for chain labels, explorer links, faucet links, and Monad-specific behavior.
- `calibur.ts` is consumed by `Wallet.tsx` for agent-key registration and Calibur account creation.
- Depends on browser `fetch`, `crypto.randomUUID`, viem (`viem`, `viem/account-abstraction`, `viem/actions`), and Vite env (`VITE_API_URL`). No backend imports; all contracts are HTTP + typed DTOs.