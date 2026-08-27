# Code Map for /src/common/utils

## Responsibility
Pure, dependency-light helper functions shared across backend modules: IP/CIDR allowlist matching, stable request hashing for idempotency, and error-message sanitization for safe API/audit output. No NestJS decorators, no I/O, no state.

## Files

### `ip-cidr.ts`
- **Responsibility**: Determine whether a client IP is allowed by an allowlist of exact IPs and/or CIDR ranges; validate that a string is a well-formed IP or CIDR.
- **Exports**:
  - `isIpAllowed(ip: string, allowedEntries: string[]): boolean` — returns `true` if `ip` matches any entry exactly (same version + value) or falls within any CIDR entry; `false` for unparseable IPs or empty allowlists.
  - `isIpOrCidr(value: string): boolean` — validation predicate; `true` for a valid IP (v4/v6) or a valid `network/prefix` CIDR.
- **Internal symbols**: `ParsedIp` type (`{ version: 4 | 6; value: bigint }`), `parseIp`, `isIpInCidr`, `isValidCidr`, `ipv4ToNumber`, `ipv6ToBigInt`, `normalizeIpv4EmbeddedIpv6`, `splitIpv6Groups`.
- **Inputs/Outputs**: IPs and CIDRs are strings; matching is version-aware (a v4 IP never matches a v6 CIDR and vice versa). IPv6 parsing handles `::` compression and IPv4-embedded IPv6 (`::ffff:1.2.3.4`); zone IDs (`%`) are rejected. Prefix bounds are 0–32 (v4) and 0–128 (v6); malformed prefixes/entries return `false`.
- **Dependencies**: Node `net.isIP` only. No external packages.

### `request-hash.ts`
- **Responsibility**: Produce a deterministic SHA-256 hex digest of an arbitrary request payload for idempotency keys and audit hashes.
- **Exports**:
  - `hashRequest(value: unknown): string` — canonicalizes `value` (recursively sorts object keys, preserves arrays) then SHA-256 hashes `JSON.stringify` of the stable form.
- **Internal symbols**: `stable(value: unknown): unknown` — deep key-sorted normalization; arrays are mapped element-wise, objects are rebuilt with sorted keys, primitives pass through.
- **Inputs/Outputs**: Accepts any JSON-serializable value (objects, arrays, primitives, `null`); returns a 64-char lowercase hex string. Key order and nested key order do not affect the hash; array order does. `undefined` serializes to the literal string `'undefined'`.
- **Dependencies**: Node `crypto.createHash` only.

### `sanitize.ts`
- **Responsibility**: Redact internal details from error messages before they reach API consumers, logs, or SIEM exports; extract human-readable text from unknown thrown values.
- **Exports**:
  - `sanitizeErrorMessage(message: string, maxLength: number = 500): string` — applies regex redactions in order: long hex values (`0x` + 16+ hex chars → `[hex]`), internal URLs (`http(s)://...` → `[url]`), absolute file paths (Unix and Windows → `[path]`), stack-trace lines (`at ...` removed), then collapses whitespace, trims, and truncates to `maxLength`.
  - `getErrorText(error: unknown): string` — extracts error text from an unknown value: returns strings as-is, otherwise concatenates `shortMessage`, `message`, and `details` fields (plus the same fields from a one-level-deep `cause`), joined by spaces; returns `''` for `null`/`undefined`/empty.
- **Inputs/Outputs**: `sanitizeErrorMessage` takes a string and optional max length (default 500), returns a redacted/truncated string. `getErrorText` takes any thrown value and returns a plain string suitable for sanitization.
- **Dependencies**: None (pure regex/string logic).

## Design/Patterns
- Pure utility functions with no NestJS coupling — imported directly by services, guards, filters, and DTO validators.
- Fail-closed matching: `isIpAllowed` returns `false` for unparseable input, and `isIpOrCidr` rejects malformed CIDRs, so allowlist enforcement never accidentally permits an invalid entry.
- Canonicalization-before-hash (`stable`) makes `hashRequest` order-insensitive for object keys, enabling stable idempotency keys across differently-ordered payloads.
- Defense-in-depth redaction: `sanitizeErrorMessage` is applied at multiple layers (global exception filter, service error paths, SIEM export) so internal details are stripped even if an error propagates through several boundaries.

## Flow
- **IP allowlist**: `ApiKeyAuthGuard` / `EitherAuthGuard` / `EoaExecutionPolicyService` → `IpAllowlistService.assertIpAllowed` / `isIpAllowed` → `isIpAllowed` (utils) → boolean; rejections are recorded as `api_key.ip_rejected` `SecurityEvent` rows. `CreateApiKeyDto` uses `isIpOrCidr` inside a `@ValidatorConstraint` to validate `ipAllowlist` entries at API-key creation time.
- **Idempotency/audit hashing**: `WalletService` (withdraw/sign paths) and `TransactionsService` (send path) call `hashRequest` on request payloads to produce `requestHash` / `interactionsHash` stored on `Transaction` rows and used for idempotency lookups.
- **Error sanitization**: thrown errors → `getErrorText` (e.g. `TransactionSimulationService` for `eth_call` preflight reasons) → `sanitizeErrorMessage` → safe message stored in `SecurityEvent` metadata or returned to clients. The global `HttpExceptionFilter` sanitizes every exception message before it is serialized into the HTTP response; `OpenfortService` and `BillingReconciliationService` sanitize error details before logging/persisting.

## Integration
- **Consumers**:
  - `ip-cidr.ts` → `src/common/guards/ip-allowlist.service.ts`, `src/modules/api-key/dto/create-api-key.dto.ts`.
  - `request-hash.ts` → `src/modules/wallet/wallet.service.ts`, `src/modules/transactions/transactions.service.ts`.
  - `sanitize.ts` → `src/common/filters/http-exception.filter.ts`, `src/core/openfort/openfort.service.ts`, `src/modules/transactions/transactions.service.ts`, `src/modules/transactions/transaction-simulation.service.ts`, `src/modules/security-events/security-event-export.service.ts`, `src/modules/billing/billing-reconciliation.service.ts`.
- **Dependencies**: Node built-ins only (`net`, `crypto`); no Prisma, ConfigService, or Openfort coupling.
- **Tests**: co-located `*.spec.ts` files (`ip-cidr.spec.ts`, `request-hash.spec.ts`, `sanitize.spec.ts`) cover matching, hashing determinism, and redaction behavior.