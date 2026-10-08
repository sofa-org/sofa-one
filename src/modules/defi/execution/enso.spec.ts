import * as viem from 'viem';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from './enso-identity';
import { decodeEnsoStaticWeirollRoot } from './enso';

const ROOT_ABI = parseAbi(['function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes response)']);
const SHORTCUT_ABI = parseAbi(['function executeShortcut(bytes32 accountId, bytes32 requestId, bytes32[] commands, bytes[] state)']);
const encodeFn = encodeFunctionData as (parameters: any) => Hex;
const parseDynamicAbi = parseAbi as unknown as (signatures: string[]) => any;
const account = `0x${'11'.repeat(32)}` as Hex;
const request = `0x${'22'.repeat(32)}` as Hex;
const selector = (signature: string) => toFunctionSelector(signature).slice(2);

function command(target: string, signature: string, flag: number, stateIndex: number, header = selector(signature), output = 0xff, indices?: number[]): Hex {
  const slots = indices ?? (flag === 0x21 ? [stateIndex, 255, 255, 255, 255, 255] : [stateIndex, stateIndex + 1, 255, 255, 255, 255]);
  return `0x${header}${flag.toString(16).padStart(2, '0')}${slots.map((value) => value.toString(16).padStart(2, '0')).join('')}${output.toString(16).padStart(2, '0')}${target.slice(2)}` as Hex;
}

function root(tokenType: 0 | 1, tokenData: Hex, commands: Hex[], state: Hex[]): Hex {
  const inner = encodeFunctionData({ abi: SHORTCUT_ABI, functionName: 'executeShortcut', args: [account, request, commands, state] });
  return encodeFn({ abi: ROOT_ABI, functionName: 'routeSingle', args: [{ tokenType, data: tokenData }, inner] });
}

function overwriteWord(data: Hex, byteOffset: number, value: bigint): Hex {
  const start = 2 + byteOffset * 2;
  return `${data.slice(0, start)}${value.toString(16).padStart(64, '0')}${data.slice(start + 64)}` as Hex;
}

const childCalls = [
  encodeFn({ abi: parseDynamicAbi([`function ${ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[0].signature}`]), functionName: 'exactInputSingle', args: [[`0x${'11'.repeat(20)}`, `0x${'22'.repeat(20)}`, 3000, `0x${'33'.repeat(20)}`, 1n, 2n, 0n]] }),
  encodeFn({ abi: parseDynamicAbi([`function ${ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[1].signature}`]), functionName: 'supply', args: [`0x${'11'.repeat(20)}`, 2n, `0x${'22'.repeat(20)}`, 0] }),
  encodeFn({ abi: parseDynamicAbi([`function ${ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2].signature}`]), functionName: 'approve', args: [`0x${'22'.repeat(20)}`, 3n] }),
];

function nativeData(amount: bigint): Hex { return encodeAbiParameters(parseAbiParameters('uint256'), [amount]); }
function erc20Data(token: `0x${string}` = `0x${'44'.repeat(20)}`, amount = 999n): Hex { return encodeAbiParameters(parseAbiParameters('address, uint256'), [token, amount]); }

