# Prisma Schema Codemap

## Responsibility
The `prisma/` directory is the canonical data-persistence layer for SOFA ONE. `schema.prisma` defines the PostgreSQL data model (25 models, 8 enums) for Openfort IAM users, TEE-managed wallets, API-key security, transaction/signing audit, security telemetry, withdrawal controls, MFA/step-up, and commercial billing (usage ledger, invoices, Stripe + USDC payment rails). `migrations/` holds the versioned SQL history that evolves the schema without data loss. The generated Prisma Client is the only data-access path used by the NestJS backend; private keys are never stored — only Openfort account IDs, wallet addresses, and hashed credentials.

## Design / Patterns
- **ORM Abstraction**: `prisma-client-js` generator; `PrismaService` (`src/core/database/prisma.service.ts`) extends `PrismaClient` with a `PrismaPg` driver adapter over `DATABASE_URL` and lifecycle hooks (`$connect`/`$disconnect`). Globally exported via `PrismaModule`.
- **Explicit Naming**: camelCase model fields mapped to snake_case tables/columns via `@@map`/`@map`; UUID primary keys throughout; PostgreSQL-specific types (`@db.Uuid`, `@db.Timestamptz`, `@db.VarChar`, `BigInt` for chain IDs and micro-denominated money).
- **Security by Design**: API keys stored as Argon2id hashes (`apiKeyHash` TEXT) with a `keyPrefix` lookup hint (27-char `sk_`+24-hex for new keys, legacy 11-char tolerated); lookup verifies every matching prefix candidate. Freeze state (`frozenAt`/`frozenReason`) on User, UserWallet, and ApiKey for emergency lockout without deleting audit history. MFA TOTP secrets and recovery codes stored only as hashes/encrypted blobs; step-up challenge codes hashed.
- **Immutable Attribution Snapshots**: `Transaction` and `SigningRequest` copy `apiKeyPrefix`/`apiKeyName`/`authMethod` at write time so later key renames/revocations cannot rewrite audit history. `BillingPaymentAttempt` snapshots `expectedPayerAddress`/`requiredConfirmations`/`providerIdentity` at quote time; the claim path reads these, never the client.
- **Append-Only Usage Ledger**: `BillingUsageEvent` is an evidence-backed ledger. Each row carries `status` (`unverified`/`posted`/`quarantined`/`reversed`), `entryType` (`usage`/`reversal`/`adjustment`), and `sourceType` (`legacy_import`/`api_request`/`openfort_receipt`/`reconciliation`/`manual_adjustment`). Posted entries are never updated/deleted; corrections use self-referencing `reversalOfId`/`adjustmentOfId`. Legacy/caller-supplied rows are explicitly `unverified` + `legacy_import` and never auto-treated as receipt-confirmed. Receipt identity is `(billingAccountId, receiptRef, receiptLogIndex)` (partial unique index) because one receipt can carry multiple Transfer logs. A DB CHECK forces `outbound_volume` entries to reference a `Transaction` unless reversal/legacy.
- **Dual-Rail Payment Settlement**: `BillingPaymentAttempt` supports `stripe` and `usdc` rails with a shared `BillingPaymentAttemptStatus` enum (`pending`/`confirming`/`succeeded`/`failed`/`expired`/`needs_review`/`reorged`). USDC evidence columns are nullable and only populated for `method='usdc'`; a unique index on `(chainId, tokenAddress, txHash, logIndex)` plus a DB CHECK enforcing lowercase `txHash` make transfer evidence case-safe at the database layer. `BillingInvoice` records the winning rail via `paidVia` + unique `settlementAttemptId`; settlement is an atomic first-rail-wins CAS in `InvoiceSettlementService` using `SELECT ... FOR UPDATE` row locks (attempt → invoice order).
- **DB-Level State Machines**: CHECK constraints (applied via migrations, not all representable in `schema.prisma`) constrain `transactions.status` (`submitting`/`pending`/`confirmed`/`failed`/`unknown`/`reverted`), `transactions.operation_type` (`send`/`withdraw`), `signing_requests.type`/`status`/`auth_method`, `api_key_events.action`, and `billing_payment_attempts.tx_hash` lowercase.
- **Partial Indexes Outside Prisma**: `api_keys_user_active_name_unique` (unique `(user_id, lower(name))` where `revoked=false` and `name IS NOT NULL`) and `billing_payment_attempts_one_pending_per_invoice_method_idx` (unique `(invoice_id, method)` where `status IN ('pending','confirming')`) exist only in migrations; `prisma migrate dev` drift detection must not drop them (use `prisma migrate deploy`).
- **Migration-Driven Evolution**: 45 versioned migrations; sensitive migrations fail closed (e.g. `20260827030000` aborts on normalized `tx_hash` collisions before lowercasing).

