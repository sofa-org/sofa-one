# API Guide

`openapi.yaml` is the public machine-readable API specification. It intentionally documents only API-key endpoints. This file explains both public and dashboard-only route boundaries for maintainers.
See [`docs/API_DESIGN.md`](docs/API_DESIGN.md) for versioning, compatibility, status, and idempotent-retry conventions.

## 1. Authentication methods

### API-key clients

Use `X-API-Key`:

```http
X-API-Key: sk_<secret>
```

API keys are accepted only by public automation endpoints.

### Dashboard clients

Use browser-managed HttpOnly application-session cookies with `credentials: 'include'`.
`POST /auth/session` exchanges a fresh `Authorization: Bearer <openfort_iam_access_token>`
for a pending-MFA SOFA cookie and `{ sessionId, userId, email, mfaVerified, expiresAt, csrfToken }`.
`GET /auth/session` restores this snapshot without calling Openfort. There is no bearer
fallback on ordinary dashboard routes.

Unsafe cookie requests require both an allowed `Origin` and `X-CSRF-Token` from the current
snapshot. Safe GET/HEAD requests may use a trusted `Referer` when Origin is absent, including
production same-origin fetches. These headers are not authentication. Production uses
`__Host-sofa_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no Domain); development
uses `sofa_session`. SPA/API must be same-site; unrelated cross-site hosting is unsupported.

Every exchange starts pending MFA. Only introspection, current logout, MFA status, and
TOTP setup/enable/verify are available before verification. A pending session expires after
15 minutes; successful TOTP/recovery verification upgrades that exact session atomically
with proof issuance. Absolute expiry remains one hour from exchange, with no sliding renewal.
Openfort-side identity revocation is therefore bounded by that hour, not synchronized instantly.

## 2. Public API-key endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/wallets/sign` | API-key signing; exact Polymarket ClobAuth, capability-authorized CLOB V2 order, or verified DepositWallet Batch typed data |
| `POST` | `/v1/transactions` | Submit validated EVM interactions as Calibur session-key UserOperations from the user wallet |
| `GET` | `/v1/transactions/:id` | Return safe transaction status for the owning API-key user |
| `GET` | `/v1/permissions` | Return the key's configured permissions, capability mode/IDs, and constraints; configuration is not an execution guarantee |
| `GET` | `/v1/capabilities?ids=id1,id2` | Look up 1–100 catalog capability definitions; definitions do not grant capabilities |
| `GET` | `/v1/wallets` | List only the key owner's bound user wallet (`walletAddress`) and nullable TEE EOA signer (`signerAddress`), plus safe chain metadata (no balances or Openfort internal IDs) |

All public routes use `X-API-Key`; these three read routes require no `can*` permission. Existing API-key freeze, IP and billing guards still apply. For capability lookup, `ids` is required; comma-separated values are trimmed, non-empty, unique, and at most 256 characters each (query max 25,700 chars). Invalid input returns 400; unknown IDs are returned in `unknownIds` with 200, preserving request order. `all` mode dynamically includes catalog capabilities; `custom` with `[]` grants none. Wallet listing is owner-scoped, is not a balance or live on-chain check, and omits Openfort internal IDs. Do not accept Openfort IAM-only auth on these routes.

### Wallet and signer identity (breaking response change)

Public and dashboard wallet projections use `walletAddress` for the selected user's wallet
and `signerAddress` for its TEE-managed EOA signer (nullable when not configured).
EIP-7702 delegation to Calibur does not change the user's wallet address. A signer address
does not itself establish authorization: consult per-chain status/expiry metadata; execution
still enforces existing live authorization and independent policies.

**Breaking change:** `signerAddress` replaces the former JSON property `agentWalletAddress`
without an alias. Successful `POST /v1/wallets/sign` responses now return the selected user
wallet in `walletAddress` and the actual TEE signer in `signerAddress`; EOA signing no
longer duplicates the signer into `walletAddress`. Clients using the response for signature
recovery or Polymarket ClobAuth must use `signerAddress`. Public signing remains EOA-only;
this response change does not add session-key signing or change execution policies.

