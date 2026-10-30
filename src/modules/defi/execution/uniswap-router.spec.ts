import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, type Hex } from 'viem';
import { UNISWAP_DEPLOYMENTS, UNISWAP_PERMIT2, UNISWAP_ROUTER_ABI, UNISWAP_V4_POSITION_ABI } from './uniswap-deployments';
import { validateUniversalRouter } from './uniswap-router';

const owner = '0x1111111111111111111111111111111111111111';
const tokenA = '0x2222222222222222222222222222222222222222';
const tokenB = '0x3333333333333333333333333333333333333333';
const tokenC = '0x4444444444444444444444444444444444444444';
const stranger = '0x5555555555555555555555555555555555555555';
const zero = '0x0000000000000000000000000000000000000000';
const sender = '0x0000000000000000000000000000000000000001';
const self = '0x0000000000000000000000000000000000000002';
const context = { chainId: 1, executionOwner: owner, nativeValue: 0n };
const planTypes = 'bytes,bytes[]';
const singleTypes = '((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)';
const multiTypes = '(address,(address,uint24,int24,address,bytes)[],uint256[],uint128,uint128)';
const enc = (types: string, values: readonly unknown[]): Hex => encodeAbiParameters(parseAbiParameters(types), values);
const execute = (commands: Hex, inputs: readonly Hex[]): Hex => encodeFunctionData({ abi: [UNISWAP_ROUTER_ABI], functionName: 'execute', args: [commands, inputs, 123n] });
const payment = (token: string, recipient = owner, amount = 0n): Hex => enc('address,address,uint256', [token, recipient, amount]);
const swap = (version: 2 | 3, recipient = owner, prices: readonly bigint[] = [], payer = true): Hex => enc(
  version === 2 ? 'address,uint256,uint256,address[],bool,uint256[]' : 'address,uint256,uint256,bytes,bool,uint256[]',
  [recipient, 100n, 1n, version === 2 ? [tokenA, tokenB] : `0x${tokenA.slice(2)}000bb8${tokenB.slice(2)}`, payer, prices],
);
const actions = (codes: Hex, inputs: readonly Hex[]): Hex => enc(planTypes, [codes, inputs]);
const single = (hooks = zero, hookData: Hex = '0x'): Hex => enc(singleTypes, [[[tokenA, tokenB, 3000, 60, hooks], true, 100n, 1n, 0n, hookData]]);
const multi = (prices: readonly bigint[] = []): Hex => enc(multiTypes, [[tokenA, [[tokenB, 3000, 60, zero, '0x'], [tokenC, 500, 10, zero, '0x']], prices, 100n, 1n]]);