## Models

### Identity & Wallet
- **User** (`users`): Openfort IAM identity — `socialProvider`/`socialId` (unique), optional `email`, freeze state. 1:1 with `UserWallet`, `WithdrawalPolicy`, `UserMfaTotpCredential`, `BillingAccount`; 1:N with API keys, events, transactions, signing requests, security events/notifications, step-up challenges, known IPs.
- **UserWallet** (`user_wallets`): 1:1 per user. `openfortAccountId` (stable Openfort FK, unique), `walletAddress` (unique), `status`, agent wallet fields (`agentOpenfortAccountId`, `agentWalletAddress`, `agentKeyHash` — Calibur session key), freeze state. `openfortAccountId` must never be replaced by wallet address or orphaned.
- **WalletChainAuthorization** (`wallet_chain_authorizations`): composite PK `(walletId, chainId)`; per-chain agent registration status, `registrationTxHash`, `expiresAt`; cascade-deletes with wallet.

### API Keys & Audit
- **ApiKey** (`api_keys`): Argon2 `apiKeyHash`, `keyPrefix` (indexed lookup hint), optional `name`/`expiresAt`, `revoked`, freeze state, permission flags (`canSign`, `canSendTransaction`, `canReadTransactionStatus` default true, `canUseEoaExecution`), `allowedIps`/`allowedContracts`/`allowedFunctionSelectors` arrays, `dailySpendLimit`/`monthlySpendLimit` (decimal strings), usage metadata (`lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent`). No chain scoping — chain selection lives in request DTOs and agent-key registration.
- **ApiKeyEvent** (`api_key_events`): lifecycle audit (`api_key.created`/`revoked`/`rotated`/`permission_changed`) with prefix/name snapshots and JSON metadata; `apiKeyId` FK `onDelete: SetNull`.
- **Transaction** (`transactions`): submission audit — `status`, `txHash`, `chainId` (BigInt), `walletAddress`, `operationType`, `idempotencyKey`, `requestHash`, `failureReason`, `details` JSON, API-key attribution snapshots. Unique `(userId, operationType, chainId, idempotencyKey)` for atomic idempotency. Public status responses must never expose calldata/`requestHash`.
- **SigningRequest** (`signing_requests`): TEE signing audit — `type` (`message`/`typed_data`), `chainId`, `walletAddress`, `requestHash`, `digest`, `status` (`submitting`/`signed`/`failed`), API-key attribution snapshots.

