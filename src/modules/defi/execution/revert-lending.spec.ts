import { encodeFunctionData, type Hex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';
import { validateRevertLending, validateRevertLendingBinding } from './revert-lending';

const receiver = '0x2222222222222222222222222222222222222222';
const methods = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope?.kind === 'revert-empty-lending-permit-v1');
function request(fn: DefiFunctionPolicy, permitData: Hex = '0x'): Hex {
  const args = fn.functionName === 'repay' ? [1n, 1n, true, permitData] : [1n, receiver, permitData];
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args });
}
function word(data: string, index: number, value: bigint): string {
  const offset = 10 + index * 64;
  return `${data.slice(0, offset)}${value.toString(16).padStart(64, '0')}${data.slice(offset + 64)}`;
}

describe('Revert exact-empty lending and repayment permit boundary', () => {
  it.each(methods)('rejects every nonempty raw permit shape for $functionName', (fn) => {
    for (const bytes of ['0x00', '0x01', `0x${'00'.repeat(224)}`, `0x${'11'.repeat(256)}`] as Hex[]) {
      expect(() => validateRevertLending(request(fn, bytes))).toThrow();
    }
  });

  it.each(methods)('rejects malformed and noncanonical $functionName encodings', (fn) => {
    const data = request(fn);
    const permitIndex = fn.abi.inputs.length - 1;
    const dirtyScalar = fn.functionName === 'repay'
      ? word(data, 2, 2n)
      : word(data, 1, (1n << 160n) + BigInt(receiver));
    for (const invalid of ['0x', data.slice(0, 10), data.slice(0, -2), `${data}00`, dirtyScalar,
      word(data, permitIndex, 1n), word(data, permitIndex, (1n << 256n) - 1n),
      `${data.slice(0, 10)}${'00'.repeat(65_537)}`, `${data.slice(0, -1)}g`]) {
      expect(() => validateRevertLending(invalid)).toThrow();
    }
  });

  it.each(methods)('does not interpret ordinary $functionName calldata as the scoped overload', (fn) => {
    const plain = { ...fn.abi, inputs: fn.abi.inputs.slice(0, -1) };
    const args = fn.functionName === 'repay' ? [1n, 1n, true] : [1n, receiver];
    const data = encodeFunctionData({ abi: [plain], functionName: plain.name, args });
    expect(() => validateRevertLending(data)).toThrow();
  });

  it.each(methods)('cannot remove, widen or transplant the $functionName binding', (fn) => {
    const variants: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: fn.abi.inputs.length - 1 } },
      { ...fn, executionScope: { ...fn.executionScope, permitIndex: fn.abi.inputs.length - 1 } as unknown as DefiExecutionScope },
      { ...fn, contract: receiver }, { ...fn, chainId: 1 }, { ...fn, type: 'typed_data_sign' },
      { ...fn, signature: 'withdraw(uint256,address,address)' }, { ...fn, functionName: 'withdraw' },
      { ...fn, abi: { ...fn.abi, stateMutability: 'payable' } },
      { ...fn, abi: { ...fn.abi, outputs: [] } },
      { ...fn, abi: { ...fn.abi, inputs: fn.abi.inputs.map((input, i) => i === fn.abi.inputs.length - 1 ? { ...input, name: 'uncheckedData' } : input) } },
    ];
    for (const variant of variants) expect(() => validateRevertLendingBinding(variant)).toThrow();
  });
});
