import { encodeFunctionData, type AbiFunction, type Hex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';
import { validateVeloraOrderBinding, validateVeloraOrderSettlement } from './velora';

const receiver = '0x2222222222222222222222222222222222222222';
const methods = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope?.kind === 'velora-empty-permit-settlement-v1');
function argsFor(abi: AbiFunction, permit: Hex = '0x', position = 3, itemIndex = 0): unknown[] {
  const batch = abi.inputs[0].type === 'tuple[]';
  const orderParam = batch && 'components' in abi.inputs[0] ? abi.inputs[0].components[0] : abi.inputs[0];
  if (!('components' in orderParam)) throw new Error('Missing order tuple');
  const order = orderParam.components.map((p) => p.type === 'address' ? receiver : 1n);
  const item = () => [order, '0xdeadbeef', 1n, '0x', '0x'];
  if (batch) {
    const items = [item(), item(), item()];
    items[itemIndex][position] = permit;
    return abi.inputs.length === 2 ? [items, receiver] : [items, 1n, receiver];
  }
  const args: unknown[] = [order, '0xdeadbeef', 1n, receiver, '0x', '0x'];
  args[position + 1] = permit;
  return args;
}
function encode(abi: AbiFunction, args: unknown[]): Hex {
  return encodeFunctionData({ abi: [abi], functionName: abi.name, args } as never);
}

describe('Velora exact empty permit settlement boundary', () => {
  it.each(methods)('rejects either explicit permit in every supplied item of $functionName', (record) => {
    const abi = record.abi as AbiFunction;
    for (const position of [3, 4]) {
      for (const permit of ['0x01', `0x${'11'.repeat(224)}`, `0x${'22'.repeat(256)}`] as Hex[]) {
        for (const item of abi.inputs[0].type === 'tuple[]' ? [0, 1, 2] : [0]) {
          expect(() => validateVeloraOrderSettlement(encode(abi, argsFor(abi, permit, position, item)))).toThrow();
        }
      }
    }
  });

  it.each(methods)('rejects malformed and noncanonical $functionName wire', (record) => {
    const abi = record.abi as AbiFunction;
    const data = encode(abi, argsFor(abi));
    for (const invalid of [data.slice(0, -2), `${data}00`, data.slice(0, 10), '0x12345678', `${data.slice(0, 10)}${'00'.repeat(65_537)}`]) {
      expect(() => validateVeloraOrderSettlement(invalid)).toThrow();
    }
    // Batch head offsets and the individual order's uint128 expiry have canonical bounds.
    const offset = 10 + (abi.inputs[0].type === 'tuple[]' ? 0 : 64);
    const dirty = `${data.slice(0, offset)}ff${data.slice(offset + 2)}`;
    expect(() => validateVeloraOrderSettlement(dirty)).toThrow();
  });

  it.each(methods)('reserves full deployment ABI and mandatory scope for $functionName', (record) => {
    const fn = record as unknown as DefiFunctionPolicy;
    const changes: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 4 } },
      { ...fn, executionScope: { ...fn.executionScope, extra: 1 } as unknown as DefiExecutionScope },
      { ...fn, chainId: 10 }, { ...fn, contract: receiver }, { ...fn, type: 'typed_data_sign' },
      { ...fn, functionName: 'fillOrder' }, { ...fn, signature: 'fillOrder(bytes)' },
      { ...fn, abi: { ...fn.abi, stateMutability: 'payable' } },
      { ...fn, abi: { ...fn.abi, outputs: [{ type: 'bytes', name: 'payload' }] } },
      { ...fn, abi: { ...fn.abi, inputs: fn.abi.inputs.slice(1) } },
    ];
    for (const changed of changes) expect(() => validateVeloraOrderBinding(changed)).toThrow();
  });
});
