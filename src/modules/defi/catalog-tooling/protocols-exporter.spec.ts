import { toFunctionSelector } from 'viem';
import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import { renderProtocolsJson } from './protocols-exporter';
import { GENERATED_DEFI_REGISTRY } from '../registry/generated/production-catalog';

const address = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const abi: AbiFunction = {
  type: 'function', name: 'deposit', stateMutability: 'payable',
  inputs: [{ name: 'requests', type: 'tuple[]', internalType: 'struct Request[]', components: [
    { name: 'owner', type: 'address', internalType: 'address' },
    { name: 'details', type: 'tuple', internalType: 'struct Details', components: [
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ] },
  ] }],
  outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }],
};

function fn(overrides: Partial<DefiFunctionPolicy> = {}): DefiFunctionPolicy {
  return {
    capabilityId: 'example:1:deposit', type: 'contract_call', chainId: 1, contract: address,
    functionName: 'deposit', signature: 'deposit((address,(uint256))[])', abi,
    status: 'active', provenance: { status: 'verified', sourceRef: 'reviewed-source', verifiedAt: '2026-10-19' },
    protocol: 'example', ...overrides,
  };
}

function chain(functions: readonly DefiFunctionPolicy[]): DefiChainPolicy {
  return { chainId: 1, status: 'active', contracts: [{ address, status: 'active', functions }] };
}

describe('public protocols.json export', () => {
  it.each([
    ['Aave V3', 'aave-v3'],
    ['Morpho Blue', 'morpho-blue'],
    ['Compound III', 'compound-iii'],
  ])('exports %s as one protocol per address with its complete admitted ABI', (protocol, prefix) => {
    const result = JSON.parse(renderProtocolsJson(GENERATED_DEFI_REGISTRY));
    for (const chain of GENERATED_DEFI_REGISTRY.chains) {
      for (const contract of chain.contracts) {
        const functions = contract.functions.filter((fn) => fn.capabilityId.startsWith(`${prefix}:`)
          || (prefix === 'compound-iii' && fn.capabilityId.startsWith('compound-comet:')));
        if (functions.length === 0) continue;
        const entries = result[String(chain.chainId)].contracts.filter(
          (entry: { address: string }) => entry.address === contract.address.toLowerCase(),
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].protocol).toBe(protocol);
        expect(entries[0].abi.map((abi: AbiFunction) => toFunctionSelector(abi)).sort())
          .toEqual(functions.map((fn) => toFunctionSelector(fn.signature)).sort());
      }
    }
  });

  it('exports only standard function ABI, preserving nested tuples, outputs and mutability without mutating input', () => {
    const fragment = { chains: [chain([fn()])] };
    const original = JSON.stringify(fragment);
    const result = JSON.parse(renderProtocolsJson(fragment));
    expect(Object.keys(result)).toEqual(['1', '137']);
    expect(Object.keys(result['1'])).toEqual(['contracts', 'sign']);
    expect(result['1'].sign).toEqual([]);
    expect(Object.keys(result['1'].contracts[0])).toEqual(['address', 'protocol', 'abi']);
    expect(result['1'].contracts[0].address).toBe(address.toLowerCase());
    expect(result['1'].contracts[0].protocol).toBe('example');
    expect(result['1'].contracts[0].abi).toEqual([{
      type: 'function', name: 'deposit', stateMutability: 'payable',
      inputs: [{ name: 'requests', type: 'tuple[]', components: [
        { name: 'owner', type: 'address' },
        { name: 'details', type: 'tuple', components: [{ name: 'amount', type: 'uint256' }] },
      ] }],
      outputs: [{ name: 'shares', type: 'uint256' }],
    }]);
    expect(JSON.stringify(fragment)).toBe(original);
  });

  it('omits inactive hierarchy, inactive functions, unverified provenance and typed-data records', () => {
    const active = chain([fn(), fn({ status: 'inactive' }), fn({ type: 'typed_data_sign' }),
      fn({ provenance: { status: 'candidate', sourceRef: 'candidate', verifiedAt: '2026-10-19' } })]);
    const inactiveChain = { ...chain([fn()]), chainId: 2, status: 'inactive' as const };
    const inactiveContract = { ...chain([fn()]), chainId: 3, contracts: [{ ...chain([fn()]).contracts[0], status: 'inactive' as const }] };
    const result = JSON.parse(renderProtocolsJson({ chains: [inactiveChain, inactiveContract, active] }));
    expect(Object.keys(result)).toEqual(['1', '137']);
    expect(result['1'].contracts[0].abi).toHaveLength(1);
    expect(JSON.parse(renderProtocolsJson({ chains: [chain([])] }))['1']).toBeUndefined();
  });

  it('sorts chains, addresses, protocol labels and signatures independently of input order', () => {
    const first = fn({ protocol: 'alpha', signature: 'a()', abi: { ...abi, name: 'a' } });
    const last = fn({ protocol: 'alpha', signature: 'z()', abi: { ...abi, name: 'z' } });
    const otherProtocol = fn({ protocol: 'zeta' });
    const lowerAddress = '0x1111111111111111111111111111111111111111';
    const contracts = [
      { address, status: 'active' as const, functions: [last, otherProtocol, first] },
      { address: lowerAddress, status: 'active' as const, functions: [fn()] },
    ];
    const chains: DefiChainPolicy[] = [
      { chainId: 10, status: 'active', contracts },
      { chainId: 1, status: 'active', contracts },
    ];
    const forward = renderProtocolsJson({ chains });
    const reversed = renderProtocolsJson({ chains: [...chains].reverse().map((item) => ({
      ...item, contracts: [...item.contracts].reverse().map((contract) => ({ ...contract, functions: [...contract.functions].reverse() })),
    })) });
    expect(reversed).toBe(forward);
    const result = JSON.parse(forward);
    expect(Object.keys(result)).toEqual(['1', '10', '137']);
    expect(result['1'].contracts.map((item: { protocol: string }) => item.protocol)).toEqual(['example', 'alpha', 'zeta']);
    expect(result['1'].contracts[1].abi.map((item: AbiFunction) => item.name)).toEqual(['a', 'z']);
  });

  it('does not invent view functions but preserves an already admitted active view', () => {
    const view = fn({ abi: { ...abi, stateMutability: 'view' } });
    expect(JSON.parse(renderProtocolsJson({ chains: [chain([view])] }))['1'].contracts[0].abi[0].stateMutability).toBe('view');
  });

  it('fails rather than inventing missing protocol labels', () => {
    expect(() => renderProtocolsJson({ chains: [chain([fn({ protocol: undefined })])] })).toThrow('requires a protocol label');
  });

  it('exposes signing-only Polygon without mixing signing envelopes into contract ABIs', () => {
    const result = JSON.parse(renderProtocolsJson({ chains: [] }));
    expect(Object.keys(result)).toEqual(['137']);
    expect(result['137'].contracts).toEqual([]);
    expect(result['137'].sign).toEqual([
      { protocol: 'polymarket', capabilityId: 'polymarket:137:clob-auth:v1', type: 'typed_data', primaryType: 'ClobAuth' },
      { protocol: 'polymarket', capabilityId: 'polymarket:137:clob-order:v2', type: 'typed_data', primaryType: 'TypedDataSign' },
      { protocol: 'polymarket', capabilityId: 'polymarket:137:deposit-wallet-batch-sign:v1', type: 'typed_data', primaryType: 'Batch' },
    ]);
  });

});