### Security & Access Control
- **SecurityEvent** (`security_events`): cross-cutting telemetry — `actorType` (`user`/`api_key`/`system`), optional user/apiKey/wallet attribution (SetNull on delete), `eventType`, `riskLevel`, `result`/`reason`, request context (`ip`, `userAgent`, `requestId`), safe JSON `metadata`. Indexed for risk/alerting queries.
- **SecurityNotification** (`security_notifications`): dashboard alerts derived from selected security events; tracks `readAt`; cascade-deletes with user, SetNull on event.
- **WithdrawalPolicy** (`withdrawal_policies`): 1:1 per user — single/daily withdrawal limits (decimal strings), `requireAddressAllowlist`, `newAddressCooldownHours` (default 24), `requireStepUp` (default true).
- **WithdrawalAddress** (`withdrawal_addresses`): allowlisted destinations with `availableAt` cooldown; unique `(userId, address)`.
- **UserKnownIp** (`user_known_ips`): per-user known IPs for context-change detection; unique `(userId, ip)`.
- **StepUpChallenge** (`step_up_challenges`): hashed challenge code, `proofToken` (indexed), `verified`, `attempts`, `expiresAt`; cascade-deletes with user.
- **UserMfaTotpCredential** (`user_mfa_totp_credentials`): 1:1 per user — `encryptedSecret`, `status` (`pending`/enabled/disabled lifecycle), `enabledAt`/`disabledAt`.
- **UserMfaTotpRecoveryCode** (`user_mfa_totp_recovery_codes`): hashed recovery codes with `usedAt`; cascade-deletes with credential.

### Billing
- **BillingAccount** (`billing_accounts`): 1:1 per user — `currency` (default USD), optional unique `stripeCustomerId`.
- **BillingPlanVersion** (`billing_plan_versions`): versioned plan catalog — unique `(code, version)`, monthly fee/included quotas (BigInt micros), overage rates, `effectiveFrom`.
- **BillingPlanTier** (`billing_plan_tiers`): volume-tiered pricing — `lowerBoundMicros`/`upperBoundMicros`/`ratePpm`; unique `(planVersionId, lowerBoundMicros)`; cascade-deletes with plan.
- **BillingPlanAssignment** (`billing_plan_assignments`): plan in effect per account per `periodStart`; unique `(billingAccountId, periodStart)`.
- **BillingReconciliationRun** (`billing_reconciliation_runs`): reconciliation run state — `status`, `runType`, period bounds, `summary` JSON, `errorDetails`.
- **BillingUsageEvent** (`billing_usage_events`): append-only usage ledger (see Design/Patterns). Links to `Transaction` (SetNull), `BillingPlanVersion` (SetNull), `BillingReconciliationRun` (SetNull), and self-referencing reversal/adjustment relations.
- **BillingInvoice** (`billing_invoices`): per-period invoice — status enum (`open`/`finalized`/`needs_review`/`void`), micro-denominated totals, immutable `snapshotJson` + `snapshotHash`, `paidAt`/`paidVia`/`settlementAttemptId` (unique). Unique `(billingAccountId, periodStart)`.
- **BillingInvoiceLine** (`billing_invoice_lines`): line items with `lineType`, quantity, `unitRatePpm`/`unitAmountMicros`, `amountMicros`; cascade-deletes with invoice.
- **BillingPaymentAttempt** (`billing_payment_attempts`): one row per payment attempt — `method` rail, status enum, amount/currency, Stripe lookup keys (unique `stripeCheckoutSessionId`/`stripePaymentIntentId`), `checkoutUrl`, safe failure code/message, USDC quote/evidence columns (chain, token, treasury, expected/actual base units, quote expiry, price source, expected payer, required confirmations, provider identity digest, tx evidence, receipt JSON), timestamps. Unique `(chainId, tokenAddress, txHash, logIndex)` for USDC evidence; partial unique index enforces one active attempt per `(invoice, method)`. No delete path exists — attempts are the payment evidence ledger.
- **StripeWebhookEvent** (`stripe_webhook_events`): processed/ignored webhook events keyed by unique `stripeEventId`; full Stripe payloads never persisted.

