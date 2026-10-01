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
| `POST` | `/v1/wallets/sign` | Reserved signing route; signing is disabled in the DeFi-policy MVP and requests are denied |
| `POST` | `/v1/transactions/send` | Submit validated EVM interactions through the user's Openfort/agent wallet context |
| `GET` | `/v1/transactions/:id` | Return safe transaction status for the owning API-key user |

Do not accept Openfort IAM-only auth on these routes.

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
| `GET` | `/v1/defi-capabilities` | List reviewed, active DeFi capability metadata |
| `PATCH` | `/v1/api-keys/:id/capabilities` | Replace the key's capability grants (step-up required) |

These routes must not be added to `openapi.yaml` unless the product intentionally exposes them as public API-key routes.

Signing remains present in the public spec as a reserved API-key route, but is disabled
for every key in the DeFi-policy MVP. Valid message and typed-data requests are denied;
raw-hash signing has no unrestricted legacy path.

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

Generic transaction sends are admitted only when every contract call matches an active,
reviewed DeFi capability granted to the API key. Native-value calls and non-catalogued
calls are denied. Message and typed-data signing are disabled for all API keys in this
MVP, including keys created before the capability policy; there is no legacy unrestricted
signing path. Otherwise valid API-key signing requests are denied with
`DEFI_FUNCTION_NOT_ALLOWED`; destination protection may deny earlier. Dedicated dashboard
withdrawal and payment flows remain separate.

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