describe('Universal Router 2.1.2 finite execution language', () => {
  it.each([0x00, 0x01, 0x08, 0x09])('accepts pinned swap command %s with optional per-hop prices', (command) => {
    const version = command < 2 ? 3 : 2;
    const code = `0x${command.toString(16).padStart(2, '0')}` as Hex;
    for (const prices of [[], [10n ** 36n]]) {
      const result = validateUniversalRouter(execute(code, [swap(version, sender, prices)]), context);
      expect(result.operationCount).toBe(1);
      expect(result.touchedContracts).toEqual(expect.arrayContaining([UNISWAP_DEPLOYMENTS[1].router, tokenA, tokenB, UNISWAP_PERMIT2]));
    }
  });


  it.each([2, 3] as const)('rejects legacy V%s five-field swap encodings and mismatched prices', (version) => {
    const legacy = enc(version === 2 ? 'address,uint256,uint256,address[],bool' : 'address,uint256,uint256,bytes,bool', [owner, 100n, 1n, version === 2 ? [tokenA, tokenB] : `0x${tokenA.slice(2)}000bb8${tokenB.slice(2)}`, true]);
    const command = version === 2 ? '0x08' : '0x00';
    expect(() => validateUniversalRouter(execute(command, [legacy]), context)).toThrow();
    expect(() => validateUniversalRouter(execute(command, [swap(version, owner, [1n, 2n])]), context)).toThrow();
  });

  it('rejects malformed V3 packed paths, identical tokens, invalid fees, and native ERC20 paths', () => {
    for (const path of ['0x', `0x${tokenA.slice(2)}000bb8${tokenB.slice(2)}00`, `0x${tokenA.slice(2)}000000${tokenB.slice(2)}`, `0x${tokenA.slice(2)}000bb8${tokenA.slice(2)}`]) {
      const input = enc('address,uint256,uint256,bytes,bool,uint256[]', [owner, 1n, 1n, path, true, []]);
      expect(() => validateUniversalRouter(execute('0x00', [input]), context)).toThrow();
    }
    for (const path of [[tokenA], [tokenA, tokenA], [zero, tokenA]]) {
      const input = enc('address,uint256,uint256,address[],bool,uint256[]', [owner, 1n, 1n, path, true, []]);
      expect(() => validateUniversalRouter(execute('0x08', [input]), context)).toThrow();
    }
  });

  it('binds all mapped recipients to owner or intermediate router custody', () => {
    expect(() => validateUniversalRouter(execute('0x08', [swap(2, stranger)]), context)).toThrow();
    expect(() => validateUniversalRouter(execute('0x08', [swap(2, self)]), context)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x0804', [swap(2, self), payment(tokenB, sender)]), context).touchedContracts).toContain(tokenB);
    expect(() => validateUniversalRouter(execute('0x0805', [swap(2, self), payment(tokenB, sender, 1n)]), context)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x0805', [swap(2, self), payment(tokenB, sender, 1n << 255n)]), context).operationCount).toBe(2);
    expect(() => validateUniversalRouter(execute('0x04', [payment(tokenA, self)]), context)).toThrow();
    expect(() => validateUniversalRouter(execute('0x05', [payment(tokenA, stranger)]), context)).toThrow();
  });

  it('allows only owner-sourced Permit2 transfers and literal owner/router batch recipients', () => {
    const singleTransfer = enc('address,address,uint160', [tokenA, sender, 1n]);
    expect(validateUniversalRouter(execute('0x02', [singleTransfer]), context).touchedContracts).toContain(UNISWAP_PERMIT2);
    const batch = (from: string, to: string): Hex => enc('(address,address,uint160,address)[]', [[[from, to, 1n, tokenA]]]);
    const result = validateUniversalRouter(execute('0x0d04', [batch(owner, UNISWAP_DEPLOYMENTS[1].router), payment(tokenA)]), context);
    expect(result.operationCount).toBe(3);
    expect(result.touchedContracts).toEqual(expect.arrayContaining([tokenA, UNISWAP_PERMIT2]));
    for (const [from, to] of [[stranger, owner], [owner, stranger], [owner, sender], [owner, self]]) {
      expect(() => validateUniversalRouter(execute('0x0d', [batch(from, to)]), context)).toThrow();
    }
    expect(() => validateUniversalRouter(execute('0x02', [enc('address,address,uint160', [tokenA, stranger, 1n])]), context)).toThrow();
  });

  it.each(Object.keys(UNISWAP_DEPLOYMENTS).map(Number))('tracks chain %s wrapper and supports wrap→unwrap owner settlement', (chainId) => {
    const result = validateUniversalRouter(execute('0x0b0c', [enc('address,uint256', [self, 1n << 255n]), enc('address,uint256', [sender, 0n])]), { ...context, chainId, nativeValue: 1n });
    expect(result.touchedContracts).toContain(UNISWAP_DEPLOYMENTS[chainId].wrappedNative);
    expect(() => validateUniversalRouter(execute('0x0c', [enc('address,uint256', [self, 0n])]), { ...context, chainId })).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x0c04', [enc('address,uint256', [self, 0n]), payment(zero, sender)]), { ...context, chainId }).operationCount).toBe(2);
  });

  it.each([0x06, 0x07, 0x08, 0x09])('accepts pinned V4 swap action %s and implicit-owner settlement', (action) => {
    const input = action === 0x06 || action === 0x08 ? single() : multi([1n, 2n]);
    const v4 = actions(`0x${action.toString(16).padStart(2, '0')}0c0f` as Hex, [input, enc('address,uint256', [tokenA, 100n]), enc('address,uint256', [tokenB, 1n])]);
    const result = validateUniversalRouter(execute('0x10', [v4]), context);
    expect(result.operationCount).toBe(4);
    expect(result.touchedContracts).toEqual(expect.arrayContaining([tokenA, tokenB, UNISWAP_PERMIT2]));
  });

  it('supports V4 native currency, owner-only take, and router-source settle without Permit2', () => {
    const nativeSwap = enc(singleTypes, [[[zero, tokenB, 3000, 60, zero], true, 1n, 0n, 0n, '0x']]);
    const v4 = actions('0x060b0e', [nativeSwap, enc('address,uint256,bool', [zero, 0n, false]), payment(tokenB, sender)]);
    expect(validateUniversalRouter(execute('0x10', [v4]), context).touchedContracts).not.toContain(UNISWAP_PERMIT2);
    expect(() => validateUniversalRouter(execute('0x10', [actions('0x0e', [payment(tokenB, stranger)])]), context)).toThrow();
    expect(() => validateUniversalRouter(execute('0x10', [actions('0x0e', [payment(tokenB, self)])]), context)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x1004', [actions('0x0e', [payment(tokenB, self)]), payment(tokenB)]), context).operationCount).toBe(3);
  });

  it('rejects V4 hooks, hookData, obsolete structs, bad price arrays, and unsupported actions', () => {
    for (const input of [single(stranger), single(zero, '0x01'), enc('((address,address,uint24,int24,address),bool,uint128,uint128,bytes)', [[[tokenA, tokenB, 3000, 60, zero], true, 1n, 1n, '0x']])]) {
      expect(() => validateUniversalRouter(execute('0x10', [actions('0x06', [input])]), context)).toThrow();
    }
    expect(() => validateUniversalRouter(execute('0x10', [actions('0x07', [multi([1n])])]), context)).toThrow();
    for (const action of ['0x00', '0x0a', '0x0d', '0x10', '0x12', '0x14', '0x15', '0x16', '0x86'] as Hex[]) {
      expect(() => validateUniversalRouter(execute('0x10', [actions(action, ['0x'])]), context)).toThrow();
    }
  });

  it('bounds subplans and counts all nested commands/actions', () => {
    const nested = actions('0x08', [swap(2)]);
    expect(validateUniversalRouter(execute('0x21', [nested]), context).operationCount).toBe(2);
    const checks = Array.from({ length: 64 }, () => payment(tokenA));
    expect(validateUniversalRouter(execute(`0x${'04'.repeat(64)}`, checks), context).operationCount).toBe(64);
    expect(() => validateUniversalRouter(execute('0x21', [actions(`0x${'04'.repeat(64)}`, checks)]), context)).toThrow(/bound/);
    let deep = actions('0x08', [swap(2)]);
    for (let i = 0; i < 5; i++) deep = actions('0x21', [deep]);
    expect(() => validateUniversalRouter(execute('0x21', [deep]), context)).toThrow(/nesting/);
  });

  it.each([0x03, 0x06, 0x07, 0x0a, 0x0f, 0x11, 0x12, 0x13, 0x15, 0x40, 0x41, 0x80, 0x88, 0xa1, 0xff])('rejects permit, NFT, fee, bridge, pool-init, unknown or flag command %s', (command) => {
    expect(() => validateUniversalRouter(execute(`0x${command.toString(16).padStart(2, '0')}`, ['0x']), context)).toThrow();
  });

  it('returns only fixed PM modifyLiquidities mint children for independent parent authorization', () => {
    const child = (actionCodes: Hex): Hex => encodeFunctionData({ abi: [UNISWAP_V4_POSITION_ABI], functionName: 'modifyLiquidities', args: [actions(actionCodes, Array.from({ length: (actionCodes.length - 2) / 2 }, () => '0x' as Hex)), 123n] });
    const data = child('0x02');
    const result = validateUniversalRouter(execute('0x14', [data]), { ...context, nativeValue: 1n });
    expect(result.children).toEqual([{ to: UNISWAP_DEPLOYMENTS[1].positionManager, data }]);
    expect(result.touchedContracts).toContain(UNISWAP_DEPLOYMENTS[1].positionManager);
    for (const codes of ['0x00', '0x01', '0x03', '0x04', '0x05', '0x0200', '0x0d'] as Hex[]) {
      expect(() => validateUniversalRouter(execute('0x14', [child(codes)]), context)).toThrow();
    }
    expect(() => validateUniversalRouter(execute('0x14', [`0xdeadbeef${data.slice(10)}`]), context)).toThrow();
  });

  it('checks literal owner/router balance checks without mapping sentinel owners', () => {
    const check = (who: string): Hex => enc('address,address,uint256', [who, tokenA, 0n]);
    expect(validateUniversalRouter(execute('0x0e', [check(owner)]), context).touchedContracts).toContain(tokenA);
    expect(validateUniversalRouter(execute('0x0e', [check(UNISWAP_DEPLOYMENTS[1].router)]), context).operationCount).toBe(1);
    for (const who of [sender, self, stranger]) expect(() => validateUniversalRouter(execute('0x0e', [check(who)]), context)).toThrow();
  });

  it('rejects mismatched lengths, noncanonical outer/inner encodings, and oversized wire arrays', () => {
    expect(() => validateUniversalRouter(execute('0x', []), context)).toThrow();
    expect(() => validateUniversalRouter(execute('0x0808', [swap(2)]), context)).toThrow();
    expect(() => validateUniversalRouter(execute('0x10', [actions('0x0606', [single()])]), context)).toThrow();
    expect(() => validateUniversalRouter(`${execute('0x08', [swap(2)])}${'00'.repeat(32)}`, context)).toThrow();
    expect(() => validateUniversalRouter(execute('0x08', [`${swap(2)}${'00'.repeat(32)}`]), context)).toThrow();
    const nested = actions('0x08', [`${swap(2)}${'00'.repeat(32)}`]);
    expect(() => validateUniversalRouter(execute('0x21', [nested]), context)).toThrow();
    const oversized = enc('address,uint256,uint256,address[],bool,uint256[]', [owner, 1n, 1n, Array.from({ length: 65 }, () => tokenA), true, []]);
    expect(() => validateUniversalRouter(execute('0x08', [oversized]), context)).toThrow();
    const badBool = swap(2).slice(0, 2 + 4 * 64) + '0'.repeat(63) + '2' + swap(2).slice(2 + 5 * 64);
    expect(() => validateUniversalRouter(execute('0x08', [badBool as Hex]), context)).toThrow();
  });

  it('preserves funded-token custody across partial settlements and swaps until owner sweep', () => {
    const funding = enc('address,address,uint160', [tokenA, self, 100n]);
    const partialSettle = actions('0x0b0e', [enc('address,uint256,bool', [tokenA, 1n, false]), payment(tokenA, sender)]);
    expect(() => validateUniversalRouter(execute('0x0210', [funding, partialSettle]), context)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x021004', [funding, partialSettle, payment(tokenA)]), context).operationCount).toBe(5);
    const partialSwap = swap(2, owner, [], false);
    expect(() => validateUniversalRouter(execute('0x0208', [funding, partialSwap]), context)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x020804', [funding, partialSwap, payment(tokenA)]), context).operationCount).toBe(3);
  });

  it('requires an owner refund for attached native value and partial wrapping', () => {
    const funded = { ...context, nativeValue: 100n };
    const check = enc('address,address,uint256', [owner, tokenA, 0n]);
    expect(() => validateUniversalRouter(execute('0x0e', [check]), funded)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x0e04', [check, payment(zero)]), funded).operationCount).toBe(2);
    const partialWrap = enc('address,uint256', [sender, 1n]);
    expect(() => validateUniversalRouter(execute('0x0b', [partialWrap]), funded)).toThrow(/intermediate/);
    expect(validateUniversalRouter(execute('0x0b04', [partialWrap, payment(zero)]), funded).touchedContracts).toContain(UNISWAP_DEPLOYMENTS[1].wrappedNative);
  });

  it('rejects wrong roots, chains, owners and native value bounds', () => {
    expect(() => validateUniversalRouter('0x24856bc3', context)).toThrow();
    for (const invalid of [{ ...context, chainId: 999 }, { ...context, executionOwner: zero }, { ...context, executionOwner: sender }, { ...context, executionOwner: UNISWAP_DEPLOYMENTS[1].router }, { ...context, nativeValue: -1n }, { ...context, nativeValue: 1n << 256n }]) {
      expect(() => validateUniversalRouter(execute('0x08', [swap(2)]), invalid)).toThrow();
    }
  });
});
