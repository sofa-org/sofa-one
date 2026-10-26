import { parseAbiParameters } from 'viem';
import {
  UNISWAP_DEPLOYMENTS,
  UNISWAP_PERMIT2,
  UNISWAP_POOL_MANAGERS,
  UNISWAP_V4_POSITION_ABI,
  type UniswapExecutionContext,
  type UniswapExecutionResult,
} from './uniswap-deployments';
import { decodeUniswapParameters } from './uniswap-wire';

// UR 2.1.2 commit 802fe4c18f47300e0f183e2a42e9146ec2ea9fc3 pins
// v4-periphery 545a5d2a87228167edde48f3b9eda122d1e3c4d6:
// src/PositionManager.sol, libraries/Actions.sol and base/BaseActionsRouter.sol.
const ZERO = '0x0000000000000000000000000000000000000000';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;
const ACTIONS = parseAbiParameters('bytes actions, bytes[] params');
const MODIFY = parseAbiParameters('uint256 tokenId, uint256 liquidity, uint128 amount0, uint128 amount1, bytes hookData');
const MINT = parseAbiParameters('(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData');
const BURN = parseAbiParameters('uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData');
const PAIR = parseAbiParameters('address currency0, address currency1');
const TAKE_PAIR = parseAbiParameters('address currency0, address currency1, address recipient');
const SETTLE = parseAbiParameters('address currency, uint256 amount, bool payerIsUser');
const TAKE = parseAbiParameters('address currency, address recipient, uint256 amount');
const CURRENCY = parseAbiParameters('address currency');
const SWEEP = parseAbiParameters('address currency, address recipient');
const AMOUNT = parseAbiParameters('uint256 amount');

function deny(message: string): never {
  throw new TypeError(`Invalid Uniswap V4 position execution: ${message}`);
}

/**
 * Calldata policy, not an on-chain state or complete target attestation.
 * Supplied mint PoolKeys must be hookless, and every hookData must be empty.
 * Existing tokenId operations authorize the caller's on-chain owner-or-approved
 * LP authority: stored pool hooks and subscriber callbacks are inherited and
 * are NOT attested here. Their addresses, and the stored pool's currencies,
 * cannot be recovered from tokenId calldata; touchedContracts lists known
 * addresses only. On-chain authorization, balances, slippage and expiry apply.
 */
