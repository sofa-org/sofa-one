# Dashboard Pages

## Responsibility

Authenticated wallet, key, history, notification and billing screens use local SOFA application-session cookies/CSRF. Openfort hooks are confined to wallet operations; API keys are displayed for automation, never used to authenticate dashboard calls.

## File inventory

- `DashboardLayout.tsx` — shell with sidebar/mobile drawer, nav, unread-alert badge, sign-out.
- `Wallet.tsx` — the `/dashboard` index page; wallet setup, agent registration, balances, withdrawals.
- `ApiKeys.tsx` — `/dashboard/api-keys`; create/revoke/rotate keys, status filter, quick-start curl.
- `Transactions.tsx` — `/dashboard/transactions`; paginated transaction + signing-request history with detail drawer.
- `SecurityNotifications.tsx` — `/dashboard/notifications`; security alert list, mark read/all-read.
- `Billing.tsx` — `/dashboard/billing`; current plan, usage summary, cost estimate, invoices, Stripe checkout.
- `UsdcPaymentPanel.tsx` — inline USDC payment flow for an eligible invoice (quote → pay-from-wallet with step-up + status poll, or manual claim; BILL-003 user cancel of clean pending quotes only).
- `Docs.tsx` — `/dashboard/docs`; static public API reference (sign/send/status).
- `components/DashboardPage.tsx` — shared page header + card primitives.
- `Step1CreateEoa.tsx`, `Step2AuthorizeAccess.tsx` — wallet setup sub-forms (password entry; network/expiry/password + submit).
- `BalanceDisplay.tsx`, `WithdrawForm.tsx` — balances grid and withdrawal form with allowlist management.
- `ApiKeyBanner.tsx`, `AuthorizationBadges.tsx`, `SetupStatusBanner.tsx`, `WalletLoadingState.tsx`, `WalletIcons.tsx` — presentational helpers.
- `wallet-helpers.ts` — pure helpers + constants for wallet/agent flows (amount parsing, gas price RPC, chain storage, expiry formatting).
- `step-up.ts`, `step-up-session.ts` — TOTP step-up challenge and session-scoped proof token cache.
- `notification-events.ts` — tiny window-event bus so the layout badge refreshes when alerts change.

## Design/Patterns

- **Container pages with local state**: each page is a default-exported component holding its own fetch/loading/error state; no global store. Business effects use stable session IDs, not introspection snapshot objects; true session replacement remounts protected content. History requests use per-effect AbortControllers and guard every data/error/loading write, including ignored-abort responses.
- **Shared layout**: ProtectedRoute → server-authoritative DashboardStepUpGate → DashboardLayout; only index Wallet mounts AuthProviders/Wagmi/Shield. The shell wraps Outlet in content-level Suspense and a pathname-keyed inline ErrorBoundary, retaining nav/logout through child chunk loading/failures.
- **Cookie transports**: API helpers take business parameters directly, with credentials and in-memory CSRF managed by AppSessionProvider. No generic provider token accessors.
- **Step-up**: sensitive calls reuse only a proof for the current session or prompt for TOTP. Requests capture the originating session; delayed responses from replaced sessions cannot poison the new cache.
- **Controlled forms**: key creation, capability grants, withdrawal, and allowlist forms lift all field state to the page and pass setters down to presentational components.
- **Presentational split**: `Wallet.tsx` owns all logic; `Step1CreateEoa`/`Step2AuthorizeAccess`/`BalanceDisplay`/`WithdrawForm` are dumb props-driven components.
- **Stale-response guards**: request-id refs (`UsdcPaymentPanel`, `Billing.refreshInvoicesSilently`) and `isMountedRef` prevent out-of-order responses from clobbering state.
- **Local persistence**: chain selection (`sofa-one.wallet.balanceChainId`, `sofa-one.wallet.agentChainId`) and key status filter (`sofa-one.apiKeys.statusFilter`) in `localStorage`; step-up proof in `sessionStorage`.
- **One-time raw key display**: raw API keys are shown in an amber banner with a 2-minute auto-hide TTL (`RAW_KEY_NOTICE_TTL_MS`); never persisted.

