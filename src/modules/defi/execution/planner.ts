import type { DefiExecutionPlanNode } from '../defi.types';

export const MAX_DEFI_EXECUTION_NODES = 10;

/** Preflights the bytes[] wire shape before ABI decoding can allocate child data. */
export function preflightBytesArray(calldata: string, argIndex = 0): number {
  if (!Number.isSafeInteger(argIndex) || argIndex < 0 || !/^0x(?:[0-9a-f]{2})+$/i.test(calldata) || calldata.length < 10 + 128) throw new TypeError('Malformed ABI bytes[]');
  const body = calldata.slice(10);
  const bytes = BigInt(body.length / 2);
  const read = (offset: bigint): bigint => {
    if (offset < 0n || offset + 32n > bytes) throw new TypeError('Malformed ABI bytes[]');
    return BigInt(`0x${body.slice(Number(offset * 2n), Number((offset + 32n) * 2n))}`);
  };
  const headOffset = read(BigInt(argIndex * 32));
  if (headOffset % 32n !== 0n || headOffset < 32n) throw new TypeError('Malformed ABI bytes[] offset');
  const count = read(headOffset);
  if (count < 1n || count > BigInt(MAX_DEFI_EXECUTION_NODES)) throw new TypeError('ABI bytes[] bound exceeded');
  const base = headOffset + 32n;
  const headEnd = base + count * 32n;
  if (headEnd > bytes) throw new TypeError('Malformed ABI bytes[] head');
  let previousEnd = headEnd;
  for (let index = 0n; index < count; index++) {
    const relative = read(base + index * 32n);
    if (relative % 32n !== 0n || relative < count * 32n) throw new TypeError('Malformed ABI bytes[] element offset');
    const lengthWord = base + relative;
    const length = read(lengthWord);
    const paddedEnd = lengthWord + 32n + ((length + 31n) / 32n) * 32n;
    if (length < 4n || length > 65_536n || lengthWord < previousEnd || paddedEnd > bytes) throw new TypeError('Malformed ABI bytes[] element');
    previousEnd = paddedEnd;
  }
  return Number(count);
}

export function sameExecutionPlan(actual: readonly DefiExecutionPlanNode[], expected: readonly DefiExecutionPlanNode[], sameMatch: (a: DefiExecutionPlanNode['match'], b: DefiExecutionPlanNode['match']) => boolean): boolean {
  return actual.length === expected.length && expected.every((node, index) => {
    const candidate = actual[index];
    return !!candidate && candidate.data === node.data && Array.isArray(candidate.path) && candidate.path.length === node.path.length && candidate.path.every((part, pathIndex) => part === node.path[pathIndex]) && sameMatch(candidate.match, node.match);
  });
}
