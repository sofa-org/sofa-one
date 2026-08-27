/**
 * USDC on-chain billing constants (Phase 3B Phase 2).
 *
 * The USDC billing chain allowlist is fixed to Base (8453) and Base Sepolia
 * (84532). Per-chain treasury addresses and RPC URLs are environment
 * configuration (`billing.usdc.*`); a chain is only usable when both are
 * configured. Canonical token addresses are derived at runtime from the
 * existing `SUPPORTED_CHAINS` registry — never from the client.
 */
export const USDC_RECEIPT_PROVIDER = Symbol('USDC_RECEIPT_PROVIDER');

/** ERC-20 `Transfer(address,address,uint256)` topic0. */
export const USDC_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** USDC uses six decimals; invoice micros map 1:1 to USDC base units. */
export const USDC_DECIMALS = 6;

/** The only chains USDC invoice payments are allowed on. */
export const USDC_BILLING_CHAIN_IDS = [8453, 84532] as const;
export type UsdcBillingChainId = (typeof USDC_BILLING_CHAIN_IDS)[number];

/** A uint256 amount is exactly 32 bytes (64 hex chars) after the 0x prefix. */
export const UINT256_DATA_REGEX = /^0x[0-9a-fA-F]{64}$/;

/** An indexed address topic is exactly 32 bytes (64 hex chars) after 0x. */
export const INDEXED_ADDRESS_REGEX = /^0x[0-9a-fA-F]{64}$/;

/** A token/treasury contract address is exactly 20 bytes (40 hex chars). */
export const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
