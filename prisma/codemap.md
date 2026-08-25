# Prisma Schema Codemap

## Responsibility
The Prisma schema serves as the data persistence layer for the SOFA ONE application, defining the relational database structure for user authentication, wallet management, API key security, and transaction logging. It implements a PostgreSQL-backed ORM that enforces data integrity through constraints and relationships, supporting server-side automated blockchain signing workflows.

## Design Patterns
- **ORM Abstraction**: Utilizes Prisma Client for type-safe database operations, eliminating raw SQL in application code.
- **Relational Design**: Employs normalized tables with foreign key relationships to maintain referential integrity.
- **Security by Design**: Implements hashed API keys with Argon2, unique constraints on sensitive fields, optional IP whitelisting, and user/API-key/wallet freeze metadata for suspicious usage or incident response.
- **Audit Trail**: ApiKeyEvent, SecurityEvent, SecurityNotification, Transaction, and SigningRequest models capture API-key lifecycle changes, cross-cutting security telemetry, user-facing security alerts, blockchain transaction submissions, and TEE signing requests without storing API-key secrets, signing plaintext, or full calldata in transaction audit details.
- **Withdrawal Policy**: WithdrawalPolicy and WithdrawalAddress store per-user withdrawal caps and allowlisted addresses with cooldown windows; adding an address enables allowlist enforcement.
- **Billing Usage Ledger**: BillingUsageEvent is an evidence-backed, append-only usage ledger. Each row carries a lifecycle `status` (`unverified`/`posted`/`quarantined`/`reversed`), an `entryType` (`usage`/`reversal`/`adjustment`), and a `sourceType` (`legacy_import`/`api_request`/`openfort_receipt`/`reconciliation`/`manual_adjustment`). Legacy/caller-supplied rows are explicitly `unverified` + `legacy_import` and are never auto-treated as receipt-confirmed. Posted entries are not updated/deleted; corrections use reversal/adjustment entries (self-referencing `reversalOfId`/`adjustmentOfId`), and unknown/unpriced usage is `quarantined`. Receipt evidence (`receiptRef` + `receiptLogIndex` as the canonical receipt-component identity, `receiptData`, `receiptBlockNumber`, `receiptBlockHash`, `receiptBlockTimestamp`, `receiptStatus`, `reconciledAt`) plus chain/tx/wallet/asset/base-unit/decimals/price/policy-version fields support reconciliation. `BillingReconciliationRun` persists run/status state; usage events reference the run that confirmed them. Outbound (`outbound_volume`) entries must reference a Transaction (DB CHECK) unless reversal/legacy.
- **Migration-Driven Evolution**: Schema changes are versioned through migrations, allowing incremental updates without data loss.

## Data & Control Flow
### Schema Relationships
- **User (1:1) UserWallet**: Each user has exactly one wallet via unique userId constraint.
- **User (1:N) ApiKey**: Users can have multiple API keys for programmatic access.
- **User (1:N) ApiKeyEvent**: Key creation, revocation, and rotation events are recorded with prefix/name snapshots.
- **User/APIKey/Wallet (1:N) SecurityEvent**: Security events capture actor type, event type, risk level, result/reason, request context, and safe JSON metadata for audit/risk/alerting.
- **User/SecurityEvent (1:N) SecurityNotification**: Dashboard notifications point back to selected user-attributed security events and track read state.
- **User (1:1) WithdrawalPolicy / User (1:N) WithdrawalAddress**: Per-user policy controls single/daily withdrawal limits, step-up expectation, and optional destination allowlist cooldown.
- **User (1:N) Transaction**: Users can initiate multiple blockchain transactions; API-key submissions snapshot key prefix/name for durable attribution.
- **Reverse Relations**: All child models reference User via userId foreign key with RESTRICT delete to prevent orphaned records.
- **User (1:N) SigningRequest**: Users can initiate multiple message/typed-data signing requests; API-key requests snapshot key prefix/name for durable attribution.

### Key Constraints
- **Uniqueness**: socialId (users), openfortAccountId (user_wallets), walletAddress (user_wallets), and active API-key names per user through a partial unique index. API-key prefixes are indexed lookup hints, not unique identifiers.
- **Data Types**: Uses PostgreSQL-specific types (UUID, TIMESTAMPTZ, JSONB, BIGINT for chainId).
- **Security**: apiKeyHash stored as TEXT (Argon2 hash), keyPrefix as VARCHAR(32) for efficient lookup before verifying every matching hash candidate; users, wallets, and suspicious keys can be marked with `frozenAt`/`frozenReason` without deleting audit history.
- **Optional Fields**: email, expiresAt, name, user/API-key/wallet frozenAt/frozenReason, withdrawal daily limit, txHash, details, failureReason, completedAt allow flexible data capture without storing sensitive plaintext payloads.
- **Defaults**: status='active', revoked=false, signing/transaction authMethod='api_key', signing status='submitting', createdAt=now().

### Migration History
- **Init (20260419143630)**: Created core tables with initial constraints, including salt column (later removed).
- **Refactor (20260421090537)**: Dropped salt column, added details and walletAddress to transactions.
- **Drop Allowed Contracts (20260421120000)**: Removed allowed_contracts array from api_keys.
- **Drop Transaction Intent ID (20260429120000)**: Removed obsolete intent_id from transactions after transaction status moved to locally stored send results.
- **Add Billing (20260825000000)**: Added user-level billing_accounts, plan versions/tiers/assignments, usage events, invoices/lines.
- **Harden Billing Usage Ledger (20260826000000)**: Evolved billing_usage_events into an evidence-backed append-only ledger (status/entryType/sourceType, receipt evidence with receipt-component identity via receipt_ref+receipt_log_index, chain/tx/wallet/asset/price/policy-version, reversal/adjustment self-refs, reconciliation-run ref, outbound-transaction CHECK, per-account receipt-component uniqueness) and added billing_reconciliation_runs.

## Integration Points
- **Authentication Module**: Consumes User and UserWallet models for Openfort IAM integration and wallet provisioning.
- **API Key Middleware**: Validates ApiKey models for protected API routes, querying extended/legacy prefix candidates, verifying each Argon2 hash candidate, rejecting frozen users/keys, enforcing IP restrictions, and freezing high-risk/repeated suspicious context changes.
- **API Key Management**: Creates, revokes, and rotates API keys through transactional service methods that enforce lifecycle limits and append ApiKeyEvent audit rows.
- **Security Events**: `SecurityEventService` appends generic security telemetry rows for future anomaly detection, freeze workflows, and policy denials; selected rows fan out to `SecurityNotification` dashboard alerts.
- **Transaction Service**: Creates Transaction records for Openfort intent submissions, stores request/interactions hashes and API-key attribution snapshots, then updates status/hash/failure metadata.
- **Wallet Management**: Uses UserWallet for Openfort account mapping and address retrieval; wallet freeze metadata blocks signing, transaction send, withdrawals, deposit info, and balance reads; WithdrawalPolicy/WithdrawalAddress manage dashboard withdrawal allowlists/cooldowns and enforce limits before Openfort submission.
- **Frontend Integration**: Indirectly supports React SPA through backend APIs, providing user wallet data and transaction history.