## Flow

### Routing (`App.tsx`)

`/dashboard` (index → `WalletPage`), `api-keys`, `transactions`, `notifications`, `billing`, `docs` — all children of `DashboardLayout`. `DashboardStepUpGate` (in `src/components/`) enforces MFA before the layout mounts; it imports `step-up-session.ts` for proof handling.

### DashboardLayout

Sidebar/mobile layout uses AppSessionProvider, loads alerts with cookies and exposes current/all-device logout. Backend revocation completes before local state is cleared; all-device logout requires current-session step-up. No Openfort context dependency.

### Wallet (`/dashboard`)

1. Loads wallet projection with getMe using the application cookie; session introspection/exchange is separate and never silently repeated on wallet errors.
2. **Step 1 (no EOA)**: `Step1CreateEoa` collects a recovery password; `handleConnectWallet` creates an Openfort embedded EOA (`AccountTypeEnum.EOA`, `RecoveryMethod.PASSWORD`), retries `authorizeEmbeddedWallet` up to 5×, and refreshes embedded accounts.
3. **Step 2 (EOA exists)**: `Step2AuthorizeAccess` picks chain + expiry (≤30 days) + password. `handleRegisterAgent` verifies Calibur deployment on the chain, checks native gas (unless `VITE_OPENFORT_FEE_SPONSORSHIP_ID`), validates the agent key hash, builds `encodeRegisterKey` + `encodeUpdateKeySettings` self-calls, signs an EIP-7702 authorization via `use7702Authorization`, and submits a Calibur UserOp through Openfort (or Pimlico on Monad) bundler. Then `markAgentRegistrationTransaction` + `confirmAgentRegistration` poll the receipt and `markAgentRegistrationResult` (retrying on `AGENT_REGISTRATION_PENDING`).
   The identity panel labels the stable user wallet **Wallet Address** and the TEE EOA **Signer Address**, consuming `signerAddress` without a legacy alias. EIP-7702/TEE helper text does not imply authorization; the existing per-chain status/expiry badges remain separate evidence.
4. **Balances**: `getBalancesAuth` per selected chain; refresh nonce + retry button.
5. **Withdraw**: `WithdrawForm` manages the allowlist (`listWithdrawalAddressesAuth`/`addWithdrawalAddressAuth`/`removeWithdrawalAddressAuth`, each step-up gated) and submits `withdrawAuth` with parsed base units (`parseWithdrawalAmount`).

### ApiKeys (`/dashboard/api-keys`)

Lists keys (sorted: active by soonest expiry then last-used; revoked by newest), filters by status, enforces the 10-active-key cap, and loads the user's wallet list for binding labels. Create requires a wallet selection (preselected for a single wallet); each key's wallet binding is immutable. The list shows the bound wallet address/label, and unbound legacy keys as revoked/unbound with no rebind action. Create sends wallet ID, capability mode and configured IDs, spend limits, and permission checkboxes; shows the raw key once. `all` dynamically allows active, unpaused reviewed capabilities; `custom` allows exact IDs and `[]` denies all. Neither bypasses independent permissions or policies. Capability selection uses `GET /defi-capabilities`; inactive/paused capabilities cannot be newly granted, while existing grants can be removed. Cards show configured mode/IDs, not expanded effective IDs. Per-key edits call step-up-protected `PATCH /api-keys/:id/capabilities` with full replacement; `{capabilityMode: "all"}` resets, custom requires IDs, IDs-only remains custom, and `{}` is invalid. Revoke (per-key), rotate-all (`refreshApiKey` with a required replacement-wallet ID and warning that all keys across wallets are revoked), and emergency revoke-all are confirm-gated and step-up gated. Includes a backend-only curl quick start.
`canUseEoaExecution` keeps its API field name; its checkbox and list badge describe restricted EOA typed-data signing, requiring `canSign`, an approved capability and independent safety controls, never direct signer transaction sending.

