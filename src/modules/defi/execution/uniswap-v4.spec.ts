import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, type Hex } from 'viem';
import {
  UNISWAP_DEPLOYMENTS,
  UNISWAP_PERMIT2,
  UNISWAP_V4_POSITION_ABI,
  type UniswapExecutionContext,
} from './uniswap-deployments';
import { validateV4PositionManager } from './uniswap-v4';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN0 = '0x3333333333333333333333333333333333333333';
const TOKEN1 = '0x4444444444444444444444444444444444444444';
const ZERO = '0x0000000000000000000000000000000000000000';
const SENDER = '0x0000000000000000000000000000000000000001';
const SELF = '0x0000000000000000000000000000000000000002';
const DEPLOYMENT = UNISWAP_DEPLOYMENTS[1];
const CONTRACT_BALANCE = 1n << 255n;
const context: UniswapExecutionContext = { chainId: 1, executionOwner: OWNER, nativeValue: 0n };
const MINT_TYPES = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData';
const MODIFY_TYPES = 'uint256 tokenId, uint256 liquidity, uint128 amount0, uint128 amount1, bytes hookData';
const BURN_TYPES = 'uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData';
type Operation = readonly [number, Hex];

function abi(types: string, values: readonly unknown[]): Hex {
  return encodeAbiParameters(parseAbiParameters(types), values);
}
function mint(owner: string = OWNER, hooks: string = ZERO, hookData: Hex = '0x'): Operation {
  return [0x02, abi(MINT_TYPES, [
    { currency0: TOKEN0, currency1: TOKEN1, fee: 3000, tickSpacing: 60, hooks },
    -120, 120, 100n, 1000n, 1000n, owner, hookData,
  ])];
}
function modify(action: number = 0x00, liquidity = 100n, hookData: Hex = '0x'): Operation {
  return [action, abi(MODIFY_TYPES, [7n, liquidity, 1000n, 1000n, hookData])];
}
function burn(hookData: Hex = '0x'): Operation {
  return [0x03, abi(BURN_TYPES, [7n, 0n, 0n, hookData])];
}
function operation(action: number, types: string, values: readonly unknown[]): Operation {
  return [action, abi(types, values)];
}
function outer(unlockData: Hex, deadline = 1n): Hex {
  return encodeFunctionData({ abi: [UNISWAP_V4_POSITION_ABI], functionName: 'modifyLiquidities', args: [unlockData, deadline] });
}
function payload(operations: readonly Operation[], deadline = 1n): Hex {
  const actions = `0x${operations.map(([code]) => code.toString(16).padStart(2, '0')).join('')}`;
  return outer(abi('bytes actions, bytes[] params', [actions, operations.map(([, input]) => input)]), deadline);
}
function sweep(token: string, recipient = OWNER): Operation {
  return operation(0x14, 'address,address', [token, recipient]);
}

