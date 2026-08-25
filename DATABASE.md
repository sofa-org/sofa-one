# Database

The canonical data model is `prisma/schema.prisma`. PostgreSQL is the application database, accessed through Prisma Client from NestJS services.

## 1. Models

### `User`

Local identity record mapped from Openfort IAM:

- `socialProvider`
- `socialId` unique Openfort/user-provider identifier
- optional `email`
- relations to wallet, API keys, events, transactions, and signing requests

### `UserWallet`

One wallet record per user:

- `userId` unique relation to `User`
- `openfortAccountId` stable Openfort account foreign key
- `walletAddress` EVM address
- backend agent metadata: `agentOpenfortAccountId`, `agentWalletAddress`, `agentKeyHash`
- related per-chain authorizations

Invariant: do not replace `openfortAccountId` with wallet address or orphan it from the user wallet lifecycle.

### `WalletChainAuthorization`

Per-wallet/per-chain Calibur agent-key registration state:

- composite key: `walletId + chainId`
- `status`
- optional `registrationTxHash`
- optional `expiresAt`
- `updatedAt`

### `ApiKey`

API-key credential metadata:

- `apiKeyHash`: Argon2id hash only
- `keyPrefix`: lookup hint, indexed
- optional `name`
- optional `expiresAt`
- `revoked`
- `allowedIps`
- `lastUsedAt`

Invariants:

- raw secrets are never stored;
- lookup must verify every matching prefix candidate;
- active key limits and active name uniqueness are enforced in service code.

### `ApiKeyEvent`

Immutable API-key lifecycle audit log:

- user/key relation
- `action`
- `keyPrefix` and `keyName` snapshots
- optional JSON metadata

### `Transaction`

Public transaction submission/audit record:

- `userId`, optional `apiKeyId`
- API-key attribution snapshot: `apiKeyPrefix`, `apiKeyName`, `authMethod`
- status, transaction hash, chain ID, wallet address
- `operationType`, `idempotencyKey`, `requestHash`
- optional failure/details fields

Uniqueness: `userId + operationType + chainId + idempotencyKey`.

### `SigningRequest`

Public signing audit record:

- user/key attribution snapshot
- signing `type`
- optional `chainId`
- wallet address
- `requestHash`, `digest`
- status and timestamps

## 2. Naming convention

Prisma models expose camelCase fields while database tables/columns use snake_case through `@@map` and `@map`.

## 3. Migration workflow

After changing `prisma/schema.prisma`:

```bash
npm run prisma:generate
npm run prisma:migrate:dev
```

For production/deployment migrations:

```bash
npm run prisma:migrate:deploy
```

## 4. Schema-change checklist

- Confirm the change preserves private-key and API-key storage invariants.
- Add or update indexes for new lookup patterns.
- Keep audit snapshots when future mutations could change names/prefixes/status.
- Update `DATABASE.md`, `ARCHITECTURE.md`, and `REQUIREMENTS.md` if model responsibilities change.
- Run relevant unit/e2e tests and Prisma generation before merging.
