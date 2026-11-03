import { executionScopeHash, NPM_MULTICALL_CHILD_SIGNATURES } from './scope';
import type { DefiExecutionScope } from '../defi.types';
import { createEnsoStaticWeirollScope, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES } from './enso-identity';
import { POLYMARKET_PUSD_WRAP_SCOPE } from './pusd-identity';

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

  it('hashes the exact closed Ambient callpath and bytes indices', () => {
    expect(executionScopeHash({ kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => executionScopeHash({ kind: 'ambient-coldpath-v1', callpathArgIndex: 1, bytesArgIndex: 1 } as never)).toThrow();
    expect(() => executionScopeHash({ kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 2 } as never)).toThrow();
    expect(() => executionScopeHash({ kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 1, commands: [1, 2] } as never)).toThrow();
  });

  it('hashes only the three exact Enso static Weiroll child identities independent of their input order', () => {
    const scope = createEnsoStaticWeirollScope();
    expect(executionScopeHash(scope)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(executionScopeHash(scope)).toBe(executionScopeHash({ ...scope, allowedChildren: [...scope.allowedChildren].reverse() }));
    expect(Object.isFrozen(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES)).toBe(true);
    expect(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES).toHaveLength(3);
  });

  it('rejects any malformed, extra, duplicate, missing, or altered Enso child binding', () => {
    const valid = createEnsoStaticWeirollScope();
    expect(() => executionScopeHash({ ...valid, extra: true } as never)).toThrow();
    expect(() => executionScopeHash({ kind: 'enso-static-weiroll-v1' } as never)).toThrow();
    expect(() => executionScopeHash({ ...valid, allowedChildren: valid.allowedChildren.slice(1) })).toThrow();
    expect(() => executionScopeHash({ ...valid, allowedChildren: [...valid.allowedChildren, valid.allowedChildren[0]] })).toThrow();
    for (const [index, altered] of valid.allowedChildren.entries()) {
      const children = [...valid.allowedChildren];
      const mutations = [
        { ...altered, chainId: 10 },
        { ...altered, contract: '0x0000000000000000000000000000000000000001' },
        { ...altered, capabilityId: 'unreviewed:child' },
        { ...altered, signature: 'permit(address)' },
        { ...altered, abiHash: `0x${'0'.repeat(64)}` },
        { ...altered, extra: true },
      ];
      for (const mutation of mutations) {
        const changed = [...children]; changed[index] = mutation as typeof altered;
        expect(() => executionScopeHash({ ...valid, allowedChildren: changed })).toThrow();
      }
    }
    expect(executionScopeHash({ ...valid, allowedChildren: valid.allowedChildren.map((child) => ({ ...child, contract: child.contract.toUpperCase() })) })).toBe(executionScopeHash(valid));
  });

  it('hashes the fixed pUSD scope and rejects alternate recipient or asset policies', () => {
    expect(executionScopeHash(POLYMARKET_PUSD_WRAP_SCOPE)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => executionScopeHash({ ...POLYMARKET_PUSD_WRAP_SCOPE, asset: '0x0000000000000000000000000000000000000001' })).toThrow();
    expect(() => executionScopeHash({ ...POLYMARKET_PUSD_WRAP_SCOPE, recipientPolicy: 'required-v1' } as never)).toThrow();
    expect(() => executionScopeHash({ ...POLYMARKET_PUSD_WRAP_SCOPE, extra: true } as never)).toThrow();
  });
});
