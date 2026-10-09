# API Guide

`openapi.yaml` is the public machine-readable API specification. It intentionally documents only API-key endpoints. This file explains both public and dashboard-only route boundaries for maintainers.

## 1. Authentication methods

### API-key clients

Use `X-API-Key`:

```http
X-API-Key: sk_<secret>
```

API keys are accepted only by public automation endpoints.

### Dashboard clients

Use Openfort IAM bearer tokens:

```http
Authorization: Bearer <openfort_iam_access_token>
```

Frontend-only dashboard endpoints also require an allowed `Origin` or `Referer` header.

## 2. Public API-key endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/wallets/sign` | API-key signing; exact Polymarket ClobAuth bootstrap or explicitly granted CLOB V2 DepositWallet order typed data |
| `POST` | `/v1/transactions/send` | Submit validated EVM interactions through the user's Openfort/agent wallet context |
| `GET` | `/v1/transactions/:id` | Return safe transaction status for the owning API-key user |
| `GET` | `/v1/permissions` | Return the key's configured permissions, capability mode/IDs, and constraints; configuration is not an execution guarantee |
| `GET` | `/v1/capabilities?ids=id1,id2` | Look up 1–100 catalog capability definitions; definitions do not grant capabilities |
| `GET` | `/v1/me/wallets` | List the key owner's safe wallet metadata and chain authorizations (no balances or Openfort internal IDs) |

All public routes use `X-API-Key`; these three read routes require no `can*` permission. Existing API-key freeze, IP and billing guards still apply. For capability lookup, `ids` is required; comma-separated values are trimmed, non-empty, unique, and at most 256 characters each (query max 25,700 chars). Invalid input returns 400; unknown IDs are returned in `unknownIds` with 200, preserving request order. `all` mode dynamically includes catalog capabilities; `custom` with `[]` grants none. Wallet listing is owner-scoped, is not a balance or live on-chain check, and omits Openfort internal IDs. Do not accept Openfort IAM-only auth on these routes.

## 3. Dashboard/frontend-only endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/session` | Sync current Openfort IAM session to local user/wallet state |
| `POST` | `/auth/social` | Compatibility alias for session sync |
| `GET` | `/auth/me` | Return current user wallet/authorization state |
| `POST` | `/auth/refresh-api-key` | Revoke active keys and issue a replacement |
| `POST` | `/auth/embedded-wallet/authorize` | Bind embedded EOA and return agent registration details |
| `POST` | `/auth/embedded-wallet/registration-transaction` | Persist submitted Calibur registration tx hash |
| `POST` | `/auth/embedded-wallet/registration-result` | Persist final registration status |
| `GET` | `/v1/wallets/balances` | Return native token and USDC balances |
| `POST` | `/v1/wallets/deposit-info` | Return wallet deposit address/context |
| `POST` | `/v1/wallets/withdraw` | Submit dashboard-authenticated withdrawal |
| `GET` | `/v1/api-keys` | List API-key metadata |
| `POST` | `/v1/api-keys` | Create API key and return raw secret once |
| `DELETE` | `/v1/api-keys/:id` | Revoke API key |
| `GET` | `/v1/defi-capabilities` | List catalog DeFi capability metadata |
| `PATCH` | `/v1/api-keys/:id/capabilities` | Replace the key's capability grants (step-up required) |

These routes must not be added to `openapi.yaml` unless the product intentionally exposes them as public API-key routes.

API-key capability configuration has `capabilityMode: "all" | "custom"` and
`allowedCapabilityIds`. `all` dynamically allows all currently and subsequently active,
unpaused capabilities in the reviewed supported catalog; it does not bypass permission,
chain, schema, scope, freeze, pause, or any other independent policy. `custom` permits
only the exact listed IDs, with `[]` meaning no capability grants. Create with both fields
omitted defaults to `all` and `[]`; IDs alone selects custom, including `[]`; explicit `all`
accepts omitted or empty IDs. `custom` requires IDs, and
`all` rejects nonempty or null IDs. List/create/rotation/PATCH expose the configured mode
and IDs, not a materialized expansion of effective IDs. Rotation resets to `all` with an
empty ID list while preserving its established permission/IP/TTL defaults. IAM step-up
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
`message.address` must equal the selected wallet's agentWalletAddress (not its embedded
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
hashes, or session-key signing. The separate explicitly granted V2 order lane is described
below. No deployment or live Polymarket outcome is guaranteed.

### Polymarket CLOB V2 single-order signing

The endpoint also supports continuous signing of individual Polygon (137) CLOB V2 orders; this is not a batch API. Orders require EOA mode, `canSign`, `canUseEoaExecution`, and `polymarket:137:clob-order:v2` explicitly listed under `capabilityMode: custom`. `all` does not authorize orders. Existing ClobAuth behavior remains unchanged. Only `TypedDataSign` wrapping the official V2 `Order` shape is accepted, with `signatureType: 3` (POLY_1271 / DepositWallet); V1, V3, types 0/1/2, arbitrary typed data, messages, and permits are rejected. Exchange contracts are fixed to `0xE111180000d2663C0091e4f400237545B87B996B` (ordinary) and `0xe2222d279d744050d28e00520010520000310F59` (neg-risk).

The explicit custom grant and existing permissions/EOA safeguards gate orders. Strict protocol validation, Polygon chain 137 and runtime-code presence/stability checks, agent-signature recovery, and ERC-1271 validity are also required; these checks do not prove official-wallet ownership. Clients wrap the returned raw 65-byte signature according to the official SDK 1.2.0 layout before CLOB submission; no SDK installation is required and no envelope is returned. Existing deployments' `POLYMARKET_DEPOSIT_WALLET_BINDINGS` setting no longer has effect.

The wallet-level rolling 60-second limit is 60 accepted orders, shared across API keys and reserved atomically at acceptance; later failures still consume a slot. There is no per-order 60-second delay. General EOA enabled/canSign/canUseEoa/IP/TTL safeguards remain unchanged; ClobAuth and transaction send retain their original shared 1-per-60-second EOA limit. The validator checks positive integer amounts, side, and structure but imposes no economic/market/price/quantity limits: explicit authorization allows every structurally valid order. Timestamp ±300,000 ms is service signing freshness, not exchange order expiry. Freeze, pause, or key revocation cannot revoke an already signed order. A failed response may mean a TEE signature was generated but not returned. Real-client/CLOB/DepositWallet end-to-end acceptance has not been verified.

## 4. Error contract

Errors are normalized by the global exception filter and include request context:

```json
{
  "statusCode": 401,
  "code": "INVALID_API_KEY",
  "message": "Invalid API key",
  "requestId": "req_...",
  "timestamp": "2026-04-20T10:00:00.000Z",
  "path": "/v1/transactions/send"
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
explicit `polymarket:137:clob-auth:v1`; orders require explicit custom
`polymarket:137:clob-order:v2`, `canSign`, and `canUseEoaExecution`, plus signing isolation and
destination controls.
Dedicated dashboard withdrawal and payment flows remain separate.

## 5. Public transaction example

```bash
curl -X POST http://localhost:3100/v1/transactions/send \
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