Transaction status/history and signing-request history are audit records, not current wallet
projections. Their persisted `walletAddress` fields retain the address recorded at execution
or signing: historical transaction EOA execution recorded the TEE signer, while session-key execution
records the user wallet. Historical signing rows retain their recorded signing address.
These fields are not renamed, backfilled, or reinterpreted as the current user's wallet.

## 3. Dashboard/frontend-only endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/session` | Exchange Openfort identity for a pending-MFA HttpOnly session |
| `GET` | `/auth/session` | Restore local session snapshot and CSRF token; pending allowed |
| `DELETE` | `/auth/session` | Revoke current session/proofs and clear cookie; pending allowed |
| `DELETE` | `/auth/sessions` | Revoke all user sessions/proofs; full MFA plus current-session step-up |
| `GET` | `/auth/me` | Return current user wallet/authorization state |
| `POST` | `/api-keys/rotations` | Revoke all active keys across the user and issue one replacement bound to selected wallet (step-up) |
| `POST` | `/auth/embedded-wallet/authorize` | Full local session plus fresh Openfort bearer whose subject matches the local user; bind proven embedded EOA |
| `POST` | `/auth/embedded-wallet/registration-transaction` | Persist submitted Calibur registration tx hash |
| `POST` | `/auth/embedded-wallet/registration-result` | Persist final registration status |
| `GET/POST` | `/auth/mfa/*` | Dashboard MFA/TOTP operations |
| `GET` | `/wallets/balances` | Return native token and USDC balances |
| `GET` | `/wallets/deposits?chainId=...&walletId=...` | Return wallet deposit address/context |
| `POST` | `/wallets/withdrawals` | Submit dashboard-authenticated withdrawal |
| `GET` | `/transactions` and `/transactions/:id/detail` | Dashboard transaction history/detail; distinct from versioned API-key routes |
| `GET` | `/api-keys` | List API-key metadata |
| `POST` | `/api-keys` | Create API key and return raw secret once |
| `POST` | `/api-keys/rotations` | Rotate all active keys for the user (step-up required) |
| `DELETE` | `/api-keys/:id` | Revoke API key |
| `GET` | `/defi-capabilities`, `/defi-capability-bundles` | List catalog DeFi capability metadata |
| `PATCH` | `/api-keys/:id/capabilities` | Replace the key's capability grants (step-up required) |
| `GET/POST` | `/security-notifications/*` | List and mark security notifications |
| `GET/POST` | `/billing/*` | Dashboard billing and invoice payment operations |

These routes must not be added to `openapi.yaml` unless the product intentionally exposes them as public API-key routes.

Session/MFA responses are `Cache-Control: no-store`. `MFA_REQUIRED` is a 403, not a lost login.
`AUTH_PROVIDER_INVALID` is a provider-only 401 and must not clear a valid SOFA session;
`AUTH_PROVIDER_UNAVAILABLE` is a 502. Other application-cookie 401s require sign-in again.
Step-up proofs expire after at most 15 minutes, are bound to the exact user/session, and are
invalidated on cookie replacement/logout. TOTP disable verifies the factor and revokes all sessions.

### Wallet-bound API keys

Each new API key is immutably bound to exactly one of its owner's wallets. A wallet may
have multiple keys; the existing maximum of 10 active keys is per user across all wallets.
Dashboard `POST /api-keys` creation requires `walletId` as a wallet UUID owned by the
authenticated user. The dashboard-only `POST /api-keys/rotations` likewise requires
`{ "walletId": "<wallet UUID>" }`: it revokes **all** of that user's active keys across
all wallets and creates one replacement bound to the selected wallet. It does not move or
rebind a surviving key. Both routes remain application-session/frontend-only and step-up protected.