describe('decodeEnsoStaticWeirollRoot', () => {
  it('decodes canonical native and ERC-20 roots with all three literal child selectors', () => {
    const state = childCalls;
    const commands = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((child, index) => command(child.contract, child.signature, 0x21, index));
    const decodedNative = decodeEnsoStaticWeirollRoot(root(0, nativeData(7n), commands, state), 7n);
    expect(decodedNative.children.map((child) => child.target)).toEqual(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((child) => child.contract));
    expect(decodedNative.children.map((child) => child.value)).toEqual([0n, 0n, 0n]);
    expect(decodedNative).toMatchObject({ commandCount: 3, stateCount: 3, childValueSum: 0n, tokenType: 0 });
    expect(decodeEnsoStaticWeirollRoot(root(1, erc20Data(), commands, state), 0n).tokenType).toBe(1);
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(7n), commands, state), 6n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(1, erc20Data(), commands, state), 1n)).toThrow();
  });

  it('decodes CALL and VALUECALL exactly, preserves uint256 values, and permits child sum above root value', () => {
    const max = (1n << 256n) - 1n;
    const state = [encodeAbiParameters(parseAbiParameters('uint256'), [max]), childCalls[2], childCalls[0]];
    const commands = [
      command(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2].contract, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2].signature, 0x23, 0),
      command(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[0].contract, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[0].signature, 0x21, 2),
    ];
    const decoded = decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), commands, state), 0n);
    expect(decoded.children.map(({ value }) => value)).toEqual([max, 0n]);
    expect(decoded.childValueSum).toBe(max);
    const twice = decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [commands[0], command(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2].contract, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2].signature, 0x23, 2)], [state[0], state[1], state[0], state[1]]), 0n);
    expect(twice.childValueSum).toBe(max * 2n);
  });

  it('accepts 9 commands/18 sequential state entries and rejects empty, excess command/state, unused, or reordered state', () => {
    const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2];
    const commands = Array.from({ length: 9 }, (_, index) => command(child.contract, child.signature, 0x23, index * 2));
    const state = Array.from({ length: 9 }, () => [nativeData(0n), childCalls[2]]).flat();
    expect(decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), commands, state), 0n).commandCount).toBe(9);
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [], []), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [...commands, commands[0]], [...state, ...state.slice(0, 2)]), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), commands, [...state, childCalls[2]]), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [commands[0]], state.slice(0, 3)), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [command(child.contract, child.signature, 0x21, 1)], [childCalls[2], childCalls[2]]), 0n)).toThrow();
  });

  it('rejects hostile inner array counts and aliased tails before invoking viem inner ABI decoding', () => {
    const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2];
    const cmd = command(child.contract, child.signature, 0x21, 0);
    const canonical = encodeFunctionData({ abi: SHORTCUT_ABI, functionName: 'executeShortcut', args: [account, request, [cmd], [childCalls[2]]] });
    const malformed = [
      overwriteWord(canonical, 132, 1000n), // 1,000 commands
      overwriteWord(canonical, 132, (1n << 256n) - 1n),
      overwriteWord(canonical, 132, 10n), // above command bound
      overwriteWord(canonical, 196, 1000n), // 1,000 aliased state elements
      overwriteWord(canonical, 196, (1n << 256n) - 1n),
      overwriteWord(canonical, 196, 19n), // above state bound
      overwriteWord(canonical, 228, 0n), // element points into its offset table
      overwriteWord(canonical, 228, (1n << 256n) - 1n),
    ];
    for (const inner of malformed) {
      const outer = encodeFn({ abi: ROOT_ABI, functionName: 'routeSingle', args: [{ tokenType: 0, data: nativeData(0n) }, inner] });
      const decodeSpy = jest.spyOn(viem, 'decodeFunctionData');
      try {
        expect(() => decodeEnsoStaticWeirollRoot(outer, 0n)).toThrow();
        expect(decodeSpy).not.toHaveBeenCalled();
      } finally {
        decodeSpy.mockRestore();
      }
    }
  });

  it('rejects malformed root/token/shortcut ABI encodings, types, selector, size, and native value range', () => {
    const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2];
    const cmd = command(child.contract, child.signature, 0x21, 0);
    const valid = root(0, nativeData(0n), [cmd], [childCalls[2]]);
    expect(() => decodeEnsoStaticWeirollRoot(`${valid}00` as Hex, 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(`0x00000000${valid.slice(10)}` as Hex, 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(2 as 0, nativeData(0n), [cmd], [childCalls[2]]), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(0, `${nativeData(0n)}00` as Hex, [cmd], [childCalls[2]]), 0n)).toThrow();
    const inner = encodeFunctionData({ abi: SHORTCUT_ABI, functionName: 'executeShortcut', args: [account, request, [cmd], [childCalls[2]]] });
    expect(() => decodeEnsoStaticWeirollRoot(encodeFn({ abi: ROOT_ABI, functionName: 'routeSingle', args: [{ tokenType: 0, data: nativeData(0n) }, `${inner}00` as Hex] }), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(valid, -1n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(valid, 1n << 256n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(`0x${'00'.repeat(65_537)}` as Hex, 0n)).toThrow();
  });

  it('rejects every unsupported flag and malformed command fields, selectors, targets, indices, and child payloads', () => {
    const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2];
    const validState = [childCalls[2]];
    for (let flag = 0; flag < 256; flag++) {
      if (flag === 0x21) continue;
      const invalid = command(child.contract, child.signature, flag, 0);
      expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [invalid], validState), 0n)).toThrow();
    }
    const invalidCommands = [
      command(child.contract, child.signature, 0x21, 0, '00000000'),
      command(child.contract, child.signature, 0x21, 0, undefined, 0),
      command(child.contract, child.signature, 0x21, 0, undefined, 0xff, [0, 0xff, 0, 0xff, 0xff, 0xff]),
      command(child.contract, child.signature, 0x21, 0, undefined, 0xff, [0x80, 0xff, 0xff, 0xff, 0xff, 0xff]),
      command(`0x${'00'.repeat(20)}`, child.signature, 0x21, 0),
      command(child.contract, child.signature, 0x21, 0, selector(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[0].signature)),
      command(child.contract, child.signature, 0x21, 0, undefined, undefined, [0, 1, 2, 3, 4, 5]),
    ];
    for (const invalid of invalidCommands) expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [invalid], validState), 0n)).toThrow();
    const invalidData = `${childCalls[2]}00` as Hex;
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [command(child.contract, child.signature, 0x21, 0)], [invalidData]), 0n)).toThrow();
    expect(() => decodeEnsoStaticWeirollRoot(root(0, nativeData(0n), [command(child.contract, child.signature, 0x23, 0)], [nativeData(0n), childCalls[2]]), 0n)).not.toThrow();
  });

  it('does not treat account/request metadata or child financial arguments as decoder authorization', () => {
    const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2];
    const alteredAccount = `0x${'ff'.repeat(32)}` as Hex;
    const inner = encodeFn({ abi: SHORTCUT_ABI, functionName: 'executeShortcut', args: [alteredAccount, `0x${'ee'.repeat(32)}`, [command(child.contract, child.signature, 0x21, 0)], [encodeFn({ abi: parseDynamicAbi([`function ${child.signature}`]), functionName: 'approve', args: [`0x${'99'.repeat(20)}`, (1n << 256n) - 1n] })]] });
    const outer = encodeFn({ abi: ROOT_ABI, functionName: 'routeSingle', args: [{ tokenType: 1, data: erc20Data() }, inner] });
    expect(decodeEnsoStaticWeirollRoot(outer, 0n).children).toHaveLength(1);
    expect(ENSO_STATIC_WEIROLL_ROOT_IDENTITY.selector).toBe('0xb94c3609');
  });
});