## Constraints
- **Uniqueness**: `users.socialId`; `user_wallets.userId`/`openfortAccountId`/`walletAddress`/`agentOpenfortAccountId`/`agentWalletAddress`; active API-key names per user (partial unique on `lower(name)`); `transactions (userId, operationType, chainId, idempotencyKey)`; `withdrawal_addresses (userId, address)`; `user_known_ips (userId, ip)`; `billing_accounts.userId`/`stripeCustomerId`; `billing_plan_versions (code, version)`; `billing_plan_tiers (planVersionId, lowerBoundMicros)`; `billing_plan_assignments (billingAccountId, periodStart)`; `billing_usage_events.sourceKey` + partial `(billingAccountId, receiptRef, receiptLogIndex)`; `billing_invoices (billingAccountId, periodStart)`; `billing_invoices.settlementAttemptId`; `billing_payment_attempts` Stripe IDs + `(chainId, tokenAddress, txHash, logIndex)`; `stripe_webhook_events.stripeEventId`.
- **DB CHECK constraints** (migration-applied): transaction/signing-request state machines, `api_key_events.action`, outbound-usage transaction association, lowercase `tx_hash`.
- **Delete semantics**: audit/child rows use `SetNull` (ApiKeyEvent, SecurityEvent, SigningRequest, usage-event FKs) or `Cascade` (notifications, withdrawal policy/addresses, step-up, MFA, invoice lines, payment attempts); core ownership FKs (User→UserWallet/ApiKey/Transaction/SigningRequest, BillingAccount) use `Restrict` to prevent orphaned records.
- **Indexes**: prefix lookup (`api_keys.keyPrefix`), ownership/history (`userId, createdAt`), status/risk queries, receipt/reversal/adjustment lookups, pending-payment lookups.

## Flow
1. **Auth / provisioning**: Openfort IAM login → `AuthService` find-or-create `User` → create pending `UserWallet` (nullable `openfortAccountId`/`walletAddress` until provisioning completes) → agent registration writes `WalletChainAuthorization` per chain and records known IPs.
2. **API-key issuance**: `ApiKeyService` generates key material, stores only `apiKeyHash` + `keyPrefix` + permissions/allowlists/spend limits in `ApiKey`, appends `ApiKeyEvent` audit rows in the same transaction; enforces max 10 active keys and unique active names.
3. **Request auth**: `ApiKeyAuthGuard`/`EitherAuthGuard` query `ApiKey` by prefix candidates, Argon2-verify each, reject frozen users/keys, enforce IP allowlists, update `lastUsedAt`/`lastUsedIp`/`lastUsedUserAgent`, and write `SecurityEvent` rows for suspicious context changes (freezing high-risk keys via `updateMany`).
4. **Signing / transactions**: `WalletService`/`TransactionsService` load `UserWallet` (reject frozen), enforce policy (TransactionPolicyService, signing policy, EOA isolation), write `SigningRequest`/`Transaction` rows with attribution snapshots, submit to Openfort, then update status/hash/failure metadata. Idempotency is enforced by the unique `(userId, operationType, chainId, idempotencyKey)` index.
5. **Withdrawals**: `WithdrawalPolicyService` enforces limits/allowlist cooldowns (with `SELECT ... FOR UPDATE` row locks) before `WalletService` submits; policy denies and high-value requests are recorded as `SecurityEvent`.
6. **Security telemetry**: `SecurityEventService.record` persists events (risk-scored), fans out to `SecurityNotification` for user-facing alerts, and optionally exports redacted payloads to SIEM.
7. **Billing**: usage is recorded into `BillingUsageEvent` (api_request/openfort_receipt sources); `BillingReconciliationService` reconciles receipts against `Transaction` rows and updates run state; `BillingService` computes invoices from usage/plan assignments; `StripePaymentService`/`UsdcPaymentService` create `BillingPaymentAttempt` rows; `InvoiceSettlementService` atomically settles via `paidAt`/`paidVia`/`settlementAttemptId` CAS; `StripeWebhookService` records webhook events and transitions attempts.