### Transactions (`/dashboard/transactions`)

Two tabs: transactions (`listTransactionsAuth`) and signing requests (`listSigningRequestsAuth`), each with status/type/chain filters, 20-per-page pagination, and refresh. Every list request is cancelled and its data/error/loading writes invalidated on filter/page/refresh/tab/session changes and unmount. Semantic per-row View details buttons open a portalled native modal dialog; showModal supplies background isolation/focus containment, the close button receives focus, and close/Escape/backdrop/unmount restores the connected opener and body scroll. Detail requests retain cancellation and retry.
Historical detail addresses are labeled execution/recorded signing addresses and shown unchanged from persisted `walletAddress`, not projected from the current wallet.
`Transactions.test.tsx` covers out-of-order success/error/loading, filter/page/refresh ownership, abort on tab/unmount, same-session versus replacement-session reloads and semantic detail activation/focus restoration with jsdom dialog shims. `DashboardLayout.test.tsx` exercises lazy suspension/rejection with real shell navigation/logout; browser smoke must additionally exercise native Tab/Escape/inert behavior.

### SecurityNotifications (`/dashboard/notifications`)

Fetches `listSecurityNotificationsAuth`, sorts newest-first, renders risk badges and humanized metadata details. Mark-read and mark-all-read call the API then optimistically update local state and fire `notifySecurityNotificationsChanged()` so the layout badge updates.

### Billing (`/dashboard/billing`)

Loads plans, period-scoped usage summary, and invoices in parallel. Period picker (UTC month) refetches the summary. Stripe card checkout: `createBillingCheckoutSessionAuth` → redirect to `checkoutUrl`; `?success`/`?canceled` search params render a notice then are stripped. USDC payment opens `UsdcPaymentPanel` inline; a silent invoice refresh (`refreshInvoicesSilently`, abort + request-id guarded) runs after claims and the panel auto-closes once the invoice is paid. Payability is gated client-side (`isInvoicePayableByCard`/`isInvoicePayableByUsdc`) with the backend as final authority. **BILL-003**: card stays locked while an active USDC rail/reservation exists; invoice-list banner offers **Cancel quote** only for clean pending (unreserved) USDC attempts via `cancelUsdcQuoteAuth` (confirm + loading + 409 refresh); confirming/reserved/review never show cancel.

### UsdcPaymentPanel

Selects Base/Ethereum mainnet/Sepolia, fetches a quote (`createUsdcQuoteAuth`), and displays **server-derived** quote facts only (exact amount/base units, token contract, chain, expected payer, treasury, expiry with 5-minute safety warning). Primary action is user-triggered **Pay from wallet** (`payUsdcFromWalletAuth` with `X-Step-Up-Token` via existing `requestStepUpToken` / session proof) — body is `paymentAttemptId` only; never auto-submits. Status is restored and polled via `getUsdcPaymentStatusAuth` (no step-up). Phases distinguish accepted/submitting, confirming, unknown/manual review, failed, and paid — **`paid: true` alone** settles the UI; accepted/hash/202-shaped responses never imply invoice paid. Duplicate pay/claim are locked while reserved/submitting/unknown/confirming. **Fail-closed recovery (B5)**: status restore/check failure or ambiguous pay POST (network/timeout/5xx) enters local recovery — keeps pay/manual claim locked, shows status-unconfirmed copy, allows only Check status; successful authoritative status clears recovery; quote refresh must not unlock a second payment. Secondary path keeps manual tx-hash claim (`createUsdcClaimAuth`). **BILL-003 Cancel quote**: only for clean pending (unreserved, evidence-free) attempts — shown on idle quote and continue-entry pending; hidden for confirming/reserved/recovery/review/terminal. Confirm dialog, loading lock, anti double-submit; success clears local quote and refreshes invoice payment status; 409 `USDC_CANCEL_NOT_ALLOWED` (and related) shows safe conflict copy and refreshes status without inventing cancel success. Safe error mapping covers expiry-too-soon, usage-debt, cooldown/allowlist, cancel-not-allowed, frozen/origin/step-up failures without provider IDs or calldata.

