import { decodeFunctionData, getAddress, isAddress, type Abi, type Hex } from 'viem';
import { ERC4626_VAULTS } from './asset-flow-rules/erc4626-vaults';
import { TRUSTED_SPENDERS } from './asset-flow-rules/trusted-spenders';
import { SUPPORTED_CHAINS_WETH } from './asset-flow-rules/weth-addresses';

/**
 * Batch-level (and per-interaction) asset-flow classification.
 *
 * - `external_transfer` — decoded standard transfer / protocol call sends assets to a
 *   non-owner recipient (or plain native value to a non-owner). Caller should refuse.
 * - `retained_protocol` — every interaction is proven to have no external asset outflow
 *   (plain native value to the trusted owner, or an explicit audited protocol rule with
 *   known official target addresses). Standard ERC transfer selectors alone never prove
 *   retention: the called contract is not verified as a real token.
 * - `unknown` — anything not fully decoded / not proven retained (empty zero-value calls,
 *   transfer-to-owner on arbitrary targets, approve, permit, multicall/router, truncated
 *   calldata, unknown selectors, unpaid protocol calls, …).
 *
 * Batch fold (conservative): any external wins; else any unknown wins; else retained.
 * Callers classify the full batch first and do not filter “dangerous” interactions away.
 */
export type AssetFlowClassification = 'external_transfer' | 'retained_protocol' | 'unknown';

/** Interaction shape compatible with SendTransactionDto.interactions (value = decimal wei). */
export type AssetFlowInteractionInput = {
  to: string;
  data: string;
  value?: string;
};

export type ClassifyTransactionAssetFlowInput = {
  interactions: AssetFlowInteractionInput[];
  /**
   * Trusted owner of the executing wallet:
   * - session_key → UserWallet.walletAddress
   * - eoa → UserWallet.agentWalletAddress
   */
  ownerAddress: string;
  /** Chain id for chain-scoped protocol address registries. */
  chainId: number;
};

export type AssetFlowInteractionClassification = {
  index: number;
  classification: AssetFlowClassification;
  /** Stable machine-oriented rule id for logs / policy metadata. */
  rule: string;
  selector: string | null;
  /** Decoded primary recipient when known (token `to` or native `interaction.to`). */
  recipient: string | null;
};

export type AssetFlowBatchClassification = {
  classification: AssetFlowClassification;
  /** Rule that decided the batch (first external, else first unknown, else first retained). */
  rule: string;
  /** Interaction index that decided the batch classification. */
  decisiveIndex: number | null;
  interactions: AssetFlowInteractionClassification[];
};

const ZERO = 0n;