## Migration History
- **20260419143630_init**: Core tables — `users`, `user_wallets` (with `chain_id`), `api_keys` (with `salt`), `transactions` (with `intent_id`).
- **20260421090537_refactor**: Drop `api_keys.salt`; add `transactions.details` + `wallet_address`.
- **20260421120000_drop_allowed_contracts**: Drop `api_keys.allowed_contracts`.
- **20260422070724_add_api_key_last_used_at**: Add `api_keys.last_used_at`.
- **20260423090935_make_transaction_chainid_walletaddress_required**: Make `chain_id`/`wallet_address` NOT NULL.
- **20260424094347_add_user_policies**: Add `user_policies` (dropped later).
- **20260427000100_harden_asset_safety**: Add `operation_type`/`idempotency_key`; idempotency unique index; `key_prefix` index.
- **20260427000200_multichain_asset_safety**: Add `api_keys.allowed_chains`; `transactions.request_hash`; chain-aware idempotency index.
- **20260427065526_safety**: Rename idempotency index.
- **20260427080000_add_signing_requests_audit**: Add `signing_requests`.
- **20260427090000_harden_signing_audit**: Attribution snapshots + CHECK constraints on signing requests.
- **20260427100000_harden_transaction_audit**: Attribution snapshots, `interactions_hash`, `failure_reason`, `completed_at`, CHECK constraints, `api_key_id` FK.
- **20260427110000_extend_api_key_prefix**: `key_prefix` VARCHAR(12)→VARCHAR(32) on api_keys/signing_requests/transactions.
- **20260427120000_harden_api_key_lifecycle**: Add `api_key_events`; active-name partial unique index.
- **20260428000000_make_wallet_provisioning_trackable**: Make `openfort_account_id`/`wallet_address` nullable.
- **20260428054244_refactor**: Drop `api_key_events.id` default.
- **20260428153500_drop_transaction_interactions_hash**: Drop `interactions_hash`.
- **20260429082558_improve**: Ownership/history indexes.
- **20260429120000_drop_transaction_intent_id**: Drop `intent_id`.
- **20260429184700_add_agent_wallet_fields**: Agent wallet/session-key fields on `user_wallets`.
- **20260505001600_add_agent_registration_tx_hash**: Add `agent_registration_tx_hash`.
- **20260505090000_drop_user_policies**: Drop `user_policies`.
- **20260506180000_drop_api_key_allowed_chains**: Drop `allowed_chains` (chain selection moved to request DTOs).
- **20260507000100_add_wallet_authorizations**: Add `wallet_chain_authorizations`; migrate agent fields; drop `chain_id`/`agent_status`/`agent_registration_tx_hash`/`agent_expires_at`.
- **20260522090000_add_api_key_permissions**: Permission flags on `api_keys`.
- **20260523011000_add_api_key_usage_metadata**: `last_used_ip`/`last_used_user_agent`.
- **20260527105430_add_step_up_challenge**: Add `step_up_challenges`.
- **20260527150000_add_security_events**: Add `security_events`.
- **20260528120000_add_api_key_freeze_fields**: Freeze state on `api_keys`.
- **20260528130000_add_withdrawal_policies**: Add `withdrawal_policies` + `withdrawal_addresses`.
- **20260528160000_add_security_notifications**: Add `security_notifications`.
- **20260528170000_add_user_wallet_freeze_fields**: Freeze state on `users` + `user_wallets`.
- **20260529130000_add_user_known_ips**: Add `user_known_ips`.
- **20260529180000_add_api_key_spend_limits_and_allowlists**: Contract/selector allowlists + spend limits.
- **20260601043840_security**: Drop `gen_random_uuid()` defaults on security/withdrawal tables.
- **20260605120000_add_mfa_totp**: Add `user_mfa_totp_credentials` + `user_mfa_totp_recovery_codes`.
- **20260825000000_add_billing**: Billing foundation — accounts, plan versions/tiers/assignments, usage events, invoices/lines, enums.
- **20260826000000_harden_billing_usage_ledger**: Evidence-backed append-only ledger (status/entryType/sourceType, receipt evidence, reconciliation runs, outbound-transaction CHECK, receipt-component uniqueness).
- **20260826010000_relax_transaction_audit_checks**: Allow `withdraw` operation type; add `unknown`/`reverted` statuses.
- **20260826020000_add_stripe_billing_foundation**: `stripe_customer_id`, `paid_at`, `billing_payment_attempts`, `stripe_webhook_events`.
- **20260826030000_add_stripe_checkout_url_and_pending_index**: `checkout_url`; partial unique one-pending-per-invoice index.
- **20260827000000_add_usdc_payment_foundation**: Dual-rail `method`, USDC quote/evidence columns, `paid_via`/`settlement_attempt_id`, status enum extension, per-(invoice, method) pending index.
- **20260827010000_harden_usdc_payment_foundation**: USDC evidence uniqueness `(chainId, tokenAddress, txHash, logIndex)`; active slot covers pending+confirming.
- **20260827020000_add_usdc_payment_phase2**: `expected_payer_address` + `required_confirmations` quote snapshots.
- **20260827030000_harden_usdc_claim_safety**: `provider_identity` digest; lowercase `tx_hash` canonicalization + CHECK (fails closed on collisions).

