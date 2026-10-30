import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
} from 'viem';
import type { Hex } from 'viem';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from './enso-identity';

const ROOT_ABI = parseAbi(['function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes response)']);
const ROOT_PARAMS = parseAbiParameters('(uint8 tokenType, bytes data), bytes');
const NATIVE_PARAMS = parseAbiParameters('uint256');
const ERC20_PARAMS = parseAbiParameters('address, uint256');
const SHORTCUT_ABI = parseAbi(['function executeShortcut(bytes32 accountId, bytes32 requestId, bytes32[] commands, bytes[] state)']);
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_ROOT_BYTES = 65_536;
const MAX_COMMANDS = 9;
const MAX_STATE = 18;
const CALL_FLAG = 0x21;
const VALUECALL_FLAG = 0x23;
const NO_INDEX = 0xff;
const parseDynamicAbi = parseAbi as unknown as (signatures: string[]) => any;
const encodeDynamicFunctionData = encodeFunctionData as (parameters: any) => Hex;

export type EnsoStaticWeirollChild = Readonly<{
  target: `0x${string}`;
  data: Hex;
  value: bigint;
}>;

export type DecodedEnsoStaticWeirollRoot = Readonly<{
  children: readonly EnsoStaticWeirollChild[];
  commandCount: number;
  stateCount: number;
  childValueSum: bigint;
  tokenType: 0 | 1;
}>;

