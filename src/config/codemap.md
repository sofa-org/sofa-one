# Code Map for /src/config

## Responsibility
Centralized, environment-backed application configuration for the SOFA ONE backend. This directory owns two concerns: (1) mapping `process.env` into a typed, nested config object consumed via NestJS `ConfigService`, and (2) fail-fast runtime validation of that environment before the app boots. It is the single source of truth for what env vars exist, their defaults, and their constraints.

## Files

### `configuration.ts`
- **Symbols**: `default` (default export) — a factory function `() => ({ ... })` returning the nested config object.
- **Input**: `process.env` (read directly at call time).
- **Output**: A plain object with the following shape (keys consumed via `ConfigService.get('...')`):
  - `port` (number, default `3001`), `nodeEnv` (string, default `'development'`)
  - `openfort`: `{ apiKey, publishableKey, walletSecret, timeoutMs }` (timeoutMs default `15000`)
  - `pimlico`: `{ apiKey, rpcUrls: { 143, 10143 } }`
  - `database`: `{ url }`
  - `stripe`: `{ secretKey, webhookSecret, successUrl, cancelUrl }`
  - `billing.usdc`: `{ enabled, treasuryAddresses: { 1, 11155111, 8453, 84532 }, rpcUrls: { 1, 11155111, 8453, 84532 }, requiredConfirmations (default 5), quoteTtlSeconds (default 86400) }`
  - `security`: `{ trustProxy }`
  - `chain`: `{ defaultChainId }` (default `84532`)
  - `redis`: `{ url }`
- **Dependencies**: none (pure `process.env` reads). Note: `pimlico.rpcUrls` keys are Monad chain IDs (143, 10143); `billing.usdc` keys are USDC billing chain IDs (1, 11155111, 8453, 84532).

### `env.validation.ts`
- **Symbols**:
  - `enum Environment` — `Development | Production | Test`.
  - `class EnvironmentVariables` — class-validator schema; every field is a decorated env var (see below).
  - `validate(config: Record<string, unknown>)` — exported entry point; transforms raw env into `EnvironmentVariables`, runs `validateSync`, then calls the private validators; returns the validated instance.
  - Private helpers: `validateProductionConfig`, `validateOptionalHttpsUrl`, `validateDefaultChain`, `validateMfaSecretEncryptionKey`, `validateStripeConfig`, `validateUsdcConfig`, `validateEthereumAddress`, `validateRpcUrl`.
  - Private constants: `USDC_BILLING_CHAINS` (1 + 11155111 + 8453 + 84532 with their treasury/RPC keys), `EVM_ADDRESS_REGEX` (`/^0x[0-9a-fA-F]{40}$/`), `ZERO_ADDRESS`.
- **Input**: raw `process.env` record (passed by `ConfigModule.forRoot({ validate })`).
- **Output**: validated `EnvironmentVariables` instance, or throws `Error` on any failure (aborts startup).
- **Validation rules**:
  - Required (non-empty): `OPENFORT_API_KEY`, `OPENFORT_WALLET_SECRET`, `DATABASE_URL`, `MFA_SECRET_ENCRYPTION_KEY` (must be 32 base64-encoded bytes).
  - `NODE_ENV` must be a valid `Environment` value; `PORT` numeric (default 3001); `OPENFORT_TIMEOUT_MS` int 1–120000; `BILLING_USDC_REQUIRED_CONFIRMATIONS` int 5–100 (default 5); `BILLING_USDC_QUOTE_TTL_SECONDS` int 1–604800 (default 86400).
  - Production-only: `CORS_ORIGIN` must be set.
  - Optional HTTPS URLs (validated whenever provided): `SECURITY_EVENTS_SIEM_WEBHOOK_URL`, `STEP_UP_OTP_WEBHOOK_URL`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, and USDC RPC URLs.
  - `DEFAULT_CHAIN_ID` must be an integer in `SUPPORTED_CHAIN_IDS` (default `84532`).
  - Stripe: if `STRIPE_SECRET_KEY` is set, `STRIPE_SUCCESS_URL` and `STRIPE_CANCEL_URL` are required.
  - USDC billing: treasury addresses format-validated (EVM 0x + 40 hex, never zero address) and RPC URLs HTTPS-validated whenever provided; when `BILLING_USDC_ENABLED === 'true'`, all four chains' treasury + RPC become required.
- **Dependencies**: `class-transformer` (`plainToInstance`), `class-validator` (decorators + `validateSync`), and `SUPPORTED_CHAIN_IDS` from `../common/chains/supported-chains`.

## Design/Patterns
- **Config factory pattern**: `configuration.ts` exports a plain factory consumed by NestJS `ConfigModule.forRoot({ load: [configuration] })`, producing a namespaced config tree.
- **Schema-based validation**: `env.validation.ts` uses class-validator decorators on an `EnvironmentVariables` class plus `validateSync` for fail-fast, synchronous validation at bootstrap.
- **Fail-closed / optional-feature gating**: optional integrations (Stripe, USDC billing, SIEM/step-up webhooks) are validated whenever their values are present, but only required when their feature flag is enabled — so the app boots without them.
- **Defense in depth**: format validation (EVM address, HTTPS URL) runs even for disabled features so a misconfigured value never silently passes.

## Flow
1. `AppModule` calls `ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate })`.
2. NestJS invokes `validate(process.env)` → `plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true })` → `validateSync(...)`.
3. On any decorator error, `validate` throws (startup aborts). Otherwise it runs the private validators (production CORS, HTTPS URLs, default chain, MFA key, Stripe, USDC).
4. NestJS then calls the `configuration` factory to build the nested config object.
5. Guards/services read values at runtime via `ConfigService.get('openfort.apiKey')`, `ConfigService.get('billing.usdc.rpcUrls.84532')`, etc.

## Integration
- **Consumed by**: `AppModule` (`src/app.module.ts`) via `ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate })` — global, so `ConfigService` is injectable app-wide.
- **Downstream consumers** (via `ConfigService`): guards and services across modules, e.g. `src/common/throttler/throttler.module.ts` (imports `ConfigModule`), billing onchain services reading `billing.usdc.*` (e.g. `usdc-receipt.provider.ts`, `usdc.constants.ts`), Stripe payment service reading `stripe.*` success/cancel URLs, and security/step-up webhook config.
- **External dependency**: `SUPPORTED_CHAIN_IDS` from `src/common/chains/supported-chains.ts` (used to validate `DEFAULT_CHAIN_ID`).
- **Not part of the public API**: this directory is backend-only; no frontend or `openapi.yaml` exposure.
