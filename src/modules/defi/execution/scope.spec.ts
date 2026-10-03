import { executionScopeHash, NPM_MULTICALL_CHILD_SIGNATURES } from './scope';
import type { DefiExecutionScope } from '../defi.types';

const bindings = () => NPM_MULTICALL_CHILD_SIGNATURES.map((signature, index) => ({ capabilityId: `npm:${index}`, signature, abiHash: `0x${index.toString(16).padStart(64, '0')}` as `0x${string}` }));

describe('executionScopeHash', () => {
  it('normalizes child binding order while committing every concrete identity', () => {
    const first: DefiExecutionScope = { kind: 'same-target-multicall-v1', bytesArrayArgIndex: 0, allowedChildren: bindings() };
    const reordered: DefiExecutionScope = { ...first, allowedChildren: [...bindings()].reverse() };
    expect(executionScopeHash(first)).toBe(executionScopeHash(reordered));
    expect(executionScopeHash(first)).not.toBe(executionScopeHash({ ...first, allowedChildren: bindings().map((b, i) => i ? b : { ...b, capabilityId: 'changed' }) }));
  });

  it('rejects unknown keys, duplicate references, omitted required operations, and arbitrary child signatures', () => {
    const valid = { kind: 'same-target-multicall-v1', bytesArrayArgIndex: 0, allowedChildren: bindings() } as const;
    expect(() => executionScopeHash({ ...valid, extra: true } as never)).toThrow();
    expect(() => executionScopeHash({ ...valid, allowedChildren: bindings().slice(1) })).toThrow();
    expect(() => executionScopeHash({ ...valid, allowedChildren: bindings().map((b, i) => i ? b : { ...b, signature: 'permit(address)' }) })).toThrow();
    expect(() => executionScopeHash({ ...valid, allowedChildren: [...bindings().slice(0, 7), bindings()[0]] })).toThrow();
  });

  it('validates the empty-callback argument index and hashes the exact finite scope', () => {
    expect(executionScopeHash({ kind: 'empty-callback-data-v1', bytesArgIndex: 4 })).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => executionScopeHash({ kind: 'empty-callback-data-v1', bytesArgIndex: -1 })).toThrow();
    expect(() => executionScopeHash({ kind: 'empty-callback-data-v1', bytesArgIndex: 1, extra: true } as never)).toThrow();
  });
});