export function validateV4PositionManager(
  data: string,
  context: UniswapExecutionContext,
): UniswapExecutionResult {
  const deployment = UNISWAP_DEPLOYMENTS[context.chainId];
  if (!deployment) deny('unsupported chain');
  const address = (value: unknown): string => {
    if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) deny('invalid address');
    return value.toLowerCase();
  };
  const owner = address(context.executionOwner);
  const caller = address(context.callerAddress ?? context.executionOwner);
  if ([ZERO, MSG_SENDER, ADDRESS_THIS].includes(owner)) deny('invalid execution owner');
  if (context.nativeValue < 0n || context.nativeValue >= 1n << 256n) deny('invalid native value');
  if (!/^0xdd46508f/i.test(data)) deny('unsupported selector');
  const [unlockData, deadline] = decodeUniswapParameters(UNISWAP_V4_POSITION_ABI.inputs, `0x${data.slice(10)}`);
  // The contract enforces block.timestamp <= deadline. No local clock or RPC.
  if (deadline === 0n) deny('zero deadline');
  const [actions, params] = decodeUniswapParameters(ACTIONS, unlockData as string) as readonly [string, readonly string[]];
  const count = (actions.length - 2) / 2;
  if (count === 0 || count > 64 || count !== params.length) deny('action count');

  const touched = new Set<string>([deployment.positionManager, UNISWAP_POOL_MANAGERS[context.chainId]]);
  const intermediate = new Set<string>();
  // A Router child receives its actual native balance, not just root msg.value.
  // Require an explicit refund even when the original root value was zero.
  if (context.nativeValue > 0n || caller !== owner) intermediate.add(ZERO);
  const currency = (value: unknown, pays = false): string => {
    const token = address(value);
    if (token !== ZERO) {
      touched.add(token);
      if (pays) touched.add(UNISWAP_PERMIT2);
    }
    return token;
  };
  const recipient = (value: unknown, allowIntermediate: boolean): string => {
    const raw = address(value);
    const mapped = raw === MSG_SENDER ? caller : raw === ADDRESS_THIS ? deployment.positionManager : raw;
    if (mapped === owner) return mapped;
    if (allowIntermediate && mapped === deployment.positionManager) return mapped;
    return deny('recipient must be execution owner');
  };
  const hookData = (value: unknown): void => {
    if (value !== '0x') deny('nonempty hookData');
  };
  for (let i = 0; i < count; i++) {
    const action = Number.parseInt(actions.slice(2 + i * 2, 4 + i * 2), 16);
    const input = params[i];
    switch (action) {
      case 0x00: // INCREASE_LIQUIDITY; zero liquidity collects fees.
      case 0x01: { // DECREASE_LIQUIDITY; zero liquidity also collects fees.
        const values = decodeUniswapParameters(MODIFY, input);
        hookData(values[4]);
        break;
      }
      case 0x02: { // MINT_POSITION, explicit liquidity only.
        const values = decodeUniswapParameters(MINT, input);
        const key = values[0] as { currency0: string; currency1: string; hooks: string };
        if (address(key.hooks) !== ZERO) deny('nonzero pool hook');
        currency(key.currency0);
        currency(key.currency1);
        recipient(values[6], false);
        hookData(values[7]);
        break;
      }
      case 0x03: { // BURN_POSITION; the contract removes remaining liquidity.
        const values = decodeUniswapParameters(BURN, input);
        hookData(values[3]);
        break;
      }
      case 0x0b: { // SETTLE
        const values = decodeUniswapParameters(SETTLE, input);
        if (values[2] !== true) deny('payerIsUser must be true');
        currency(values[0], true);
        break;
      }
      case 0x0d: { // SETTLE_PAIR always pays from actual caller/locker.
        const values = decodeUniswapParameters(PAIR, input);
        currency(values[0], true);
        currency(values[1], true);
        break;
      }
      case 0x0e: { // TAKE
        const values = decodeUniswapParameters(TAKE, input);
        const token = currency(values[0]);
        if (recipient(values[1], true) !== owner) intermediate.add(token);
        break;
      }
      case 0x11: { // TAKE_PAIR
        const values = decodeUniswapParameters(TAKE_PAIR, input);
        const token0 = currency(values[0]);
        const token1 = currency(values[1]);
        if (recipient(values[2], true) !== owner) {
          intermediate.add(token0);
          intermediate.add(token1);
        }
        break;
      }
      case 0x12: { // CLOSE_CURRENCY implicitly pays/receives as caller.
        const values = decodeUniswapParameters(CURRENCY, input);
        if (caller !== owner) deny('close recipient is not execution owner');
        currency(values[0], true);
        break;
      }
      case 0x14: { // SWEEP is terminal, never a third-party or self payout.
        const values = decodeUniswapParameters(SWEEP, input);
        const token = currency(values[0]);
        recipient(values[1], false);
        intermediate.delete(token);
        break;
      }
      case 0x15: // WRAP
      case 0x16: { // UNWRAP
        const [amount] = decodeUniswapParameters(AMOUNT, input);
        touched.add(deployment.wrappedNative);
        const source = action === 0x15 ? ZERO : deployment.wrappedNative;
        const target = action === 0x15 ? deployment.wrappedNative : ZERO;
        // Only CONTRACT_BALANCE proves that no intermediate input is stranded.
        if (amount === CONTRACT_BALANCE) intermediate.delete(source);
        intermediate.add(target);
        break;
      }
      default:
        // Includes FROM_DELTAS, swaps, donate, unsupported settle/take variants,
        // CLEAR_OR_TAKE (forfeiture), ERC6909, subscriptions and unknown flags.
        deny('unsupported action');
    }
  }
  if (intermediate.size !== 0) deny('intermediate balance requires owner sweep');
  return { operationCount: count, touchedContracts: [...touched], children: [] };
}