function assertHexBounded(data: string): asserts data is Hex {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + MAX_ROOT_BYTES * 2) {
    throw new TypeError('Invalid or oversized Enso root calldata');
  }
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function readAbiWord(data: Hex, offset: bigint, totalBytes: bigint): bigint {
  if (offset < 0n || offset + 32n > totalBytes) throw new TypeError('Truncated Enso shortcut ABI word');
  const start = 2 + Number(offset) * 2;
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

/** Bound dynamic array cardinalities and prove canonical, contiguous ABI tails before viem allocates arrays. */
function preflightShortcutAbi(data: Hex): { commandCount: number; stateCount: number } {
  const totalBytes = BigInt((data.length - 2) / 2);
  if (totalBytes < 4n + 128n || !sameHex(data.slice(0, 10), '0x95352c9f')) throw new TypeError('Invalid Enso shortcut selector or head');

  const headStart = 4n;
  const commandOffset = readAbiWord(data, headStart + 64n, totalBytes);
  const stateOffset = readAbiWord(data, headStart + 96n, totalBytes);
  if (commandOffset !== 128n) throw new TypeError('Non-canonical Enso commands offset');

  const commandLengthPosition = headStart + commandOffset;
  const commandCountValue = readAbiWord(data, commandLengthPosition, totalBytes);
  if (commandCountValue < 1n || commandCountValue > BigInt(MAX_COMMANDS)) throw new TypeError('Enso command limit exceeded');
  const commandCount = Number(commandCountValue);
  const commandTailEnd = commandLengthPosition + 32n + commandCountValue * 32n;
  if (commandTailEnd > totalBytes) throw new TypeError('Truncated Enso commands array');

  const expectedStateOffset = 128n + 32n + commandCountValue * 32n;
  if (stateOffset !== expectedStateOffset) throw new TypeError('Non-canonical Enso state offset');
  const stateLengthPosition = headStart + stateOffset;
  const stateCountValue = readAbiWord(data, stateLengthPosition, totalBytes);
  if (stateCountValue < 1n || stateCountValue > BigInt(MAX_STATE)) throw new TypeError('Enso state limit exceeded');
  const stateCount = Number(stateCountValue);
  const stateTableStart = stateLengthPosition + 32n;
  const stateTableEnd = stateTableStart + stateCountValue * 32n;
  if (stateTableEnd > totalBytes) throw new TypeError('Truncated Enso state offsets');

  let expectedElementOffset = stateCountValue * 32n;
  for (let index = 0; index < stateCount; index++) {
    const offsetWordPosition = stateTableStart + BigInt(index) * 32n;
    const elementOffset = readAbiWord(data, offsetWordPosition, totalBytes);
    if (elementOffset !== expectedElementOffset) throw new TypeError('Non-canonical Enso state element offset');
    const elementLengthPosition = stateTableStart + elementOffset;
    const elementLength = readAbiWord(data, elementLengthPosition, totalBytes);
    const elementDataStart = elementLengthPosition + 32n;
    const paddedLength = ((elementLength + 31n) / 32n) * 32n;
    const elementEnd = elementDataStart + paddedLength;
    if (elementEnd > totalBytes) throw new TypeError('Truncated Enso state element');
    const paddingLength = paddedLength - elementLength;
    if (paddingLength > 0n) {
      const paddingStart = 2 + Number(elementDataStart + elementLength) * 2;
      const paddingEnd = 2 + Number(elementEnd) * 2;
      if (!/^0*$/.test(data.slice(paddingStart, paddingEnd))) throw new TypeError('Nonzero Enso state padding');
    }
    expectedElementOffset += 32n + paddedLength;
  }
  if (stateTableStart + expectedElementOffset !== totalBytes) throw new TypeError('Non-canonical Enso shortcut tail length');
  return { commandCount, stateCount };
}

/** Decode only the closed static Weiroll v1 grammar; this is not an authorization decision. */
export function decodeEnsoStaticWeirollRoot(rootData: Hex, nativeValue: bigint): DecodedEnsoStaticWeirollRoot {
  assertHexBounded(rootData);
  if (nativeValue < 0n || nativeValue > MAX_UINT256) throw new TypeError('Invalid Enso root native value');
  if (rootData.length < 10 || !sameHex(rootData.slice(0, 10), ENSO_STATIC_WEIROLL_ROOT_IDENTITY.selector)) throw new TypeError('Invalid Enso root selector');

  const [tokenIn, innerData] = decodeAbiParameters(ROOT_PARAMS, `0x${rootData.slice(10)}`);
  const { tokenType, data: tokenData } = tokenIn as { tokenType: number; data: Hex };
  if (!sameHex(encodeFunctionData({ abi: ROOT_ABI, functionName: 'routeSingle', args: [{ tokenType, data: tokenData }, innerData] }), rootData)) {
    throw new TypeError('Non-canonical Enso root calldata');
  }

  if (tokenType !== 0 && tokenType !== 1) throw new TypeError('Unsupported Enso token type');
  if (tokenType === 0) {
    const [amount] = decodeAbiParameters(NATIVE_PARAMS, tokenData);
    if (!sameHex(encodeAbiParameters(NATIVE_PARAMS, [amount]), tokenData) || amount !== nativeValue) throw new TypeError('Invalid Enso native token data');
  } else {
    const [token, amount] = decodeAbiParameters(ERC20_PARAMS, tokenData);
    if (!sameHex(encodeAbiParameters(ERC20_PARAMS, [token, amount]), tokenData) || nativeValue !== 0n) throw new TypeError('Invalid Enso ERC-20 token data');
  }

  const boundedCounts = preflightShortcutAbi(innerData);
  const decoded = decodeFunctionData({ abi: SHORTCUT_ABI, data: innerData });
  if (decoded.functionName !== 'executeShortcut') throw new TypeError('Unsupported Enso shortcut call');
  const [accountId, requestId, commands, state] = decoded.args as readonly [`0x${string}`, `0x${string}`, readonly `0x${string}`[], readonly Hex[]];
  if (!/^0x[0-9a-f]{64}$/i.test(accountId) || !/^0x[0-9a-f]{64}$/i.test(requestId)) throw new TypeError('Invalid Enso metadata');
  if (commands.length !== boundedCounts.commandCount || state.length !== boundedCounts.stateCount) throw new TypeError('Inconsistent Enso shortcut ABI counts');
  if (!sameHex(encodeFunctionData({ abi: SHORTCUT_ABI, functionName: 'executeShortcut', args: [accountId, requestId, commands, state] }), innerData)) {
    throw new TypeError('Non-canonical Enso shortcut calldata');
  }

  const parsed: EnsoStaticWeirollChild[] = [];
  let stateIndex = 0;
  let childValueSum = 0n;
  for (const command of commands) {
    if (command.length !== 66) throw new TypeError('Invalid Enso command width');
    const bytes = command.slice(2).toLowerCase();
    const headerSelector = `0x${bytes.slice(0, 8)}`;
    const flag = Number.parseInt(bytes.slice(8, 10), 16);
    const indices = Array.from({ length: 6 }, (_, index) => Number.parseInt(bytes.slice(10 + index * 2, 12 + index * 2), 16));
    const output = Number.parseInt(bytes.slice(22, 24), 16);
    const target = `0x${bytes.slice(24, 64)}` as `0x${string}`;
    if (output !== NO_INDEX) throw new TypeError('Enso command output must be discarded');

    let value = 0n;
    let data: Hex;
    if (flag === CALL_FLAG) {
      if (indices[0] !== stateIndex || indices.slice(1).some((index) => index !== NO_INDEX)) throw new TypeError('Invalid Enso CALL state indices');
      data = state[stateIndex++];
    } else if (flag === VALUECALL_FLAG) {
      if (indices[0] !== stateIndex || indices[1] !== stateIndex + 1 || indices.slice(2).some((index) => index !== NO_INDEX)) throw new TypeError('Invalid Enso VALUECALL state indices');
      const encodedValue = state[stateIndex++];
      if (encodedValue.length !== 66) throw new TypeError('Invalid Enso value state width');
      value = BigInt(encodedValue);
      data = state[stateIndex++];
    } else throw new TypeError('Unsupported Enso command flag');

    if (data.length < 10) throw new TypeError('Invalid Enso child calldata');
    const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.find((identity) => identity.contract === target.toLowerCase());
    if (!child) throw new TypeError('Unsupported Enso child target');
    const childAbi = parseDynamicAbi([`function ${child.signature}`]);
    const selector = toFunctionSelector(child.signature);
    if (!sameHex(headerSelector, selector) || !sameHex(data.slice(0, 10), selector)) throw new TypeError('Enso child selector mismatch');
    const args = decodeFunctionData({ abi: childAbi, data }).args;
    if (!sameHex(encodeDynamicFunctionData({ abi: childAbi, functionName: child.signature.slice(0, child.signature.indexOf('(')), args }), data)) throw new TypeError('Non-canonical Enso child calldata');
    parsed.push(Object.freeze({ target: child.contract as `0x${string}`, data, value }));
    childValueSum += value;
  }
  if (stateIndex !== state.length) throw new TypeError('Unused Enso shortcut state');
  return Object.freeze({ children: Object.freeze(parsed), commandCount: commands.length, stateCount: state.length, childValueSum, tokenType });
}