Public `POST /v1/wallets/sign` and `POST /v1/transactions` always resolve the
execution wallet from the authenticated key's binding, not from caller selection. Send's
optional `walletId` is accepted only if it equals that binding; a different wallet is
rejected. Transaction status remains scoped to the key's bound wallet: another key bound
to that same wallet can read it, but a key bound to a different wallet cannot. Key
metadata exposes `walletId`; it is nullable only for legacy keys that the migration
revoked because their owner did not have exactly one wallet row (including non-active
rows). Legacy keys are never rebound in place.

API-key capability configuration has `capabilityMode: "all" | "custom"` and
`allowedCapabilityIds`. `all` dynamically allows all currently and subsequently active,
unpaused capabilities in the reviewed supported catalog; it does not bypass permission,
chain, schema, scope, freeze, pause, or any other independent policy. `custom` permits
only the exact listed IDs, with `[]` meaning no capability grants. Create with both fields
omitted defaults to `all` and `[]`; IDs alone selects custom, including `[]`; explicit `all`
accepts omitted or empty IDs. `custom` requires IDs, and
`all` rejects nonempty or null IDs. List/create/rotation/PATCH expose the configured mode
and IDs, not a materialized expansion of effective IDs. Rotation resets to `all` with an
empty ID list while preserving its established permission/IP/TTL defaults. Dashboard step-up
PATCH accepts `{ "capabilityMode": "all" }` to reset, or custom plus the complete ID list;
IDs-only PATCH remains custom for compatibility. `{}` is invalid.

Neither mode implies signing or sending permissions. ClobAuth eligibility requires
`canSign`, `canUseEoaExecution`, and either `capabilityMode: "all"` or custom IDs containing
`polymarket:137:clob-auth:v1`; independent EOA, chain, payload, pause, destination and risk
policies still apply.

`POST /v1/wallets/sign` remains API-key-only (`canSign`). Its ClobAuth typed-data exception is
the Polymarket CLOB `ClobAuth` bootstrap: `type: typed_data`, `executionMode: eoa`, chain
137, exact domain (`ClobAuthDomain`, version `1`, chainId `137`, no verifying contract or
salt), exact `ClobAuth` primary type and ordered fields (`address`, `timestamp`, `nonce`,
`message`), and the fixed message `This message attests that I control the given wallet`.
The request contract accepts only `type: typed_data` and requires `typedData`.
`executionMode` may be omitted and defaults to `eoa`; an explicit `session_key`
or `type: message` is rejected during request validation. Top-level `chainId` is
optional when supplied by `typedData.domain.chainId`, and both must agree if present.

EOA signing returns a 65-byte hexadecimal ECDSA signature encoded as `r || s || v`,
with `v=27/28`. Provider recovery values `0/1` are converted to `27/28`; already
canonical values are preserved and other values or malformed signatures fail closed.
Recovery, protocol verification and the API response use the same normalized signature.
This makes the output canonical where older responses could end in `00/01`; clients
must not depend on the former byte representation. Protocol envelopes are constructed
separately. This is Sofa's EOA output contract, not an ERC-1271-wide signature restriction.

`POST /v1/transactions` accepts only `executionMode: "session_key"` or omission
(the same default). It checks the registered, unexpired chain authorization and live
on-chain key, then submits an Openfort Calibur UserOperation from the user wallet.
Explicit `"eoa"` and unknown modes return HTTP 400 (`VALIDATION_ERROR`), never an
automatic conversion to session-key execution. Direct signer EOA transaction sends
are not supported. Clients do not call `/v1/wallets/sign` before sending a transaction.
The independent Polymarket EOA signing lanes remain unchanged: `canUseEoaExecution`
continues to gate restricted typed-data signing, not transaction submission, with
`EOA_EXECUTION_ENABLED`, IP allowlist, short TTL and independent rate controls intact.

`message.address` must equal the selected wallet's `signerAddress` (not its embedded
`walletAddress` or funder address); timestamp is canonical decimal Unix seconds within
±300 seconds; nonce is a uint256 supplied as a safe integer or decimal string (zero is
valid). The EIP712Domain type
declaration, if supplied, must be exactly `name:string`, `version:string`, `chainId:uint256`.