### Docs (`/dashboard/docs`)

Static reference for the three documented automation endpoints (`/v1/wallets/sign`, `/v1/transactions`, `/v1/transactions/:id`): field tables, EOA-only approved typed-data signing examples, session-key-only Calibur UserOperation sending (omission allowed; explicit EOA/unknown mode is HTTP 400 without conversion), supported networks from `SUPPORTED_CHAINS`, and error-format notes. Wallet/signer identity notes document the breaking `signerAddress` response cutover and distinguish unchanged historical execution addresses, including historical EOA signer addresses. Base URL comes from `getApiBaseUrlForDisplay`/`getApiBaseUrlModeLabel` (Vite proxy vs `VITE_API_URL`).

## Integration

- **Routing**: mounted by `frontend/src/App.tsx` under `/dashboard` (lazy imports); guarded by `ProtectedRoute` and `DashboardStepUpGate`; `DashboardLayout` provides the `<Outlet />`.
- **Auth**: AppSessionProvider for SOFA identity/MFA; Openfort useUser/useOpenfort/useEthereumEmbeddedWallet/use7702Authorization only in Wallet. Wallet identity can reconnect without replacing the app session.
- **API layer**: `@/lib/api` — all `*Auth` helpers (wallet, keys, notifications, transactions, billing, USDC, TOTP), `getApiErrorMessage`/`hasApiErrorCode`/`isApiError`, `DEFAULT_CHAIN_ID`, and response types.
- **Chains**: `@/lib/chains` — `SUPPORTED_CHAINS`, explorer/gas-help URL builders, `getNativeCurrencySymbol`, `isMonadChain`.
- **Calibur**: `src/common/calibur/calibur-primitives.ts` (direct relative import) — shared `CALIBUR_ADDRESSES`, `CALIBUR_DELEGATION_CODES`, `KeyType`, `CaliburKey`, `hashKey`, registry encoders; `@/lib/calibur` — browser-only `encodeSelfCall`, `createCaliburAccount`; `@/lib/calibur-deployment` resolves the chain's implementation.
- **Wallet stack**: `viem` (public client, `padHex`, `zeroAddress`), `viem/account-abstraction` (bundler/paymaster clients), `wagmi` (`usePublicClient`).
- **Shared UI**: `@/components/CopyButton`; `DashboardStepUpGate` (in `src/components/`) consumes `step-up-session.ts`.
- **Env**: `VITE_OPENFORT_PUBLISHABLE_KEY`, `VITE_OPENFORT_FEE_SPONSORSHIP_ID`, `VITE_PIMLICO_API_KEY`/`VITE_PIMLICO_RPC_URL_<chainId>`.
- **Cross-page coupling**: `notification-events.ts` keeps the layout badge and the notifications page in sync; `step-up-session.ts` is shared by Wallet, ApiKeys, and `DashboardStepUpGate`.

## Security notes

- Private keys never leave Openfort; the dashboard only handles the recovery password (browser-local, never stored/returned) and signs via the embedded wallet.
- Raw API keys are shown once with a 2-minute TTL and are never persisted; docs and quick-start emphasize backend-only storage.
- Guarded mutations require exact-session TOTP step-up proofs. Cookie replacement/logout/expiry clears cache; provider identity mismatch never upgrades or replaces SOFA identity.
- Withdrawals enforce an allowlist + cooldown policy; recipient inputs validate `^0x[a-fA-F0-9]{40}$`.
- Public status responses (Docs) intentionally omit calldata/request hashes.
