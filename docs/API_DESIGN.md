# API design and compatibility

## Versioning and compatibility

Public API-key/resource APIs use `/v1`. IAM onboarding and session routes are intentionally
unversioned under `/auth` because frontend and backend are upgraded together. `/health/*`
deliberately remains unversioned for operational probes. MFA is unversioned at
`/auth/mfa/*`, like other IAM dashboard routes; the former `/v1/auth/mfa/*` paths have been
removed. Do not infer route audience from resource names.
Use only the canonical routes: `POST /v1/transactions`, `POST /wallets/withdrawals`,
and `GET /wallets/deposits?chainId=...&walletId=...`. The previous `/send`, `/withdraw`,
and POST deposit-info duplicates are removed.
`GET /v1/wallets` returns only the current API key's bound wallet, not all wallets of its
owner. The former `/v1/me/wallets` route is removed. Session synchronization uses only
`POST /auth/session`; key rotation uses only `POST /api-keys/rotations`, not an auth route.
Dashboard IAM routes (wallets, transaction history, API-key management, billing, and
notifications) are unversioned; public API-key routes such as `/v1/wallets/sign` and
`/v1/transactions` remain versioned. Do not infer route audience from a shared resource name.

Wallet identity responses have a breaking terminology/semantics cutover: wallet projections
and signing responses expose `signerAddress`, not the former `agentWalletAddress` JSON property;
no compatibility alias is returned. In these responses, `walletAddress` always identifies
the selected user wallet (unchanged by EIP-7702), and `signerAddress` identifies its
TEE-managed EOA. EOA signing responses no longer duplicate the signer in `walletAddress`;
clients doing signature recovery must switch to `signerAddress`. Public signing remains
EOA-only. Signer presence is not authorization; per-chain status/expiry and existing live
policy checks remain independent. Persisted transaction/status and signing-request history
`walletAddress` fields keep their recorded execution/signing address and are not migrated
or reinterpreted by this response-only change. Prisma/internal agent field names are unchanged.

## Audience and authentication

Public automation routes use API keys only. Dashboard routes use Openfort IAM bearer tokens
and additionally apply frontend-origin protections where specified. `Origin` and `Referer`
checks are defense-in-depth/CSRF protections, **not authentication**; they never substitute
for valid IAM identity. Keep IAM management/history representations separate from
API-key submission/status routes.

The frontend's development `/api` base is a Vite proxy prefix stripped before forwarding
to the backend. It is not part of the backend route: `/api/auth/...` becomes `/auth/...`,
and `/api/v1/...` becomes `/v1/...`.

## Resource and command conventions

Use resource-shaped paths for transaction creation and reads. Security-sensitive actions
such as API-key rotation remain explicit POST commands (`/api-keys/rotations`); their
effects are intentionally documented rather than inferred from a REST verb. Rotation
revokes **all active API keys belonging to the user across wallets**, then returns one
replacement bound to the requested owned wallet.

## Status and retry behavior

Successful signing returns 200; transaction resource creation uses 201; asynchronous
wallet payment acceptance uses 202; read-only GET routes use 200. Clients must generate an
idempotency key once per logical operation and reuse that exact key and payload on retries.
`withdrawAuth` generates a fresh key by default for each helper invocation; callers
implementing retries across invocations must pass and retain the optional `idempotencyKey`
argument. A fresh helper call without that argument can submit a second operation; the helper
does not own the caller's retry lifecycle.

Transaction history uses bounded page/limit pagination (up to 100) with a total count.
Security notifications are a recent/latest feed, not a paginated history contract. Do not
assume that the notification feed exposes every historical event.