// ── Standard token transfer ABIs ─────────────────────────────────────────────

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const ERC20_ERC721_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amountOrTokenId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const ERC721_SAFE_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const ERC721_SAFE_TRANSFER_FROM_DATA_ABI = [
  {
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const ERC1155_SAFE_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'id', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const ERC1155_SAFE_BATCH_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'safeBatchTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'ids', type: 'uint256[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// ── Aave V3 Pool ABIs (direct methods only) ──────────────────────────────────
// Sources:
// - https://aave.com/docs/resources/addresses
// - https://github.com/aave/aave-v3-core

const AAVE_V3_SUPPLY_ABI = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const AAVE_V3_SUPPLY_WITH_PERMIT_ABI = [
  {
    type: 'function',
    name: 'supplyWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'deadline', type: 'uint256' },
      { name: 'permitV', type: 'uint8' },
      { name: 'permitR', type: 'bytes32' },
      { name: 'permitS', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const AAVE_V3_WITHDRAW_ABI = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

/** Official Aave V3 Pool per chain. Omits 80002/97/10143 (unsupported / no official entry). */
const AAVE_V3_POOL_BY_CHAIN: Readonly<Record<number, string>> = Object.freeze({
  // https://aave.com/docs/resources/addresses
  1: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Ethereum
  10: '0x794a61358d6845594f94dc1db02a252b5b4814ad', // Optimism
  56: '0x6807dc923806fe8fd134338eabca509979a7e0cb', // BNB
  137: '0x794a61358d6845594f94dc1db02a252b5b4814ad', // Polygon
  143: '0x69a5f9ad4f96ebf0a0c792dd42a01cc5c0102fef', // Monad
  8453: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', // Base
  42161: '0x794a61358d6845594f94dc1db02a252b5b4814ad', // Arbitrum
  84532: '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27', // Base Sepolia
  11155111: '0x6ae43d3271ff6888e7fc43fd7321a503ff738951', // Sepolia
  11155420: '0xb50201558b00496a145fe76f7424749556e326d8', // OP Sepolia
});

const AAVE_V3_SUPPLY_SELECTOR = '0x617ba037';
const AAVE_V3_SUPPLY_WITH_PERMIT_SELECTOR = '0x02c205f0';
const AAVE_V3_WITHDRAW_SELECTOR = '0x69328dec';
/** setUserUseReserveAsCollateral(address,bool) — keccak4 verified. */
const AAVE_V3_SET_USER_USE_RESERVE_AS_COLLATERAL_SELECTOR = '0x5a3b74b9';

const AAVE_V3_SET_USER_USE_RESERVE_AS_COLLATERAL_ABI = [
  {
    type: 'function',
    name: 'setUserUseReserveAsCollateral',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'useAsCollateral', type: 'bool' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// ── WETH9 wrap / unwrap ─────────────────────────────────────────────────────

const WETH_DEPOSIT_SELECTOR = '0xd0e30db0';
const WETH_WITHDRAW_SELECTOR = '0x2e1a7d4d';

const WETH_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

const WETH_WITHDRAW_ABI = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const satisfies Abi;

// ── ERC-20 / NFT authorization (revoke-only path) ───────────────────────────

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const NFT_SET_APPROVAL_FOR_ALL_ABI = [
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// ── ERC-4626 vault (EIP-4626 selectors) ─────────────────────────────────────

const ERC4626_DEPOSIT_SELECTOR = '0x6e553f65'; // deposit(uint256,address)
const ERC4626_MINT_SELECTOR = '0x94bf804d'; // mint(uint256,address)
const ERC4626_REDEEM_SELECTOR = '0xba087652'; // redeem(uint256,address,address)
const ERC4626_WITHDRAW_SELECTOR = '0xb460af94'; // withdraw(uint256,address,address)

const ERC4626_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const satisfies Abi;

const ERC4626_MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const satisfies Abi;

const ERC4626_REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const satisfies Abi;

const ERC4626_WITHDRAW_ABI = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const satisfies Abi;

// ── Uniswap V3 SwapRouter02 ABIs (direct swap methods only; no multicall) ────
// Sources:
// - https://docs.uniswap.org/contracts/v3/reference/deployments/
// - SwapRouter02 Exact* params omit deadline (unlike legacy SwapRouter)

const UNI_V3_EXACT_INPUT_SINGLE_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const satisfies Abi;

const UNI_V3_EXACT_INPUT_ABI = [
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const satisfies Abi;

const UNI_V3_EXACT_OUTPUT_SINGLE_ABI = [
  {
    type: 'function',
    name: 'exactOutputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountOut', type: 'uint256' },
          { name: 'amountInMaximum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
] as const satisfies Abi;

const UNI_V3_EXACT_OUTPUT_ABI = [
  {
    type: 'function',
    name: 'exactOutput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountOut', type: 'uint256' },
          { name: 'amountInMaximum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
] as const satisfies Abi;

/**
 * Official Uniswap V3 SwapRouter02 per chain.
 * Chain 10143 omitted: research address was 39 hex chars (invalid); do not guess.
 */
const UNI_V3_SWAP_ROUTER02_BY_CHAIN: Readonly<Record<number, string>> = Object.freeze({
  // https://docs.uniswap.org/contracts/v3/reference/deployments/
  1: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  10: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  56: '0xb971ef87ede563556b2ed4b1c0b0019111dd85d2',
  137: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  143: '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900',
  8453: '0x2626664c2603336e57b271c5c0b26f421741e481',
  42161: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  84532: '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
  11155111: '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e',
  11155420: '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
});

const UNI_V3_DIRECT_SWAP: Record<string, { kind: string; abi: Abi }> = {
  '0x04e45aaf': { kind: 'exact_input_single', abi: UNI_V3_EXACT_INPUT_SINGLE_ABI },
  '0xb858183f': { kind: 'exact_input', abi: UNI_V3_EXACT_INPUT_ABI },
  '0x5023b4df': { kind: 'exact_output_single', abi: UNI_V3_EXACT_OUTPUT_SINGLE_ABI },
  '0x09b81346': { kind: 'exact_output', abi: UNI_V3_EXACT_OUTPUT_ABI },
};

// ── Uniswap V2 Router02 ABIs ─────────────────────────────────────────────────
// Sources:
// - https://docs.uniswap.org/contracts/v2/reference/smart-contracts/router-02
// - chain deployments from official Uniswap / community docs used in product research

const UNI_V2_SWAP_EXACT_TOKENS_FOR_TOKENS_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_TOKENS_FOR_EXACT_TOKENS_ABI = [
  {
    type: 'function',
    name: 'swapTokensForExactTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'amountInMax', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_EXACT_ETH_FOR_TOKENS_ABI = [
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_TOKENS_FOR_EXACT_ETH_ABI = [
  {
    type: 'function',
    name: 'swapTokensForExactETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'amountInMax', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_EXACT_TOKENS_FOR_ETH_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_ETH_FOR_EXACT_TOKENS_ABI = [
  {
    type: 'function',
    name: 'swapETHForExactTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_EXACT_TOKENS_FOR_TOKENS_SUPPORTING_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_EXACT_ETH_FOR_TOKENS_SUPPORTING_ABI = [
  {
    type: 'function',
    name: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const UNI_V2_SWAP_EXACT_TOKENS_FOR_ETH_SUPPORTING_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const UNI_V2_ROUTER02_BY_CHAIN: Readonly<Record<number, string>> = Object.freeze({
  // https://docs.uniswap.org/contracts/v2/reference/smart-contracts/router-02 (Ethereum)
  // + official/per-chain Router02 deployments from Uniswap deployment docs
  1: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  10: '0x4a7b5da61326a6379179b40d00f57e5bbdc962c2',
  56: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  137: '0xedf6066a2b290c185783862c7f4776a2c8077ad1',
  8453: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  42161: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  84532: '0x1689e7b1f10000ae47ebfe339a4f69decd19f602',
  11155111: '0xee567fe1712faf6149d80da1e6934e354124cfe3',
});

type UniV2SwapMeta = {
  kind: string;
  abi: Abi;
  /** When true, native value may be non-zero (ETH-in). Token-in requires value === 0. */
  allowsNativeValue: boolean;
  /** Index of the `to` recipient argument. */
  recipientArgIndex: number;
};

const UNI_V2_DIRECT_SWAP: Record<string, UniV2SwapMeta> = {
  '0x38ed1739': {
    kind: 'swap_exact_tokens_for_tokens',
    abi: UNI_V2_SWAP_EXACT_TOKENS_FOR_TOKENS_ABI,
    allowsNativeValue: false,
    recipientArgIndex: 3,
  },
  '0x7ff36ab5': {
    kind: 'swap_exact_eth_for_tokens',
    abi: UNI_V2_SWAP_EXACT_ETH_FOR_TOKENS_ABI,
    allowsNativeValue: true,
    recipientArgIndex: 2,
  },
  '0x18cbafe5': {
    kind: 'swap_exact_tokens_for_eth',
    abi: UNI_V2_SWAP_EXACT_TOKENS_FOR_ETH_ABI,
    allowsNativeValue: false,
    recipientArgIndex: 3,
  },
  '0x8803dbee': {
    kind: 'swap_tokens_for_exact_tokens',
    abi: UNI_V2_SWAP_TOKENS_FOR_EXACT_TOKENS_ABI,
    allowsNativeValue: false,
    recipientArgIndex: 3,
  },
  '0x4a25d94a': {
    kind: 'swap_tokens_for_exact_eth',
    abi: UNI_V2_SWAP_TOKENS_FOR_EXACT_ETH_ABI,
    allowsNativeValue: false,
    recipientArgIndex: 3,
  },
  '0xfb3bdb41': {
    kind: 'swap_eth_for_exact_tokens',
    abi: UNI_V2_SWAP_ETH_FOR_EXACT_TOKENS_ABI,
    allowsNativeValue: true,
    recipientArgIndex: 2,
  },
  '0x5c11d795': {
    kind: 'swap_exact_tokens_for_tokens_supporting_fee',
    abi: UNI_V2_SWAP_EXACT_TOKENS_FOR_TOKENS_SUPPORTING_ABI,
    allowsNativeValue: false,
    recipientArgIndex: 3,
  },
  '0xb6f9de95': {
    kind: 'swap_exact_eth_for_tokens_supporting_fee',
    abi: UNI_V2_SWAP_EXACT_ETH_FOR_TOKENS_SUPPORTING_ABI,
    allowsNativeValue: true,
    recipientArgIndex: 2,
  },
  '0x791ac947': {
    kind: 'swap_exact_tokens_for_eth_supporting_fee',
    abi: UNI_V2_SWAP_EXACT_TOKENS_FOR_ETH_SUPPORTING_ABI,
    allowsNativeValue: false,
    recipientArgIndex: 3,
  },
};

/** Well-known selectors that grant spend authority — never treated as retained. */
const AUTHORIZATION_SELECTORS = new Set<string>([
  '0x095ea7b3', // approve(address,uint256)
  '0xa22cb465', // setApprovalForAll(address,bool)
  '0xd505accf', // ERC-2612 permit
  '0x8fcbaf0c', // DAI-style permit
  '0x2b67b570', // Permit2 permit(address,PermitSingle,bytes)
  '0xb7f13ed4', // Permit2 compact/single
  '0x002a3e3a', // Permit2 permitBatch
]);

const SELECTOR_RULE: Record<string, string> = {
  '0x095ea7b3': 'erc20_approve',
  '0xa22cb465': 'nft_set_approval_for_all',
  '0xd505accf': 'permit_erc2612',
  '0x8fcbaf0c': 'permit_dai',
  '0x2b67b570': 'permit2_single',
  '0xb7f13ed4': 'permit2_compact',
  '0x002a3e3a': 'permit2_batch',
};

type StandardTransferKind =
  | 'erc20_transfer'
  | 'erc20_erc721_transfer_from'
  | 'erc721_safe_transfer_from'
  | 'erc721_safe_transfer_from_data'
  | 'erc1155_safe_transfer_from'
  | 'erc1155_safe_batch_transfer_from';

const STANDARD_TRANSFER_BY_SELECTOR: Record<string, { kind: StandardTransferKind; abi: Abi }> = {
  '0xa9059cbb': { kind: 'erc20_transfer', abi: ERC20_TRANSFER_ABI },
  '0x23b872dd': {
    kind: 'erc20_erc721_transfer_from',
    abi: ERC20_ERC721_TRANSFER_FROM_ABI,
  },
  '0x42842e0e': {
    kind: 'erc721_safe_transfer_from',
    abi: ERC721_SAFE_TRANSFER_FROM_ABI,
  },
  '0xb88d4fde': {
    kind: 'erc721_safe_transfer_from_data',
    abi: ERC721_SAFE_TRANSFER_FROM_DATA_ABI,
  },
  '0xf242432a': {
    kind: 'erc1155_safe_transfer_from',
    abi: ERC1155_SAFE_TRANSFER_FROM_ABI,
  },
  '0x2eb2c2d6': {
    kind: 'erc1155_safe_batch_transfer_from',
    abi: ERC1155_SAFE_BATCH_TRANSFER_FROM_ABI,
  },
};

/**
 * Result of an audited protocol rule.
 * - retained / external: rule fully applied (including wrong-recipient external)
 * - unknown: known protocol target+selector but calldata could not be proven safe
 * - null from match(): rule does not apply (wrong chain/target/selector)
 */
export type ProtocolRuleClassification = {
  classification: AssetFlowClassification;
  rule: string;
  recipient: string | null;
};

export type RetainedProtocolRuleMatch = ProtocolRuleClassification;

export type RetainedProtocolRule = {
  /** Stable rule family id, e.g. `aave_v3_pool`. */
  id: string;
  /**
   * Return a classification only when this rule owns the call (correct chain target +
   * known selector). Must validate addresses and decoded recipients fully.
   * Return null when the rule does not apply so other rules / generic fallbacks run.
   */
  match: (input: {
    chainId: number;
    owner: string;
    to: string;
    selector: string | null;
    data: string;
    value: bigint;
  }) => ProtocolRuleClassification | null;
};

function matchAaveV3Pool(input: {
  chainId: number;
  owner: string;
  to: string;
  selector: string | null;
  data: string;
  value: bigint;
}): ProtocolRuleClassification | null {
  if (!input.selector) return null;
  const pool = AAVE_V3_POOL_BY_CHAIN[input.chainId];
  if (!pool || !sameAddress(input.to, pool)) return null;

  if (input.selector === AAVE_V3_SUPPLY_SELECTOR) {
    return classifyAaveSupplyLike({
      ...input,
      abi: AAVE_V3_SUPPLY_ABI,
      rulePrefix: 'aave_v3_supply',
      onBehalfOfIndex: 2,
    });
  }
  if (input.selector === AAVE_V3_SUPPLY_WITH_PERMIT_SELECTOR) {
    return classifyAaveSupplyLike({
      ...input,
      abi: AAVE_V3_SUPPLY_WITH_PERMIT_ABI,
      rulePrefix: 'aave_v3_supply_with_permit',
      onBehalfOfIndex: 2,
    });
  }
  if (input.selector === AAVE_V3_WITHDRAW_SELECTOR) {
    return classifyAaveWithdraw(input);
  }
  if (input.selector === AAVE_V3_SET_USER_USE_RESERVE_AS_COLLATERAL_SELECTOR) {
    return classifyAaveSetUserUseReserveAsCollateral(input);
  }
  // Known official pool, but not a whitelisted method (borrow/flashLoan/etc.).
  return null;
}

function classifyAaveSetUserUseReserveAsCollateral(input: {
  owner: string;
  data: string;
  value: bigint;
}): ProtocolRuleClassification {
  if (input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: 'aave_v3_set_collateral_nonzero_value',
      recipient: null,
    };
  }
  try {
    const decoded = decodeFunctionData({
      abi: AAVE_V3_SET_USER_USE_RESERVE_AS_COLLATERAL_ABI,
      data: input.data as Hex,
    });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length < 2) {
      return {
        classification: 'unknown',
        rule: 'aave_v3_set_collateral_decode_failed',
        recipient: null,
      };
    }
    const useAsCollateral = args[1];
    if (typeof useAsCollateral !== 'boolean') {
      return {
        classification: 'unknown',
        rule: 'aave_v3_set_collateral_decode_failed',
        recipient: null,
      };
    }
    // Only disable-collateral is retained (revoke risk). Enabling is unknown.
    if (useAsCollateral === true) {
      return {
        classification: 'unknown',
        rule: 'aave_v3_set_collateral_enable',
        recipient: null,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: 'aave_v3_set_collateral_disable',
      recipient: input.owner,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: 'aave_v3_set_collateral_decode_failed',
      recipient: null,
    };
  }
}

function classifyAaveSupplyLike(input: {
  owner: string;
  data: string;
  value: bigint;
  abi: Abi;
  rulePrefix: string;
  onBehalfOfIndex: number;
}): ProtocolRuleClassification {
  if (input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: `${input.rulePrefix}_nonzero_value`,
      recipient: null,
    };
  }
  try {
    const decoded = decodeFunctionData({ abi: input.abi, data: input.data as Hex });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length <= input.onBehalfOfIndex) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_decode_failed`,
        recipient: null,
      };
    }
    const onBehalfOf = normalizeAddress(String(args[input.onBehalfOfIndex]));
    if (!onBehalfOf) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_invalid_on_behalf_of`,
        recipient: null,
      };
    }
    if (!sameAddress(onBehalfOf, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: `${input.rulePrefix}_external_on_behalf_of`,
        recipient: onBehalfOf,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: `${input.rulePrefix}_to_owner`,
      recipient: onBehalfOf,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: `${input.rulePrefix}_decode_failed`,
      recipient: null,
    };
  }
}

function classifyAaveWithdraw(input: {
  owner: string;
  data: string;
  value: bigint;
}): ProtocolRuleClassification {
  if (input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: 'aave_v3_withdraw_nonzero_value',
      recipient: null,
    };
  }
  try {
    const decoded = decodeFunctionData({
      abi: AAVE_V3_WITHDRAW_ABI,
      data: input.data as Hex,
    });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length < 3) {
      return {
        classification: 'unknown',
        rule: 'aave_v3_withdraw_decode_failed',
        recipient: null,
      };
    }
    const recipient = normalizeAddress(String(args[2]));
    if (!recipient) {
      return {
        classification: 'unknown',
        rule: 'aave_v3_withdraw_invalid_recipient',
        recipient: null,
      };
    }
    if (!sameAddress(recipient, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: 'aave_v3_withdraw_external',
        recipient,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: 'aave_v3_withdraw_to_owner',
      recipient,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: 'aave_v3_withdraw_decode_failed',
      recipient: null,
    };
  }
}

function matchUniswapV3SwapRouter02(input: {
  chainId: number;
  owner: string;
  to: string;
  selector: string | null;
  data: string;
  value: bigint;
}): ProtocolRuleClassification | null {
  if (!input.selector) return null;
  const router = UNI_V3_SWAP_ROUTER02_BY_CHAIN[input.chainId];
  if (!router || !sameAddress(input.to, router)) return null;

  const meta = UNI_V3_DIRECT_SWAP[input.selector];
  if (!meta) return null; // multicall / unwrap / etc. on router → fall through unknown

  // Direct V3 swaps must not carry native value (no ETH-in path in this whitelist).
  if (input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: `uni_v3_${meta.kind}_nonzero_value`,
      recipient: null,
    };
  }

  try {
    const decoded = decodeFunctionData({ abi: meta.abi, data: input.data as Hex });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length < 1) {
      return {
        classification: 'unknown',
        rule: `uni_v3_${meta.kind}_decode_failed`,
        recipient: null,
      };
    }
    const params = args[0] as { recipient?: unknown } | undefined;
    const recipient = normalizeAddress(
      params && typeof params === 'object' ? String(params.recipient) : '',
    );
    if (!recipient) {
      return {
        classification: 'unknown',
        rule: `uni_v3_${meta.kind}_invalid_recipient`,
        recipient: null,
      };
    }
    if (!sameAddress(recipient, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: `uni_v3_${meta.kind}_external`,
        recipient,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: `uni_v3_${meta.kind}_to_owner`,
      recipient,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: `uni_v3_${meta.kind}_decode_failed`,
      recipient: null,
    };
  }
}

function matchUniswapV2Router02(input: {
  chainId: number;
  owner: string;
  to: string;
  selector: string | null;
  data: string;
  value: bigint;
}): ProtocolRuleClassification | null {
  if (!input.selector) return null;
  const router = UNI_V2_ROUTER02_BY_CHAIN[input.chainId];
  if (!router || !sameAddress(input.to, router)) return null;

  const meta = UNI_V2_DIRECT_SWAP[input.selector];
  if (!meta) return null;

  // Token-in selectors must not carry native value; ETH-in may.
  if (!meta.allowsNativeValue && input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: `uni_v2_${meta.kind}_nonzero_value`,
      recipient: null,
    };
  }

  try {
    const decoded = decodeFunctionData({ abi: meta.abi, data: input.data as Hex });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length <= meta.recipientArgIndex) {
      return {
        classification: 'unknown',
        rule: `uni_v2_${meta.kind}_decode_failed`,
        recipient: null,
      };
    }
    const recipient = normalizeAddress(String(args[meta.recipientArgIndex]));
    if (!recipient) {
      return {
        classification: 'unknown',
        rule: `uni_v2_${meta.kind}_invalid_recipient`,
        recipient: null,
      };
    }
    if (!sameAddress(recipient, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: `uni_v2_${meta.kind}_external`,
        recipient,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: `uni_v2_${meta.kind}_to_owner`,
      recipient,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: `uni_v2_${meta.kind}_decode_failed`,
      recipient: null,
    };
  }
}

function matchWeth9(input: {
  chainId: number;
  owner: string;
  to: string;
  selector: string | null;
  data: string;
  value: bigint;
}): ProtocolRuleClassification | null {
  if (!input.selector) return null;
  const weth = SUPPORTED_CHAINS_WETH[input.chainId];
  if (!weth || !sameAddress(input.to, weth)) return null;

  if (input.selector === WETH_DEPOSIT_SELECTOR) {
    // deposit() is payable wrap: must carry native value > 0 and no extra calldata args.
    if (input.value <= ZERO) {
      return {
        classification: 'unknown',
        rule: 'weth_deposit_zero_value',
        recipient: null,
      };
    }
    // Strict: selector-only calldata (10 hex chars including 0x).
    if (input.data.length !== 10) {
      return {
        classification: 'unknown',
        rule: 'weth_deposit_extra_calldata',
        recipient: null,
      };
    }
    try {
      decodeFunctionData({ abi: WETH_DEPOSIT_ABI, data: input.data as Hex });
    } catch {
      return {
        classification: 'unknown',
        rule: 'weth_deposit_decode_failed',
        recipient: null,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: 'weth_deposit_wrap',
      recipient: input.owner,
    };
  }

  if (input.selector === WETH_WITHDRAW_SELECTOR) {
    if (input.value !== ZERO) {
      return {
        classification: 'unknown',
        rule: 'weth_withdraw_nonzero_value',
        recipient: null,
      };
    }
    try {
      const decoded = decodeFunctionData({
        abi: WETH_WITHDRAW_ABI,
        data: input.data as Hex,
      });
      const args = decoded.args;
      if (!Array.isArray(args) || args.length < 1) {
        return {
          classification: 'unknown',
          rule: 'weth_withdraw_decode_failed',
          recipient: null,
        };
      }
      const amount = args[0];
      if (typeof amount !== 'bigint' || amount <= ZERO) {
        return {
          classification: 'unknown',
          rule: 'weth_withdraw_invalid_amount',
          recipient: null,
        };
      }
      return {
        classification: 'retained_protocol',
        rule: 'weth_withdraw_unwrap',
        recipient: input.owner,
      };
    } catch {
      return {
        classification: 'unknown',
        rule: 'weth_withdraw_decode_failed',
        recipient: null,
      };
    }
  }

  return null;
}

function matchErc4626Vault(input: {
  chainId: number;
  owner: string;
  to: string;
  selector: string | null;
  data: string;
  value: bigint;
}): ProtocolRuleClassification | null {
  if (!input.selector) return null;
  const vaults = ERC4626_VAULTS[input.chainId];
  if (!vaults || vaults.length === 0) return null;
  if (!vaults.some((v) => sameAddress(input.to, v))) return null;

  // Native value on vault calls is not part of standard ERC-4626 share mint/burn here.
  if (input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: 'erc4626_nonzero_value',
      recipient: null,
    };
  }

  if (input.selector === ERC4626_DEPOSIT_SELECTOR) {
    return classifyErc4626ReceiverOnly({
      ...input,
      abi: ERC4626_DEPOSIT_ABI,
      rulePrefix: 'erc4626_deposit',
      amountIndex: 0,
      receiverIndex: 1,
    });
  }
  if (input.selector === ERC4626_MINT_SELECTOR) {
    return classifyErc4626ReceiverOnly({
      ...input,
      abi: ERC4626_MINT_ABI,
      rulePrefix: 'erc4626_mint',
      amountIndex: 0,
      receiverIndex: 1,
    });
  }
  if (input.selector === ERC4626_REDEEM_SELECTOR) {
    return classifyErc4626RedeemWithdraw({
      ...input,
      abi: ERC4626_REDEEM_ABI,
      rulePrefix: 'erc4626_redeem',
    });
  }
  if (input.selector === ERC4626_WITHDRAW_SELECTOR) {
    return classifyErc4626RedeemWithdraw({
      ...input,
      abi: ERC4626_WITHDRAW_ABI,
      rulePrefix: 'erc4626_withdraw',
    });
  }

  return null;
}

function classifyErc4626ReceiverOnly(input: {
  owner: string;
  data: string;
  abi: Abi;
  rulePrefix: string;
  amountIndex: number;
  receiverIndex: number;
}): ProtocolRuleClassification {
  try {
    const decoded = decodeFunctionData({ abi: input.abi, data: input.data as Hex });
    const args = decoded.args;
    if (
      !Array.isArray(args) ||
      args.length <= Math.max(input.amountIndex, input.receiverIndex)
    ) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_decode_failed`,
        recipient: null,
      };
    }
    const amount = args[input.amountIndex];
    if (typeof amount !== 'bigint' || amount <= ZERO) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_invalid_amount`,
        recipient: null,
      };
    }
    const receiver = normalizeAddress(String(args[input.receiverIndex]));
    if (!receiver) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_invalid_receiver`,
        recipient: null,
      };
    }
    if (!sameAddress(receiver, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: `${input.rulePrefix}_external_receiver`,
        recipient: receiver,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: `${input.rulePrefix}_to_owner`,
      recipient: receiver,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: `${input.rulePrefix}_decode_failed`,
      recipient: null,
    };
  }
}

function classifyErc4626RedeemWithdraw(input: {
  owner: string;
  data: string;
  abi: Abi;
  rulePrefix: string;
}): ProtocolRuleClassification {
  try {
    const decoded = decodeFunctionData({ abi: input.abi, data: input.data as Hex });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length < 3) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_decode_failed`,
        recipient: null,
      };
    }
    const amount = args[0];
    if (typeof amount !== 'bigint' || amount <= ZERO) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_invalid_amount`,
        recipient: null,
      };
    }
    const receiver = normalizeAddress(String(args[1]));
    const shareOwner = normalizeAddress(String(args[2]));
    if (!receiver || !shareOwner) {
      return {
        classification: 'unknown',
        rule: `${input.rulePrefix}_invalid_addresses`,
        recipient: null,
      };
    }
    // Both receiver and share owner must be the trusted execution owner.
    if (!sameAddress(shareOwner, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: `${input.rulePrefix}_external_owner`,
        recipient: shareOwner,
      };
    }
    if (!sameAddress(receiver, input.owner)) {
      return {
        classification: 'external_transfer',
        rule: `${input.rulePrefix}_external_receiver`,
        recipient: receiver,
      };
    }
    return {
      classification: 'retained_protocol',
      rule: `${input.rulePrefix}_to_owner`,
      recipient: receiver,
    };
  } catch {
    return {
      classification: 'unknown',
      rule: `${input.rulePrefix}_decode_failed`,
      recipient: null,
    };
  }
}

/**
 * Approve / setApprovalForAll revoke-only classification.
 * Returns null when the call is not a proven revoke to a trusted spender
 * (caller should keep the default authorization unknown).
 */
function matchAuthorizationRevoke(input: {
  chainId: number;
  owner: string;
  to: string;
  selector: string;
  data: string;
  value: bigint;
}): ProtocolRuleClassification | null {
  if (input.value !== ZERO) {
    return {
      classification: 'unknown',
      rule: 'authorization_nonzero_value',
      recipient: null,
    };
  }

  if (input.selector === '0x095ea7b3') {
    try {
      const decoded = decodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        data: input.data as Hex,
      });
      const args = decoded.args;
      if (!Array.isArray(args) || args.length < 2) {
        return {
          classification: 'unknown',
          rule: 'erc20_approve_decode_failed',
          recipient: null,
        };
      }
      const spender = normalizeAddress(String(args[0]));
      const amount = args[1];
      if (!spender || typeof amount !== 'bigint') {
        return {
          classification: 'unknown',
          rule: 'erc20_approve_decode_failed',
          recipient: null,
        };
      }
      // Non-zero approve remains unknown (spend authority grant).
      if (amount !== ZERO) {
        return null;
      }
      if (!isTrustedSpender(input.chainId, spender)) {
        return {
          classification: 'unknown',
          rule: 'erc20_approve_zero_untrusted_spender',
          recipient: spender,
        };
      }
      return {
        classification: 'retained_protocol',
        rule: 'erc20_approve_zero_trusted_spender',
        recipient: spender,
      };
    } catch {
      return {
        classification: 'unknown',
        rule: 'erc20_approve_decode_failed',
        recipient: null,
      };
    }
  }

  if (input.selector === '0xa22cb465') {
    try {
      const decoded = decodeFunctionData({
        abi: NFT_SET_APPROVAL_FOR_ALL_ABI,
        data: input.data as Hex,
      });
      const args = decoded.args;
      if (!Array.isArray(args) || args.length < 2) {
        return {
          classification: 'unknown',
          rule: 'nft_set_approval_for_all_decode_failed',
          recipient: null,
        };
      }
      const operator = normalizeAddress(String(args[0]));
      const approved = args[1];
      if (!operator || typeof approved !== 'boolean') {
        return {
          classification: 'unknown',
          rule: 'nft_set_approval_for_all_decode_failed',
          recipient: null,
        };
      }
      // Enabling operator remains unknown.
      if (approved === true) {
        return null;
      }
      if (!isTrustedSpender(input.chainId, operator)) {
        return {
          classification: 'unknown',
          rule: 'nft_set_approval_for_all_false_untrusted_operator',
          recipient: operator,
        };
      }
      return {
        classification: 'retained_protocol',
        rule: 'nft_set_approval_for_all_false_trusted_operator',
        recipient: operator,
      };
    } catch {
      return {
        classification: 'unknown',
        rule: 'nft_set_approval_for_all_decode_failed',
        recipient: null,
      };
    }
  }

  return null;
}

function isTrustedSpender(chainId: number, address: string): boolean {
  const list = TRUSTED_SPENDERS[chainId];
  if (!list || list.length === 0) return false;
  return list.some((s) => sameAddress(s, address));
}

/**
 * Audited, chain-scoped retained-protocol rules.
 * Do not infer protocol trust from API-key metadata; capability authorization is separate.
 * Order matters only for first applicable match; each rule no-ops on non-matching targets.
 */
export const RETAINED_PROTOCOL_RULES: readonly RetainedProtocolRule[] = Object.freeze([
  Object.freeze({
    id: 'aave_v3_pool',
    match: matchAaveV3Pool,
  }),
  Object.freeze({
    id: 'uniswap_v3_swap_router02',
    match: matchUniswapV3SwapRouter02,
  }),
  Object.freeze({
    id: 'uniswap_v2_router02',
    match: matchUniswapV2Router02,
  }),
  Object.freeze({
    id: 'weth9',
    match: matchWeth9,
  }),
  Object.freeze({
    id: 'erc4626_vault',
    match: matchErc4626Vault,
  }),
]);

/**
 * Classify a transaction batch by asset outflow risk.
 * Pure function: no DB, no simulation, no network.
 */
export function classifyTransactionAssetFlow(
  input: ClassifyTransactionAssetFlowInput,
): AssetFlowBatchClassification {
  const owner = normalizeAddress(input.ownerAddress);
  if (!owner) {
    return {
      classification: 'unknown',
      rule: 'invalid_owner_address',
      decisiveIndex: null,
      interactions: (input.interactions ?? []).map((_, index) => ({
        index,
        classification: 'unknown',
        rule: 'invalid_owner_address',
        selector: null,
        recipient: null,
      })),
    };
  }

  const interactions = Array.isArray(input.interactions) ? input.interactions : [];
  const classified = interactions.map((interaction, index) =>
    classifyInteraction(interaction, owner, input.chainId, index),
  );

  return foldBatch(classified);
}

function foldBatch(
  interactions: AssetFlowInteractionClassification[],
): AssetFlowBatchClassification {
  if (interactions.length === 0) {
    return {
      classification: 'unknown',
      rule: 'empty_interactions',
      decisiveIndex: null,
      interactions: [],
    };
  }

  const external = interactions.find((i) => i.classification === 'external_transfer');
  if (external) {
    return {
      classification: 'external_transfer',
      rule: external.rule,
      decisiveIndex: external.index,
      interactions,
    };
  }

  const unknown = interactions.find((i) => i.classification === 'unknown');
  if (unknown) {
    return {
      classification: 'unknown',
      rule: unknown.rule,
      decisiveIndex: unknown.index,
      interactions,
    };
  }

  const retained = interactions[0];
  return {
    classification: 'retained_protocol',
    rule: retained.rule,
    decisiveIndex: retained.index,
    interactions,
  };
}

function classifyInteraction(
  interaction: AssetFlowInteractionInput,
  owner: string,
  chainId: number,
  index: number,
): AssetFlowInteractionClassification {
  const base = {
    index,
    selector: null as string | null,
    recipient: null as string | null,
  };

  if (!interaction || typeof interaction !== 'object') {
    return { ...base, classification: 'unknown', rule: 'invalid_interaction' };
  }

  const to = normalizeAddress(interaction.to);
  if (!to) {
    return { ...base, classification: 'unknown', rule: 'invalid_target_address' };
  }

  const valueResult = parseDecimalWei(interaction.value);
  if (!valueResult.ok) {
    return { ...base, classification: 'unknown', rule: 'invalid_native_value' };
  }
  const value = valueResult.value;

  const dataResult = normalizeCalldata(interaction.data);
  if (!dataResult.ok) {
    return { ...base, classification: 'unknown', rule: dataResult.rule };
  }
  const data = dataResult.data;
  const selector = getSelector(data);

  // Plain native transfer (no calldata): recipient is interaction.to.
  // Zero-value empty calls are unverifiable (arbitrary target may still have side effects
  // via fallback) and must not be treated as retained.
  if (isEmptyCalldata(data)) {
    if (value > ZERO) {
      const recipient = to;
      if (!sameAddress(recipient, owner)) {
        return {
          index,
          classification: 'external_transfer',
          rule: 'native_value_external',
          selector: null,
          recipient,
        };
      }
      return {
        index,
        classification: 'retained_protocol',
        rule: 'native_value_to_owner',
        selector: null,
        recipient,
      };
    }
    return {
      index,
      classification: 'unknown',
      rule: 'empty_call_unverifiable',
      selector: null,
      recipient: to,
    };
  }

  if (!selector) {
    return {
      index,
      classification: 'unknown',
      rule: 'malformed_selector',
      selector: null,
      recipient: null,
    };
  }

  // Approvals / permits: default unknown. Exception — proven revoke to a trusted
  // spender/operator (approve amount=0 / setApprovalForAll false) may be retained.
  if (AUTHORIZATION_SELECTORS.has(selector)) {
    const revoke = matchAuthorizationRevoke({
      chainId,
      owner,
      to,
      selector,
      data,
      value,
    });
    if (revoke) {
      return {
        index,
        classification: revoke.classification,
        rule: revoke.rule,
        selector,
        recipient: revoke.recipient,
      };
    }
    return {
      index,
      classification: 'unknown',
      rule: SELECTOR_RULE[selector] ?? 'authorization_selector',
      selector,
      recipient: null,
    };
  }

  // Standard ERC token transfers: beneficiary is decoded recipient, not interaction.to.
  // External recipient → conservative external_transfer (reject).
  // Recipient == owner → still unknown: interaction.to is not proven to be a real token
  // contract (no bytecode/network lookup; no global token whitelist). Audited Aave/Uniswap
  // registry rules below are what may retain known protocol targets.
  const standard = STANDARD_TRANSFER_BY_SELECTOR[selector];
  if (standard) {
    // Native value on a token-transfer call to a non-owner target is external.
    if (value > ZERO && !sameAddress(to, owner)) {
      return {
        index,
        classification: 'external_transfer',
        rule: 'native_value_with_calldata_external',
        selector,
        recipient: to,
      };
    }

    const decoded = tryDecodeStandardTransfer(standard.abi, data);
    if (!decoded) {
      return {
        index,
        classification: 'unknown',
        rule: `${standard.kind}_decode_failed`,
        selector,
        recipient: null,
      };
    }

    const recipient = normalizeAddress(String(decoded.recipient));
    if (!recipient) {
      return {
        index,
        classification: 'unknown',
        rule: `${standard.kind}_invalid_recipient`,
        selector,
        recipient: null,
      };
    }

    if (!sameAddress(recipient, owner)) {
      return {
        index,
        classification: 'external_transfer',
        rule: `${standard.kind}_external`,
        selector,
        recipient,
      };
    }

    return {
      index,
      classification: 'unknown',
      rule: `${standard.kind}_recipient_owner_unverifiable`,
      selector,
      recipient,
    };
  }

  // Audited protocol rules run BEFORE the generic nonzero-native external fallback so
  // safe V2 ETH-in swaps (value>0, router target, recipient===owner) can be retained.
  for (const protocolRule of RETAINED_PROTOCOL_RULES) {
    const match = protocolRule.match({
      chainId,
      owner,
      to,
      selector,
      data,
      value,
    });
    if (match) {
      return {
        index,
        classification: match.classification,
        rule: match.rule,
        selector,
        recipient: match.recipient,
      };
    }
  }

  // Generic payable call to non-owner: clear native outflow, not proven retained.
  if (value > ZERO && !sameAddress(to, owner)) {
    return {
      index,
      classification: 'external_transfer',
      rule: 'native_value_with_calldata_external',
      selector,
      recipient: to,
    };
  }

  return {
    index,
    classification: 'unknown',
    rule: 'unrecognized_call',
    selector,
    recipient: null,
  };
}

function tryDecodeStandardTransfer(abi: Abi, data: string): { recipient: string } | null {
  try {
    const decoded = decodeFunctionData({
      abi,
      data: data as Hex,
    });
    const args = decoded.args;
    if (!Array.isArray(args) || args.length === 0) return null;

    const functionName = decoded.functionName;
    let recipientRaw: unknown;
    if (functionName === 'transfer') {
      recipientRaw = args[0];
    } else if (
      functionName === 'transferFrom' ||
      functionName === 'safeTransferFrom' ||
      functionName === 'safeBatchTransferFrom'
    ) {
      recipientRaw = args[1];
    } else {
      return null;
    }

    if (typeof recipientRaw !== 'string') return null;
    return { recipient: recipientRaw };
  } catch {
    return null;
  }
}

function parseDecimalWei(value: string | undefined): { ok: true; value: bigint } | { ok: false } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: ZERO };
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: BigInt(value) };
  } catch {
    return { ok: false };
  }
}

function normalizeCalldata(
  data: unknown,
): { ok: true; data: string } | { ok: false; rule: string } {
  if (typeof data !== 'string') {
    return { ok: false, rule: 'invalid_calldata' };
  }
  if (data === '0x' || data === '0X') {
    return { ok: true, data: '0x' };
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    return { ok: false, rule: 'invalid_calldata' };
  }
  if (data.length > 2 && data.length < 10) {
    return { ok: false, rule: 'truncated_calldata' };
  }
  return { ok: true, data: data.toLowerCase() };
}

function isEmptyCalldata(data: string): boolean {
  return data === '0x';
}

function getSelector(data: string): string | null {
  if (data === '0x' || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase();
}

function normalizeAddress(address: string | null | undefined): string | null {
  if (!address || typeof address !== 'string') return null;
  if (!isAddress(address)) return null;
  try {
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