describe('Uniswap V4 PositionManager calldata policy', () => {
  it('supports explicit-liquidity mint and caller-paid pair settlement', () => {
    const result = validateV4PositionManager(payload([
      mint(), operation(0x0d, 'address,address', [TOKEN0, TOKEN1]),
    ]), context);
    expect(result.operationCount).toBe(2);
    expect(result.touchedContracts).toEqual(expect.arrayContaining([
      DEPLOYMENT.positionManager, TOKEN0, TOKEN1, UNISWAP_PERMIT2,
    ]));
    expect(result.children).toEqual([]);
  });

  it.each([0x00, 0x01])('supports tokenId LP action %s and owner payouts', (action) => {
    const result = validateV4PositionManager(payload([
      modify(action), operation(0x11, 'address,address,address', [TOKEN0, TOKEN1, SENDER]),
    ]), context);
    expect(result.operationCount).toBe(2);
    expect(result.touchedContracts).toEqual(expect.arrayContaining([DEPLOYMENT.positionManager, TOKEN0, TOKEN1]));
  });

  it('supports burn and implicit owner close', () => {
    expect(validateV4PositionManager(payload([
      burn(), operation(0x12, 'address', [TOKEN0]), operation(0x12, 'address', [ZERO]),
    ]), context).operationCount).toBe(3);
  });

  it.each([0x00, 0x01])('allows zero-liquidity fee claims through action %s', (action) => {
    expect(validateV4PositionManager(payload([
      modify(action, 0n), operation(0x11, 'address,address,address', [TOKEN0, TOKEN1, OWNER]),
    ]), context).operationCount).toBe(2);
  });

  it('accepts existing tokenId authority without inventing stored hook/subscriber evidence', () => {
    // TokenId-only calldata cannot attest its pool, hooks, subscriber or NFT owner.
    // The deployed contract enforces owner-or-approved authority; this is not a
    // test claiming those stored addresses are hookless or exhaustively listed.
    const result = validateV4PositionManager(payload([modify(), burn()]), context);
    expect(result.touchedContracts).toContain(DEPLOYMENT.positionManager);
  });

  it('uses contract deadline enforcement rather than the local clock', () => {
    expect(validateV4PositionManager(payload([mint()], 1n), context).touchedContracts).toContain(TOKEN0);
    expect(validateV4PositionManager(payload([mint()], (1n << 256n) - 1n), context).operationCount).toBe(1);
    expect(() => validateV4PositionManager(payload([mint()], 0n), context)).toThrow('zero deadline');
  });

  it.each([OTHER, ZERO, SELF, DEPLOYMENT.positionManager])('rejects NFT mint owner %s', (owner) => {
    expect(() => validateV4PositionManager(payload([mint(owner)]), context)).toThrow('recipient');
  });

  it('accepts sender sentinel for direct mint and rejects supplied pool hooks', () => {
    expect(validateV4PositionManager(payload([mint(SENDER)]), context).touchedContracts).toContain(TOKEN1);
    expect(() => validateV4PositionManager(payload([mint(OWNER, OTHER)]), context)).toThrow('pool hook');
  });

  it.each([mint(OWNER, ZERO, '0x01'), modify(0x00, 1n, '0x01'), modify(0x01, 0n, '0x01'), burn('0x01')])(
    'rejects nonempty hookData for every LP action (%s)', (code, input) => {
      expect(() => validateV4PositionManager(payload([[code, input]]), context)).toThrow('hookData');
    },
  );

  it.each([0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0c, 0x0f, 0x10, 0x13, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x40, 0x80, 0xff])(
    'denies unsupported, delta-based, swap, donate, admin or flagged action %s', (code) => {
      expect(() => validateV4PositionManager(payload([[code, '0x']]), context)).toThrow('unsupported action');
    },
  );

  it('requires payerIsUser true and records only nonnative token payments through Permit2', () => {
    const native = operation(0x0b, 'address,uint256,bool', [ZERO, 0n, true]);
    expect(validateV4PositionManager(payload([mint(), native]), context).touchedContracts).not.toContain(UNISWAP_PERMIT2);
    const token = operation(0x0b, 'address,uint256,bool', [TOKEN0, CONTRACT_BALANCE, true]);
    expect(validateV4PositionManager(payload([modify(), token]), context).touchedContracts).toContain(UNISWAP_PERMIT2);
    const wrongPayer = operation(0x0b, 'address,uint256,bool', [TOKEN0, 0n, false]);
    expect(() => validateV4PositionManager(payload([mint(), wrongPayer]), context)).toThrow('payerIsUser');
  });

  it.each([
    operation(0x0e, 'address,address,uint256', [TOKEN0, OTHER, 0n]),
    operation(0x11, 'address,address,address', [TOKEN0, TOKEN1, OTHER]),
    sweep(TOKEN0, OTHER), sweep(TOKEN0, SELF),
  ])('rejects third-party or nonterminal-self payouts (%s)', (code, input) => {
    expect(() => validateV4PositionManager(payload([modify(), [code, input]]), context)).toThrow('recipient');
  });

  it('allows self as intermediate only when a subsequent owner sweep drains that currency', () => {
    const take = operation(0x0e, 'address,address,uint256', [TOKEN0, SELF, 0n]);
    expect(() => validateV4PositionManager(payload([modify(), take]), context)).toThrow('owner sweep');
    expect(validateV4PositionManager(payload([modify(), take, sweep(TOKEN0)]), context).operationCount).toBe(3);
    expect(() => validateV4PositionManager(payload([modify(), sweep(TOKEN0), take]), context)).toThrow('owner sweep');
  });

  it('supports owner-directed unwrap and wrap pipelines and records the configured wrapper', () => {
    const take = operation(0x0e, 'address,address,uint256', [DEPLOYMENT.wrappedNative, SELF, 0n]);
    const unwrap = operation(0x16, 'uint256', [CONTRACT_BALANCE]);
    const result = validateV4PositionManager(payload([modify(), take, unwrap, sweep(ZERO, SENDER)]), context);
    expect(result.touchedContracts).toContain(DEPLOYMENT.wrappedNative);
    expect(result.touchedContracts).not.toContain(ZERO);
    expect(validateV4PositionManager(payload([
      mint(), operation(0x15, 'uint256', [CONTRACT_BALANCE]), sweep(DEPLOYMENT.wrappedNative),
    ]), { ...context, nativeValue: 100n }).touchedContracts).toContain(DEPLOYMENT.wrappedNative);
  });

  it('requires sweeps of both source remainder and output after partial unwrap', () => {
    const take = operation(0x0e, 'address,address,uint256', [DEPLOYMENT.wrappedNative, SELF, 0n]);
    const unwrap = operation(0x16, 'uint256', [1n]);
    expect(() => validateV4PositionManager(payload([modify(), take, unwrap, sweep(ZERO)]), context)).toThrow('owner sweep');
    expect(validateV4PositionManager(payload([
      modify(), take, unwrap, sweep(ZERO), sweep(DEPLOYMENT.wrappedNative),
    ]), context).operationCount).toBe(5);
  });

  it('resolves sender sentinel to the actual nested caller, not the backend owner', () => {
    const nested = { ...context, callerAddress: DEPLOYMENT.router };
    expect(() => validateV4PositionManager(payload([mint(SENDER)]), nested)).toThrow('recipient');
    expect(validateV4PositionManager(payload([
      mint(), operation(0x0d, 'address,address', [TOKEN0, TOKEN1]), sweep(ZERO),
    ]), nested).touchedContracts).toContain(UNISWAP_PERMIT2);
    expect(() => validateV4PositionManager(payload([
      mint(), operation(0x0e, 'address,address,uint256', [TOKEN0, SENDER, 0n]),
    ]), nested)).toThrow('recipient');
    expect(() => validateV4PositionManager(payload([
      mint(), operation(0x12, 'address', [TOKEN0]),
    ]), nested)).toThrow('close recipient');
  });

  it('requires native refunds for incoming value and every Router-forwarded balance', () => {
    const tokenSweep = sweep(TOKEN0);
    expect(() => validateV4PositionManager(payload([tokenSweep]), { ...context, nativeValue: 1n })).toThrow('owner sweep');
    expect(validateV4PositionManager(payload([tokenSweep, sweep(ZERO)]), { ...context, nativeValue: 1n }).operationCount).toBe(2);
    const nested = { ...context, callerAddress: DEPLOYMENT.router };
    expect(() => validateV4PositionManager(payload([mint()]), nested)).toThrow('owner sweep');
    expect(validateV4PositionManager(payload([mint(), sweep(ZERO)]), nested).operationCount).toBe(2);
  });

  it('accepts 64 operations but rejects empty, mismatched and oversized lists', () => {
    expect(validateV4PositionManager(payload(Array.from({ length: 64 }, () => modify())), context).operationCount).toBe(64);
    expect(() => validateV4PositionManager(payload([]), context)).toThrow();
    expect(() => validateV4PositionManager(payload(Array.from({ length: 65 }, () => modify())), context)).toThrow();
    expect(() => validateV4PositionManager(outer(abi('bytes,bytes[]', ['0x0001', [modify()[1]]])), context)).toThrow('action count');
  });

  it('rejects alternate ABI encodings at the root, unlock and individual parameter boundaries', () => {
    const valid = payload([mint()]);
    expect(() => validateV4PositionManager(`${valid}00`, context)).toThrow();
    const [code, params] = mint();
    expect(() => validateV4PositionManager(payload([[code, `${params}00`]]), context)).toThrow();
    const inner = abi('bytes,bytes[]', ['0x02', [params]]);
    expect(() => validateV4PositionManager(outer(`${inner}00`), context)).toThrow();
    expect(() => validateV4PositionManager(valid.slice(0, -2), context)).toThrow();
    expect(() => validateV4PositionManager(`0x3593564c${valid.slice(10)}`, context)).toThrow('selector');
  });

  it('rejects malformed scalar padding and unbounded inner lengths before allocation', () => {
    const valid = operation(0x0b, 'address,uint256,bool', [TOKEN0, 1n, true]);
    const invalidBool = `${valid[1].slice(0, -1)}2` as Hex;
    expect(() => validateV4PositionManager(payload([[0x0b, invalidBool]]), context)).toThrow();
    const invalidAddress = `0x1${valid[1].slice(3)}` as Hex;
    expect(() => validateV4PositionManager(payload([[0x0b, invalidAddress]]), context)).toThrow();
    const inner = abi('bytes,bytes[]', ['0x00', [modify()[1]]]);
    // The actions bytes length is the first word after the two-word head.
    const forged = `${inner.slice(0, 130)}${'f'.repeat(64)}${inner.slice(194)}` as Hex;
    expect(() => validateV4PositionManager(outer(forged), context)).toThrow();
    expect(() => validateV4PositionManager(`0xdd46508f${'00'.repeat(65_537)}`, context)).toThrow();
  });

  it.each([1, 10, 56, 137, 143, 8453, 42161])('uses the reviewed deployment for chain %s', (chainId) => {
    expect(validateV4PositionManager(payload([mint()]), { ...context, chainId }).touchedContracts)
      .toContain(UNISWAP_DEPLOYMENTS[chainId].positionManager);
  });

  it('rejects unsupported chains, invalid owners and native values outside uint256', () => {
    const data = payload([mint()]);
    expect(() => validateV4PositionManager(data, { ...context, chainId: 999 })).toThrow('chain');
    expect(() => validateV4PositionManager(data, { ...context, executionOwner: ZERO })).toThrow('owner');
    expect(() => validateV4PositionManager(data, { ...context, nativeValue: -1n })).toThrow('native value');
    expect(() => validateV4PositionManager(data, { ...context, nativeValue: 1n << 256n })).toThrow('native value');
  });
});
