/**
 * Chain-scoped ERC-4626 vault addresses trusted for static deposit/mint/redeem/withdraw
 * classification when receiver/owner arguments equal the execution owner.
 *
 * Only vaults listed here may be retained. Unknown vault addresses stay unknown
 * (no bytecode lookup). Entries are lowercase hex; comparison is case-insensitive.
 *
 * Curated well-known vaults + a Base Sepolia fixture address used by unit tests
 * (0x4626…4626) — not a live mainnet claim for that fixture.
 */
export const ERC4626_VAULTS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  // Ethereum — sDAI (Spark) as a well-known ERC-4626 example
  1: Object.freeze([
    '0x83f20f44975d03b1b09e64809b757c47f942beea', // sDAI
  ]),
  // Base mainnet — reserved empty until product curates official vaults
  8453: Object.freeze([] as string[]),
  // Base Sepolia — test fixture vault only (policy unit tests)
  84532: Object.freeze([
    '0x4626462646264626462646264626462646264626',
  ]),
  11155111: Object.freeze([] as string[]),
  10: Object.freeze([] as string[]),
  42161: Object.freeze([] as string[]),
  137: Object.freeze([] as string[]),
} as const);