## Integration Points
- **PrismaService / PrismaModule** (`src/core/database/`): Global provider; all consumers inject `PrismaService` and use generated model delegates plus `$transaction` (interactive transactions for atomic key creation, wallet provisioning, settlement, and usage recording).
- **AuthModule** (`src/modules/auth/auth.service.ts`): `User` find-or-create, `UserWallet` provisioning, `WalletChainAuthorization` updates, `UserKnownIp` tracking.
- **ApiKeyModule** (`src/modules/api-key/api-key.service.ts`): `ApiKey` create/list/revoke/rotate with `ApiKeyEvent` audit inside transactions.
- **Auth guards** (`src/common/guards/`): `ApiKeyAuthGuard`/`EitherAuthGuard`/`OpenfortUserGuard` — `ApiKey` prefix-candidate lookup + Argon2 verification, `User` resolution, `SecurityEvent` writes, `ApiKey.updateMany` freeze actions; `IpAllowlistService` reads `ApiKey.allowedIps`.
- **WalletModule** (`src/modules/wallet/`): `UserWallet` reads/freeze checks, `SigningRequest` create/list/update, `Transaction` writes for withdrawals, `WithdrawalPolicy`/`WithdrawalAddress` management with row locks.
- **TransactionsModule** (`src/modules/transactions/`): `Transaction` create/update/list/status with idempotency and attribution snapshots; `TransactionPolicyService` reads transaction history for spend-limit enforcement.
- **SecurityEventsModule** (`src/modules/security-events/`): `SecurityEvent` writes (risk-scored), `ApiKey` reads for risk evaluation; `SecurityNotificationsModule` creates/reads `SecurityNotification` rows.
- **StepUpModule / MfaModule**: `StepUpChallenge` create/verify/cleanup; `UserMfaTotpCredential`/`UserMfaTotpRecoveryCode` lifecycle.
- **BillingModule** (`src/modules/billing/`): `BillingAccount`/`BillingPlanVersion`/`BillingPlanAssignment`/`BillingUsageEvent`/`BillingInvoice`/`BillingInvoiceLine`/`BillingReconciliationRun`; `BillingEntitlementService` reads plan entitlements; `InvoiceSettlementService` uses raw `$queryRaw ... FOR UPDATE` locks + CAS `updateMany` on `billing_invoices`/`billing_payment_attempts`.
- **StripeModule** (`src/modules/billing/stripe/`): `BillingPaymentAttempt` create/update, `StripeWebhookEvent` dedupe, `BillingAccount.stripeCustomerId`, invoice settlement.
- **USDC onchain** (`src/modules/billing/onchain/usdc-payment.service.ts`): `BillingPaymentAttempt` quote/claim lifecycle (evidence uniqueness, provider-identity fail-closed, lowercase tx hashes), `BillingAccount`/`BillingInvoice`/`UserWallet` reads.
- **Frontend**: Indirect only — the React SPA consumes data through backend APIs; no direct Prisma access.