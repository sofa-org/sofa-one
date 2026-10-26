import { parseAbiParameters, type AbiParameter } from 'viem';
import {
  UNISWAP_DEPLOYMENTS, UNISWAP_PERMIT2, UNISWAP_POOL_MANAGERS, UNISWAP_ROUTER_ABI, UNISWAP_V4_POSITION_ABI,
  type UniswapExecutionContext, type UniswapExecutionResult,
} from './uniswap-deployments';
import { decodeUniswapParameters } from './uniswap-wire';

// Wire language pinned to universal-router 802fe4c18f47300e0f183e2a42e9146ec2ea9fc3
// Dispatcher.sol / Commands.sol / V3ToV4Migrator.sol and its v4-periphery submodule
// 545a5d2a87228167edde48f3b9eda122d1e3c4d6: IV4Router.sol / V4Router.sol / PathKey.sol.
const ZERO = '0x0000000000000000000000000000000000000000';
const SENDER = '0x0000000000000000000000000000000000000001';
const SELF = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n;
const PLAN = parseAbiParameters('bytes,bytes[]');
const V2_SWAP = parseAbiParameters('address,uint256,uint256,address[],bool,uint256[]');
const V3_SWAP = parseAbiParameters('address,uint256,uint256,bytes,bool,uint256[]');
const TOKEN_RECIPIENT_AMOUNT = parseAbiParameters('address,address,uint256');
const WRAP = parseAbiParameters('address,uint256');
const CURRENCY_AMOUNT = parseAbiParameters('address,uint256');
const SETTLE = parseAbiParameters('address,uint256,bool');
const PERMIT_TRANSFER = parseAbiParameters('address,address,uint160');
const PERMIT_BATCH = parseAbiParameters('(address from,address to,uint160 amount,address token)[]');
const SINGLE_SWAP = parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amount,uint128 limit,uint256 minHopPriceX36,bytes hookData)');
const MULTI_SWAP = parseAbiParameters('(address currency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint256[] minHopPriceX36,uint128 amount,uint128 limit)');

type Pool = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
type Hop = { intermediateCurrency: string; fee: number; tickSpacing: number; hooks: string; hookData: string };
type SingleSwap = { poolKey: Pool; zeroForOne: boolean; amount: bigint; limit: bigint; minHopPriceX36: bigint; hookData: string };
type MultiSwap = { currency: string; path: readonly Hop[]; minHopPriceX36: readonly bigint[]; amount: bigint; limit: bigint };
type BatchTransfer = { from: string; to: string; amount: bigint; token: string };