The API key must have both `canSign` and `canUseEoaExecution`, plus either
`capabilityMode: all` or `capabilityMode: custom` with the dedicated
`polymarket:137:clob-auth:v1` ID.
Catalog presence does not by itself grant a custom-mode key this capability. EOA isolation policy (including
IP/TTL/rate controls), destination allowlist/protection, risk/signing-policy and frozen/live
state checks remain in force; destination protection may deny signing. The final live-state
read does not serialize against concurrent freeze writers; do not treat it as a race-free
freeze exclusion. PostgreSQL race behavior and actual Openfort/Polymarket outcomes have not
been verified. This signature is
only for CLOB authentication bootstrap, not orders, Permit, arbitrary typed data/messages,
hashes, or session-key signing. The separate capability-authorized V2 order lane and the
verifier-gated DepositWallet Batch lane are described below. No deployment or live
Polymarket outcome is guaranteed.

### Polymarket CLOB V2 single-order signing

The endpoint also supports continuous signing of individual Polygon (137) CLOB V2 orders; this is not a batch API. Orders require EOA mode, `canSign`, `canUseEoaExecution`, and an active, unpaused `polymarket:137:clob-order:v2` capability. `all` mode includes it dynamically; `custom` mode requires that exact ID in `allowedCapabilityIds`. Existing ClobAuth behavior remains unchanged. Only `TypedDataSign` wrapping the official V2 `Order` shape is accepted, with `signatureType: 3` (POLY_1271 / DepositWallet); V1, V3, types 0/1/2, arbitrary typed data, messages, and permits are rejected. Exchange contracts are fixed to `0xE111180000d2663C0091e4f400237545B87B996B` (ordinary) and `0xe2222d279d744050d28e00520010520000310F59` (neg-risk).

The capability mode's active grant and existing permissions/EOA safeguards gate orders. Strict protocol validation, Polygon chain 137 and runtime-code presence/stability checks, agent-signature recovery, and ERC-1271 validity are also required; these checks do not prove official-wallet ownership. Clients wrap the returned raw 65-byte signature according to the official SDK 1.2.0 layout before CLOB submission; no SDK installation is required and no envelope is returned. Existing deployments' `POLYMARKET_DEPOSIT_WALLET_BINDINGS` setting no longer has effect.

The wallet-level rolling 60-second limit is 60 accepted orders, shared across API keys and reserved atomically at acceptance; later failures still consume a slot. There is no per-order 60-second delay. General EOA enabled/canSign/canUseEoa/IP/TTL safeguards remain unchanged; ClobAuth and transaction send retain their original shared 1-per-60-second EOA limit. The validator checks positive integer amounts, side, and structure but imposes no economic/market/price/quantity limits: explicit authorization allows every structurally valid order. Timestamp ±300,000 ms is service signing freshness, not exchange order expiry. Freeze, pause, or key revocation cannot revoke an already signed order. A failed response may mean a TEE signature was generated but not returned. Real-client/CLOB/DepositWallet end-to-end acceptance has not been verified.

### Polymarket DepositWallet Batch signing

`POST /v1/wallets/sign` recognizes the exact Polygon 137 DepositWallet EIP-712 `Batch`
schema for signing only. It requires `canSign`, `canUseEoaExecution`, EOA mode, and the
active/unpaused `polymarket:137:deposit-wallet-batch-sign:v1` capability (`all` includes it;
`custom` must list that exact ID). This capability authorizes general Batch calls.
It does not require `canSendTransaction`, send a transaction, or submit the returned raw
signature. An external client submits any eventual signed payload.

The exact Batch schema accepts 1–32 calls, no more than 8 KiB calldata per call or 32 KiB
total. Every call must have a valid nonzero target, even-length hexadecimal calldata (which
may be empty), and exactly zero native value. There is no target, selector, ABI-canonicality,
spender, or operator allowlist. Arbitrary calldata can transfer tokens, grant unlimited
approvals, or change wallet permissions; the capability is high privilege and should only
be granted to trusted automation. A target's own contract pause still denies that call at
preflight and atomic acceptance. Pausing an exchange that is not a call target does not
implicitly infer or block a spender/operator relationship.

