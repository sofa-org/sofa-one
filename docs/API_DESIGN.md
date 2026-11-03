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
`POST /auth/session`. Bulk key rotation is removed; replace a key through create, deploy/verify, then revoke.
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

Public automation routes use API keys only. Dashboard routes use MFA-verified SOFA
application-session cookies with Origin/CSRF protections. Openfort IAM bearer identity
is used only for login exchange and fresh wallet authorization. `Origin` and `Referer`
are defense-in-depth/CSRF protections, **not authentication**. Keep dashboard
management/history representations separate from API-key submission/status routes.

The frontend's development `/api` base is a Vite proxy prefix stripped before forwarding
to the backend. It is not part of the backend route: `/api/auth/...` becomes `/auth/...`,
and `/api/v1/...` becomes `/v1/...`.

## Resource and command conventions

Use resource-shaped paths for transaction creation and reads. API keys are created
individually and revoked individually after deployment cutover. Emergency
`DELETE /api-keys` revokes all keys without issuing a replacement; it is not a rolling
replacement workflow.

## Status and retry behavior

Successful signing returns 200; transaction resource creation uses 201; asynchronous
wallet payment acceptance uses 202; read-only GET routes use 200. Clients must generate an
idempotency key once per logical operation and reuse that exact key and payload on retries.
`withdrawAuth` generates a fresh key by default for each helper invocation; callers
implementing retries across invocations must pass and retain the optional `idempotencyKey`
argument. A fresh helper call without that argument can submit a second operation; the helper
does not own the caller's retry lifecycle.

The dashboard withdrawal caller persists its exact user/wallet/chain/payload/key intent
before sending. Resume preserves that identity across errors and reloads; a known
transaction ID is queried through dashboard detail instead of creating another send.
Pending/unknown outcomes block a new intent until a terminal result is observed.
Agent registration similarly reserves and retains its UserOperation identity for
receipt-only recovery; Retry check does not sign or broadcast another operation.
Registration checkpoint replays for the same owned wallet, chain and transaction hash
return the already-pending/terminal snapshot; a matching terminal result is also replayable.
These reads do not reset state or re-grant authority. Different hashes cannot replace an
in-flight/registered operation, contradictory terminal results are rejected, and ownership
and frozen-state checks still apply before replay acceptance.
If a submission response is lost before any hash is known, preserve the reservation
and use support recovery rather than guessing that the operation was not accepted.

Transaction history uses bounded page/limit pagination (up to 100) with a total count.
Security notifications are a recent/latest feed, not a paginated history contract. Do not
assume that the notification feed exposes every historical event.
