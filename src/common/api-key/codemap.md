# src/common/api-key/

## Responsibility

Centralizes the API-key prefix/lookup-prefix derivation logic shared across the backend. It owns the single source of truth for how a raw API key string is truncated into the stable lookup prefix stored on `ApiKey.keyPrefix`, and how that prefix is used to find candidate key records during authentication.

This folder is deliberately small and dependency-free: it exposes pure, synchronous string helpers with no I/O, no Prisma, and no NestJS imports. All key material handling (generation, hashing, storage) lives elsewhere; this module only deals with the prefix portion of the key.

## Design/Patterns

- **Pure utility module**: exports constants and pure functions only. No classes, no DI, no side effects — trivially unit-testable and safe to import from guards and services.
- **Single source of truth for prefix lengths**: `API_KEY_PREFIX_LENGTH` (27 = `"sk_"` + 24 hex chars, a 96-bit lookup prefix) and `LEGACY_API_KEY_PREFIX_LENGTH` (11 = `"sk_"` + 8 hex chars) are the canonical constants. Consumers import these rather than hardcoding lengths.
- **Deduplication via `Set`**: `getApiKeyLookupPrefixes` returns both the modern and legacy prefixes, deduplicated so a single candidate set is produced even when the two lengths coincide (e.g. short keys).
- **Backward compatibility**: the legacy prefix is always included in lookup candidates so older keys (created before the 27-char prefix) remain authenticatable.

## Flow

1. **Key generation** (`src/modules/api-key/api-key.service.ts` → `generateKeyMaterial`): a raw key `sk_<64 hex>` is produced; `getApiKeyPrefix(rawKey)` truncates it to the first 27 chars, which is stored as `ApiKey.keyPrefix` alongside the Argon2id hash of the full raw key.
2. **Authentication lookup** (`src/common/guards/api-key-auth.guard.ts` and `src/common/guards/either-auth.guard.ts` → `authenticateWithApiKey`): the presented API key is passed to `getApiKeyLookupPrefixes(apiKey)`, yielding the modern + legacy prefix candidates. These are used in a Prisma `findMany` with `keyPrefix: { in: prefixes }` to fetch candidate `ApiKey` records (filtered to non-revoked, non-expired, with `user` included). The full presented key is then verified against each candidate's Argon2id hash.

## Integration

- **`src/modules/api-key/api-key.service.ts`**: imports `getApiKeyPrefix` to derive the stored `keyPrefix` during key creation.
- **`src/common/guards/api-key-auth.guard.ts`**: imports `getApiKeyLookupPrefixes` to build the candidate-prefix set for API-key authentication.
- **`src/common/guards/either-auth.guard.ts`**: imports `getApiKeyLookupPrefixes` for the combined API-key-or-IAM-token auth path.
- **`src/modules/api-key/api-key.service.spec.ts`**, **`src/common/guards/api-key-auth.guard.spec.ts`**, **`src/common/guards/either-auth.guard.spec.ts`**: import `API_KEY_PREFIX_LENGTH` to assert generated/derived prefixes (tests, not part of this module's production surface).
- **Data model coupling**: the 27-char prefix is what is persisted on `ApiKey.keyPrefix`; the prefix-collision and legacy-prefix handling described in AGENTS.md is implemented here and consumed by the guards' `findMany` lookup.

## Key Symbols

- `API_KEY_PREFIX_LENGTH` (const, 27) — modern lookup-prefix length.
- `LEGACY_API_KEY_PREFIX_LENGTH` (const, 11) — legacy lookup-prefix length.
- `getApiKeyPrefix(apiKey: string): string` — returns the first 27 chars of a key (used at creation time).
- `getApiKeyLookupPrefixes(apiKey: string): string[]` — returns deduplicated `[modern, legacy]` prefix candidates (used at auth time).