Normal EOA isolation, destination protection, risk, freeze, pause, live grant/permission,
deadline and digest rechecks remain in force; order-only rate/budget policy is not applied.
The verifier uses shared backend `RPC_URLS__137` and fails closed if it is unavailable or
verification fails. It pins all deployment reads to one Polygon block and retains the full
factory/Beacon/implementation/wallet identity snapshot, including runtime hashes, proxy
slots, predicted address, signer/id/owner, current nonce and paused state. Local evidence is
bound to the complete typed-data digest, deadline, signer and RPC fingerprint, with a
15-second maximum age. After TEE signing it re-probes current deployment identity and nonce,
then calls the exact `wallet.execute` path with `eth_call` from the factory address; this is
not an operator-gated call or a broadcast. Simulation checks whether this call would
currently execute, but does not prove any effects were mined or will persist. This is
signing authorization only, not a batch-send API. No real Openfort or live client
end-to-end result is claimed.

## 4. Error contract

Errors are normalized by the global exception filter and include request context:

```json
{
  "statusCode": 401,
  "code": "INVALID_API_KEY",
  "message": "Invalid API key",
  "requestId": "req_...",
  "timestamp": "2026-04-20T10:00:00.000Z",
  "path": "/v1/transactions"
}
```

Validation failures use `code: "VALIDATION_ERROR"` and may include field-level details.

Common public API codes include:

- `API_KEY_REQUIRED`
- `INVALID_API_KEY`
- `IP_NOT_ALLOWED`
- `CHAIN_NOT_SUPPORTED`
- `IDEMPOTENCY_CONFLICT`
- `WALLET_NOT_FOUND`
- `TRANSACTION_NOT_FOUND`
- `DEFI_CAPABILITY_NOT_FOUND`
- `DEFI_CONTRACT_NOT_ALLOWED`
- `DEFI_FUNCTION_NOT_ALLOWED`
- `DEFI_CAPABILITY_NOT_GRANTED`
- `DEFI_CAPABILITY_PAUSED`
- `DEFI_INVALID_PARAMETERS`
- `DEFI_POLICY_UNAVAILABLE`
- `POLYMARKET_SIGN_RATE_LIMITED` (includes `retryAfterSeconds`)

Generic transaction sends are admitted only when every contract call matches a cataloged
function capability explicitly granted to the API key; unknown and ungranted calls are
denied. ABI arguments and payable native value are caller-controlled, subject to the
contract's behavior and independent generic transaction, destination, billing, simulation,
and user-configured key-spend policies. ERC-20 `approve` is an independent function grant:
it permits any spender and any `uint256` amount, including unlimited approval, and is not
automatically added with an action or automatically cleaned up. Catalog admission does not
grant a capability. Generic message and typed-data signing are denied for all API keys,
except the exact Polymarket CLOB `ClobAuth` bootstrap and separately granted V2 single-order
signing described above; there is no legacy unrestricted signing path. The bootstrap requires
explicit `polymarket:137:clob-auth:v1`; orders require active, unpaused
`polymarket:137:clob-order:v2` (all mode includes it; custom mode requires the exact ID),
`canSign`, and `canUseEoaExecution`, plus signing isolation and
destination controls.
Dedicated dashboard withdrawal and payment flows remain separate.

## 5. Public transaction example

```bash
curl -X POST http://localhost:3100/v1/transactions \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 84532,
    "idempotencyKey": "order-abc-123",
    "interactions": [{
      "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "data": "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000f4240",
      "value": "0"
    }]
  }'
```

Query status:

```bash
curl http://localhost:3100/v1/transactions/<transactionId> \
  -H "X-API-Key: sk_your_key_here"
```

Status responses must remain safe: no calldata, `requestHash`, or `interactionsHash`.

## 6. API documentation rules

- Keep `openapi.yaml` limited to public API-key endpoints.
- Update `API.md` when route auth boundaries change.
- Update `SECURITY.md` when auth, key handling, logging, CORS, or proxy behavior changes.
