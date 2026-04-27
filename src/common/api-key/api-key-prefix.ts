export const API_KEY_PREFIX_LENGTH = 27; // "sk_" + 24 hex chars (96-bit lookup prefix)
export const LEGACY_API_KEY_PREFIX_LENGTH = 11; // "sk_" + 8 hex chars

export function getApiKeyPrefix(apiKey: string): string {
  return apiKey.substring(0, API_KEY_PREFIX_LENGTH);
}

export function getApiKeyLookupPrefixes(apiKey: string): string[] {
  return Array.from(
    new Set([
      apiKey.substring(0, API_KEY_PREFIX_LENGTH),
      apiKey.substring(0, LEGACY_API_KEY_PREFIX_LENGTH),
    ]),
  );
}