/** Pure finite-language validation, not a balance/liquidity/approval or deployment attestation. */
export function validateUniversalRouter(data: string, context: UniswapExecutionContext): UniswapExecutionResult {
  const deployment = UNISWAP_DEPLOYMENTS[context.chainId];
  if (!deployment || !/^0x[0-9a-f]{40}$/i.test(context.executionOwner)
      || context.nativeValue < 0n || context.nativeValue >= (1n << 256n)) {
    throw new TypeError('Invalid Uniswap execution context');
  }
  const owner = context.executionOwner.toLowerCase();
  const router = deployment.router.toLowerCase();
  if ([ZERO, SENDER, SELF, router].includes(owner)) throw new TypeError('Invalid Uniswap execution owner');
  if (typeof data !== 'string' || data.slice(0, 10).toLowerCase() !== '0x3593564c') throw new TypeError('Wrong Universal Router selector');
  const touched = new Set<string>([router]);
  // Router recipients are custody intermediates, not an alternative beneficiary.
  const custody = new Set<string>();
  if (context.nativeValue > 0n) custody.add(ZERO);
  const children: { to: string; data: `0x${string}` }[] = [];
  let operationCount = 0;
  const charge = (): void => {
    if (++operationCount > 64) throw new TypeError('Uniswap operation bound exceeded');
  };
  const address = (value: unknown): string => {
    if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) throw new TypeError('Invalid Uniswap address');
    return value.toLowerCase();
  };
  const token = (value: unknown, native = false): string => {
    const result = address(value);
    if (result === ZERO) {
      if (!native) throw new TypeError('Native currency is not an ERC20 path token');
    } else {
      if (result === SENDER || result === SELF) throw new TypeError('Invalid Uniswap token');
      touched.add(result);
    }
    return result;
  };
  const recipient = (value: unknown, intermediate = false, mapped = true): string => {
    let result = address(value);
    if (mapped && result === SENDER) result = owner;
    if (mapped && result === SELF) result = router;
    if (result !== owner && !(intermediate && result === router)) throw new TypeError('Uniswap recipient is not execution owner');
    return result;
  };
  const receive = (currency: string, value: unknown, intermediate: boolean, mapped = true): string => {
    const to = recipient(value, intermediate, mapped);
    if (to === router) custody.add(currency);
    return to;
  };
  const prices = (value: readonly unknown[], hops: number): void => {
    if (value.length !== 0 && value.length !== hops) throw new TypeError('Uniswap hop-price/path length mismatch');
  };
  const poolSettings = (fee: number, spacing: number, hooks: string, hookData: string): void => {
    if (fee > 1_000_000 || spacing <= 0 || spacing > 32767 || address(hooks) !== ZERO || hookData !== '0x') {
      throw new TypeError('Unsupported Uniswap V4 pool or hook');
    }
  };
  const read = (parameters: readonly AbiParameter[], input: unknown): readonly unknown[] => {
    if (typeof input !== 'string') throw new TypeError('Invalid Uniswap command input');
    return decodeUniswapParameters(parameters, input);
  };
  const bytes = (value: unknown): number[] => {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value) || value.length > 130) {
      throw new TypeError('Uniswap command/action bound exceeded');
    }
    const result: number[] = [];
    for (let i = 2; i < value.length; i += 2) result.push(Number.parseInt(value.slice(i, i + 2), 16));
    return result;
  };
  const v4 = (input: string): void => {
    touched.add(UNISWAP_POOL_MANAGERS[context.chainId]);
    const [rawActions, rawParams] = read(PLAN, input);
    const actions = bytes(rawActions);
    const params = rawParams as readonly string[];
    if (actions.length === 0 || actions.length !== params.length) throw new TypeError('Uniswap V4 action/input mismatch');
    for (let i = 0; i < actions.length; i++) {
      charge();
      const action = actions[i];
      if (action === 0x06 || action === 0x08) {
        const swap = read(SINGLE_SWAP, params[i])[0] as SingleSwap;
        const currency0 = token(swap.poolKey.currency0, true);
        const currency1 = token(swap.poolKey.currency1, true);
        if (BigInt(currency0) >= BigInt(currency1)) throw new TypeError('Unsorted Uniswap V4 pool currencies');
        poolSettings(swap.poolKey.fee, swap.poolKey.tickSpacing, swap.poolKey.hooks, swap.hookData);
      } else if (action === 0x07 || action === 0x09) {
        const swap = read(MULTI_SWAP, params[i])[0] as MultiSwap;
        let current = token(swap.currency, true);
        if (swap.path.length === 0) throw new TypeError('Empty Uniswap V4 path');
        prices(swap.minHopPriceX36, swap.path.length);
        // Exact-output visits PathKey entries in reverse, matching pinned V4Router.
        for (let step = 0; step < swap.path.length; step++) {
          const hop = swap.path[action === 0x09 ? swap.path.length - 1 - step : step];
          const next = token(hop.intermediateCurrency, true);
          if (next === current) throw new TypeError('Identical Uniswap V4 hop currencies');
          poolSettings(hop.fee, hop.tickSpacing, hop.hooks, hop.hookData);
          current = next;
        }
      } else if (action === 0x0b) {
        const [rawCurrency, , payerIsUser] = read(SETTLE, params[i]);
        const currency = token(rawCurrency, true);
        if (payerIsUser && currency !== ZERO) touched.add(UNISWAP_PERMIT2);
      } else if (action === 0x0c || action === 0x0f) {
        const [rawCurrency] = read(CURRENCY_AMOUNT, params[i]);
        const currency = token(rawCurrency, true);
        if (action === 0x0c && currency !== ZERO) touched.add(UNISWAP_PERMIT2);
        // SETTLE_ALL and TAKE_ALL always use the lock's execution owner.
      } else if (action === 0x0e) {
        const [rawCurrency, to] = read(TOKEN_RECIPIENT_AMOUNT, params[i]);
        receive(token(rawCurrency, true), to, true);
      } else {
        throw new TypeError('Unsupported Uniswap V4 swap action');
      }
    }
  };
  const plan = (rawCommands: unknown, rawInputs: unknown, depth: number): void => {
    if (depth > 4) throw new TypeError('Uniswap subplan nesting bound exceeded');
    const commands = bytes(rawCommands);
    const inputs = rawInputs as readonly string[];
    if (commands.length === 0 || commands.length !== inputs.length) throw new TypeError('Uniswap command/input mismatch');
    for (let i = 0; i < commands.length; i++) {
      charge();
      const command = commands[i];
      const input = inputs[i];
      // Never mask off flags: allow-revert and unknown/reserved commands fail closed.
      if (command === 0x00 || command === 0x01 || command === 0x08 || command === 0x09) {
        const isV3 = command < 0x02;
        const exactOut = command === 0x01 || command === 0x09;
        const [to, , , rawPath, payerIsUser, rawPrices] = read(isV3 ? V3_SWAP : V2_SWAP, input);
        let path: string[];
        if (isV3) {
          const packed = rawPath as string;
          const length = (packed.length - 2) / 2;
          if (length < 43 || (length - 20) % 23 !== 0 || (length - 20) / 23 > 63) throw new TypeError('Invalid Uniswap V3 path');
          path = [];
          for (let offset = 2; offset < packed.length; offset += 46) {
            path.push(token(`0x${packed.slice(offset, offset + 40)}`));
            if (offset + 40 < packed.length) {
              const fee = Number.parseInt(packed.slice(offset + 40, offset + 46), 16);
              if (fee === 0 || fee >= 1_000_000) throw new TypeError('Invalid Uniswap V3 fee');
            }
          }
        } else {
          path = (rawPath as readonly string[]).map((item) => token(item));
          if (path.length < 2) throw new TypeError('Invalid Uniswap V2 path');
        }
        for (let hop = 1; hop < path.length; hop++) {
          if (path[hop - 1] === path[hop]) throw new TypeError('Identical Uniswap path tokens');
        }
        prices(rawPrices as readonly unknown[], path.length - 1);
        if (payerIsUser) touched.add(UNISWAP_PERMIT2);
        receive(path[isV3 && exactOut ? 0 : path.length - 1], to, true);
      } else if (command === 0x02) {
        const [rawToken, to] = read(PERMIT_TRANSFER, input);
        touched.add(UNISWAP_PERMIT2);
        receive(token(rawToken), to, true);
      } else if (command === 0x0d) {
        const transfers = read(PERMIT_BATCH, input)[0] as readonly BatchTransfer[];
        if (transfers.length === 0) throw new TypeError('Empty Uniswap Permit2 transfer batch');
        touched.add(UNISWAP_PERMIT2);
        for (const transfer of transfers) {
          charge();
          if (address(transfer.from) !== owner) throw new TypeError('Uniswap Permit2 source is not execution owner');
          // Batch Permit2 recipients are literal: Dispatcher does not map sentinels.
          receive(token(transfer.token), transfer.to, true, false);
        }
      } else if (command === 0x04 || command === 0x05) {
        const [rawToken, to, amount] = read(TOKEN_RECIPIENT_AMOUNT, input);
        const currency = token(rawToken, true);
        recipient(to);
        if (command === 0x04 || (currency !== ZERO && amount === CONTRACT_BALANCE)) custody.delete(currency);
      } else if (command === 0x0b || command === 0x0c) {
        const [to, amount] = read(WRAP, input);
        touched.add(deployment.wrappedNative);
        if (command === 0x0b) {
          if (amount === CONTRACT_BALANCE) custody.delete(ZERO);
          receive(deployment.wrappedNative, to, true);
        } else {
          custody.delete(deployment.wrappedNative);
          receive(ZERO, to, true);
        }
      } else if (command === 0x0e) {
        const [balanceOwner, rawToken] = read(TOKEN_RECIPIENT_AMOUNT, input);
        recipient(balanceOwner, true, false);
        token(rawToken);
      } else if (command === 0x10) {
        v4(input);
      } else if (command === 0x14) {
        if (input.slice(0, 10).toLowerCase() !== '0xdd46508f') throw new TypeError('Unsupported Uniswap V4 position-manager child');
        const [unlockData] = read(UNISWAP_V4_POSITION_ABI.inputs, `0x${input.slice(10)}`);
        const [rawActions, rawParams] = read(PLAN, unlockData);
        const actions = bytes(rawActions);
        if (actions.length === 0 || actions.length !== (rawParams as readonly unknown[]).length
            || actions.some((action) => [0x00, 0x01, 0x03, 0x04, 0x05].includes(action))
            || !actions.includes(0x02)) throw new TypeError('Uniswap Router PM child is mint-only');
        touched.add(deployment.positionManager);
        // Parent must validate all child actions, owner bindings, pauses and the separate PM grant.
        children.push({ to: deployment.positionManager, data: input as `0x${string}` });
        // This command forwards the whole router native balance. The parent must
        // validate the child with callerAddress=router, which requires a PM refund.
        custody.delete(ZERO);
      } else if (command === 0x21) {
        const [nestedCommands, nestedInputs] = read(PLAN, input);
        plan(nestedCommands, nestedInputs, depth + 1);
      } else {
        throw new TypeError('Unsupported Uniswap Router command or flags');
      }
    }
  };
  const [commands, inputs] = read(UNISWAP_ROUTER_ABI.inputs, `0x${data.slice(10)}`);
  plan(commands, inputs, 0);
  if (custody.size !== 0) throw new TypeError('Uniswap router recipient is not an intermediate');
  return { operationCount, touchedContracts: [...touched], children };
}
