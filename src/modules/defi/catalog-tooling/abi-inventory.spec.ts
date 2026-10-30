import { inventoryAbi } from './abi-inventory';
import { validateCatalogDocument } from './catalog-generator';

const address = '0x0000000000000000000000000000000000001234';
const input = (abi: unknown[]) => ({
  chainId: 1,
  address,
  protocol: 'Example Protocol',
  deploymentEvidence: { sourceRef: 'https://example.test/deployment', verifiedAt: '2026-10-01', chainId: 1, address },
  abiEvidence: { sourceRef: 'https://example.test/abi', verifiedAt: '2026-10-02', chainId: 1, address },
  abi,
});

describe('offline ABI inventory', () => {
  it('creates deterministic inactive schema-v1 drafts for canonical tuples, arrays and overloads', () => {
    const abi = [
      { type: 'event', name: 'Ignored' },
      { type: 'constructor', inputs: [] },
      { type: 'fallback' },
      { type: 'receive' },
      { type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ name: 'items', type: 'tuple[]', components: [{ name: 'account', type: 'address' }, { name: 'amount', type: 'uint256' }] }], outputs: [{ name: 'result', type: 'uint256' }] },
      { type: 'function', name: 'set', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] },
      { type: 'function', name: 'set', stateMutability: 'payable', inputs: [{ name: 'value', type: 'address' }], outputs: [] },
    ];
    const first = inventoryAbi(input(abi));
    expect(() => validateCatalogDocument(first)).not.toThrow();
    expect(inventoryAbi(input(abi))).toEqual(first);
    const funcs = (first.chains[0] as any).contracts[0].functions;
    expect(funcs.map((fn: any) => fn.signature)).toEqual(['quote((address,uint256)[])', 'set(uint256)', 'set(address)']);
    expect(funcs.map((fn: any) => fn.status)).toEqual(['inactive', 'inactive', 'inactive']);
    expect(funcs[0].abi.stateMutability).toBe('view');
    expect(funcs[2].abi.stateMutability).toBe('payable');
    expect(funcs.every((fn: any) => fn.inactiveReason && fn.provenance.status === 'candidate')).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/grant|automatic/i);
  });

  it.each([
    { ...input([]), chainId: 0 },
    { ...input([]), protocol: ' ' },
    { ...input([]), deploymentEvidence: { ...input([]).deploymentEvidence, address: '0x0000000000000000000000000000000000009999' } },
    { ...input([]), abiEvidence: { ...input([]).abiEvidence, chainId: 2 } },
    input([{ type: 'function', name: 'f', stateMutability: 'view', inputs: [], outputs: [] }, { type: 'function', name: 'f', stateMutability: 'view', inputs: [], outputs: [] }]),
    input([{ type: 'function', name: 'burn', stateMutability: 'view', inputs: [{ name: 'x', type: 'uint256' }], outputs: [] }, { type: 'function', name: 'collate_propagate_storage', stateMutability: 'view', inputs: [{ name: 'x', type: 'bytes16' }], outputs: [] }]),
    input([{ type: 'function', name: 'f', stateMutability: 'invalid', inputs: [], outputs: [] }]),
  ])('rejects invalid input/evidence or duplicate/colliding/malformed functions', (value) => {
    expect(() => inventoryAbi(value)).toThrow();
  });
});
