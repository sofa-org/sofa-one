import { readFileSync } from 'node:fs';
import { toFunctionSelector } from 'viem';
import { functionAbiHash, buildReviewedManifest } from '../defi-manifest';
import { GENERATED_DEFI_REGISTRY } from '../generated/production-catalog';
import { ENSO_CAPABILITIES } from './index';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from '../../execution/enso-identity';
import { executionScopeHash } from '../../execution/scope';

const abiFile = 'data/defi-catalog/v8/sources/enso.json';

describe('Enso static Weiroll candidate fixture', () => {
  it('matches the exact source-selected payable root ABI, selector, identity, and mandatory scope', () => {
    const source = JSON.parse(readFileSync(abiFile, 'utf8'));
    const contract = source.families[0].contracts[0];
    const fn = ENSO_CAPABILITIES[0];
    const sourceEntry = contract.abiFunctions.find((candidate: any) => candidate.name === 'routeSingle');
    const { sourceId, ...sourceAbi } = sourceEntry;

    expect(source.families[0]).toMatchObject({ familyId: 'enso', familyVersion: 'router-static-weiroll-v1@c032c8f9' });
    expect(contract).toMatchObject({ chainId: 1, address: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract, status: 'inactive' });
    expect(contract.abiFunctions).toHaveLength(1);
    expect(sourceId).toBe('enso-router-full-verified-abi');
    expect(sourceAbi).toEqual(fn.abi);
    expect(fn).toMatchObject({
      capabilityId: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId,
      chainId: 1,
      contract: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract,
      functionName: 'routeSingle',
      signature: 'routeSingle((uint8,bytes),bytes)',
      status: 'active',
      abiHash: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.abiHash,
      executionScope: { kind: 'enso-static-weiroll-v1', allowedChildren: ENSO_STATIC_WEIROLL_CHILD_IDENTITIES },
    });
    expect(fn.abi.stateMutability).toBe('payable');
    expect(fn.abi.inputs[0]).toMatchObject({ name: 'tokenIn', internalType: 'struct Token', type: 'tuple' });
    expect((fn.abi.inputs[0] as any).components).toEqual([
      { internalType: 'enum TokenType', name: 'tokenType', type: 'uint8' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
    ]);
    expect(fn.abi.inputs[1]).toEqual({ internalType: 'bytes', name: 'data', type: 'bytes' });
    expect(fn.abi.outputs).toEqual([{ internalType: 'bytes', name: 'response', type: 'bytes' }]);
    expect(toFunctionSelector(fn.signature)).toBe('0xb94c3609');
    expect(functionAbiHash(fn)).toBe('0xe3045106c2f667460faa9d5d67104b5f7f70c24186421cf1dbc7a2f03624c5c9');
    expect(executionScopeHash(fn.executionScope!)).toBe('0xf55170b87634460f24a5f4ced30d21b134bf950327078b5f31e0bfe2074959e5');
    expect(source.sources.find((entry: any) => entry.sourceId === 'enso-router-full-verified-abi')).toMatchObject({
      sha256: '5fd35015a8160702cd4770640e26f7a508cdda4d7143dccea86cff5d58d52e50',
      url: 'https://etherscan.io/address/0xf75584ef6673ad213a685a1b58cc0330b8ea22cf#code',
    });
    expect(source.sources.find((entry: any) => entry.sourceId === 'enso-router-verified-source')?.sha256)
      .toBe('c032c8f9fa1af179fbac8f6a6a052bd711e8d4bd879bb37d6681e6704c9dc7ef');
  });

  it('resolves the root and every allowed child against the current generated production manifest', () => {
    const manifest = buildReviewedManifest([GENERATED_DEFI_REGISTRY]);
    const root = manifest.capabilities.find((candidate) => candidate.capabilityId === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId)!;

    expect(root.executionScope).toEqual({ kind: 'enso-static-weiroll-v1', allowedChildren: ENSO_STATIC_WEIROLL_CHILD_IDENTITIES });
    expect(root.status).toBe('active');
    expect(root.executionScope && executionScopeHash(root.executionScope)).toBe('0xf55170b87634460f24a5f4ced30d21b134bf950327078b5f31e0bfe2074959e5');
    expect(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES).toHaveLength(3);
    for (const child of ENSO_STATIC_WEIROLL_CHILD_IDENTITIES) {
      const resolved = manifest.capabilities.find((candidate) => candidate.capabilityId === child.capabilityId);
      expect(resolved).toBeDefined();
      expect(resolved).toMatchObject({ type: 'contract_call', status: 'active', chainId: child.chainId, signature: child.signature });
      expect(resolved!.contract.toLowerCase()).toBe(child.contract.toLowerCase());
      expect(functionAbiHash(resolved!)).toBe(child.abiHash);
      expect(resolved!.executionScope).toBeUndefined();
    }
  });
});
