# Frontend Library (`frontend/src/lib/`)

## Responsibility
Browser-side API and blockchain helper layer for the SOFA ONE dashboard. Three modules:
- `api.ts` — typed cookie/CSRF dashboard transport and explicit API-key transport, normalized errors, per-route wrappers. Bearer identity is explicit only for login exchange and embedded-wallet authorization.
- `calibur.ts` — viem-based Calibur smart-account helpers: key hashing/settings packing, calldata encoders for the Calibur registry contract, and an EIP-7702-authorized EntryPoint v0.8 smart account factory.
- `chains.ts` — static supported-chain metadata (id, name, native symbol, explorer URLs, faucet URLs) plus lookup helpers.

## Design/Patterns

### `api.ts`
- **Two typed transports**: `authFetch(path,options)` includes HttpOnly cookies and injects current CSRF for unsafe methods; `apiFetch(path,apiKey,options)` injects X-API-Key for public examples. No dashboard getToken callbacks remain. Empty/204 responses return undefined.
- **Base URL**: `API_BASE` = `VITE_API_URL` or `/api` (Vite proxy). Throws at module load in production builds if `VITE_API_URL` is unset. `getApiBaseUrlForDisplay()` and `getApiBaseUrlModeLabel()` expose the resolved base for the Docs page.
- **Normalized errors**: `ApiError` class carries `statusCode`, `code`, `details`, `requestId`, `path`; `friendlyErrorMessage()` maps known backend codes (`VALIDATION_ERROR`, `INVALID_API_KEY`, `IP_NOT_ALLOWED`, `IDEMPOTENCY_CONFLICT`, etc.) to human-readable text. Helpers `isApiError`, `hasApiErrorCode`, `getApiErrorMessage` for callers.
- **Wrapper convention**: `*Auth` denotes application-session routes; `*WithApiKey` denotes public automation. Sensitive wrappers send X-Step-Up-Token. Provider-only AUTH_PROVIDER_INVALID does not invalidate a SOFA session; other business cookie401s do.
- **Idempotency**: `withdrawAuth` defaults to a generated key per invocation and accepts an optional trailing caller-owned `idempotencyKey` for reuse across retry calls; callers own retry-key lifecycle.
- **Access-control split**: public API-key wrappers retain explicit keys; dashboard requests never substitute IAM tokens or API keys for cookies.
- **Types**: all request/response DTOs are exported interfaces co-located with their wrappers (auth session, wallet info, balances, withdrawals, signing, transactions, API keys and capability catalog, MFA/TOTP, security notifications, billing, USDC claim status union).
- **Signing/identity contract**: `SignRequest` only accepts approved Polymarket `typed_data` (`ClobAuth`, `TypedDataSign`, `Batch`) with optional EOA-only execution mode; omission defaults to EOA. Wallet projections and `SignResponse` use `walletAddress` for the selected user wallet and `signerAddress` for the TEE EOA (no former agent-address alias). Signer presence does not establish chain authorization. Persisted transaction/status and signing-request audit `walletAddress` fields keep their recorded execution/signing address, including the signer for historical EOA transactions.
- **Transaction contract**: `SendTransactionRequest.executionMode` accepts only optional `session_key` (omission retains the default), for Calibur UserOperations from the authorized user wallet. Explicit legacy `eoa` and unknown modes return HTTP 400 without conversion or retry. `canUseEoaExecution` is retained for restricted approved EOA signing only, not direct transaction sends. API-route tests retain route/authentication boundaries and cover propagation of legacy EOA validation errors without fallback.

### `calibur.ts`
- **Shared pure primitives**: imports `src/common/calibur/calibur-primitives.ts` directly for deployment constants, delegation codes, `KeyType`, `CaliburKey`, `CaliburKeySettings`, key hashing, settings packing and register/update/UserOp encoding. This leaf has no Nest, Prisma, provider signing or private-key dependency and is not re-exported through either account factory.
- **Browser-only helpers**: `encodeSelfCall` and direct `encodeExecute` compose the owner's registration calls.
- **EntryPoint v0.8 integration**: `createCaliburAccount` remains the browser owner-account factory with EIP-7702 authorization, root-key signature wrapping and viem typed-data signing. It uses the shared `encodeCaliburExecuteUserOpCalls` for selector + BatchedCall encoding; the backend session-account factory remains separate.

### `chains.ts`
- **Static registry**: `SUPPORTED_CHAINS` `as const` array of 14 chains (Base Sepolia 84532, Base 8453, Ethereum 1, Ethereum Sepolia 11155111, Polygon 137, Polygon Amoy 80002, Arbitrum One 42161, OP Mainnet 10, OP Sepolia 11155420, BNB 56, BNB Testnet 97, Monad 143, Monad Testnet 10143). Testnets carry an optional `gasHelpUrl` faucet link.
- **Lookup helpers**: `formatChainName`, `getExplorerAddressUrl`, `getExplorerTransactionUrl`, `getChainGasHelpUrl`, `getNativeCurrencySymbol`, `isMonadChain` (Monad chains use a different native-token/faucet flow).

## Flow
- **App session**: exchangeAppSession/getAppSession return identity/MFA/CSRF snapshots; deleteAppSession/deleteAllAppSessions revoke current/all sessions. getMe remains a separate wallet projection.
- **Wallet provisioning**: authorizeEmbeddedWallet takes a fresh explicit provider bearer plus local cookie/CSRF; registration-result/transaction use only the application session.
- **API-key rotation**: `refreshApiKey` (`POST /api-keys/rotations`) requires `{ walletId }` and an `X-Step-Up-Token`; it revokes all of the user's active keys across wallets, then binds the replacement to that wallet.
- **MFA/TOTP**: enable returns recovery codes; verify returns a proof after atomic server-session upgrade. Cached proofs are scoped to the originating session.
- **Dashboard data**: key CRUD, wallet reads/withdrawals, notifications, history and billing use cookies/CSRF without Openfort token accessors.
- **Public API examples**: `signWithApiKey`, `sendTransactionWithApiKey`, `getTransactionStatusWithApiKey` — the only wrappers that use `apiFetch` with an explicit API key.
- **Calibur flow**: dashboard wallet setup uses shared pure register/update encoders with browser self-call/execute helpers and `createCaliburAccount` to obtain the owner account for Openfort submission.

## Integration
- api.ts is consumed by AppSessionProvider and dashboard/public-page helpers. DEFAULT_CHAIN_ID remains 84532. Openfort bearer acquisition exists only at explicit email exchange and wallet identity proof, not generic transport.
- `chains.ts` is consumed by `Docs`, `Step2AuthorizeAccess`, `BalanceDisplay`, `WithdrawForm`, `Wallet`, and `wallet-helpers.ts` for chain labels, explorer links, faucet links, and Monad-specific behavior.
- `calibur.ts` is consumed by `Wallet.tsx` for agent-key registration and Calibur account creation.
- Depends on browser `fetch`, `crypto.randomUUID`, viem and Vite env (`VITE_API_URL`). The sole backend-tree import is the browser-safe Calibur primitive leaf; runtime backend services remain separated by HTTP + typed DTOs. Vite/Vitest deduplicate viem and frontend TypeScript resolves that leaf against the frontend package's own viem dependency.
