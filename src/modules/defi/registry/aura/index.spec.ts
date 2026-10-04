import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildAuraRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Aura source fixture', () => {
  const fragment = buildAuraRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (operation: string) => functions.find((fn) => fn.operation === operation)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/aura.json', 'utf8')) as { families: Array<{ familyId: string; familyVersion: string; contracts: Array<{ chainId: number; address: string; status: string; sourceRefs: string[]; abiFunctions: DefiFunctionPolicy['abi'][] }> }>; sources: Array<Record<string, string>> };
  const args: Record<string, readonly unknown[]> = {
    deposit: [0n, 1n, true], 'deposit-all': [0n, true], withdraw: [0n, 1n], 'withdraw-all': [0n],
    'withdraw-and-unwrap': [1n, true], 'get-reward': [],
  };
  const call = (fn: DefiFunctionPolicy, values = args[fn.operation!]!, value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), value });

  it('binds exactly six declared source ABIs to the two chain-1 targets and stable template IDs', () => {
    expect(source.families).toHaveLength(1);
    const family = source.families[0]!;
    expect(family).toMatchObject({ familyId: 'aura', familyVersion: 'phase6@36599d53' });
    expect(family.contracts.map(({ address }) => address.toLowerCase()).sort()).toEqual([
      '0x712cc5bed99aa06fc4d5fb50aea3750fa5161d0f', '0xa57b8d98dae62b26ec3bcc4a365338157060b234',
    ]);
    const sourceFns = family.contracts.flatMap((contract) => contract.abiFunctions.map((abi) => ({ chainId: contract.chainId, address: contract.address, abi })));
    expect(sourceFns).toHaveLength(6);
    expect(functions).toHaveLength(6);
    expect(fragment.chains.map(({ chainId }) => chainId)).toEqual([1]);
    expect(new Set(functions.map((fn) => fn.capabilityId)).size).toBe(6);
    expect(new Set(functions.map(({ contract, signature }) => `${contract.toLowerCase()}:${toFunctionSelector(signature)}`)).size).toBe(6);
    const sourceIds = new Set(source.sources.map(({ sourceId }) => sourceId));
    expect(sourceIds.size).toBe(source.sources.length);
    expect(source.sources.every((row) => Object.keys(row).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    for (const contract of family.contracts) {
      expect(contract.status).toBe('inactive');
      expect(contract.sourceRefs.every((ref) => sourceIds.has(ref))).toBe(true);
    }
    for (const fn of functions) {
      expect(fn.capabilityId).toBe(`aura:v1:1:${fn.contract.toLowerCase()}:${fn.operation}`);
      expect(fn.abi.stateMutability).toBe('nonpayable');
      expect(fn.abi.outputs).toEqual([{ name: '', type: 'bool', internalType: 'bool' }]);
      const matches = sourceFns.filter((row) => row.chainId === fn.chainId && row.address.toLowerCase() === fn.contract.toLowerCase() && row.abi.name === fn.functionName && `${fn.functionName}(${row.abi.inputs.map(({ type }) => type).join(',')})` === fn.signature && functionAbiHash({ abi: row.abi as never }) === functionAbiHash(fn));
      expect(matches).toHaveLength(1);
      expect(fn.provenance.sourceRef).toContain('36599d53946aab701e2a1757e164261f49529399');
      expect(fn.provenance.sourceRef).toContain('e7c23cfeec5ef9beb4873d87069363ee458fc184');
    }
    expect(functions.map(({ signature }) => signature)).toEqual([
      'deposit(uint256,uint256,bool)', 'depositAll(uint256,bool)', 'withdraw(uint256,uint256)',
      'withdrawAll(uint256)', 'withdrawAndUnwrap(uint256,bool)', 'getReward()',
    ]);
  });

  it.each(['deposit', 'deposit-all', 'withdraw', 'withdraw-all', 'withdraw-and-unwrap', 'get-reward'])('%s authorizes only its exact grant, chain, target and canonical selector', async (operation) => {
    const fn = find(operation);
    const calldata = call(fn);
    await expect(policy.authorizeContractCalls([calldata], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([calldata], context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const other = find(operation === 'get-reward' ? 'deposit' : 'get-reward');
    await expect(policy.authorizeContractCalls([calldata], context(1, [other.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, to: B }], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([calldata], context(10, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `0xffffffff${calldata.data!.slice(10)}` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `${calldata.data}00` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(fn, args[operation], '1')], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rejects noncanonical bool words and leaves ABI-valid uint256 and bool values uncapped', async () => {
    for (const operation of ['deposit', 'deposit-all', 'withdraw-and-unwrap']) {
      const fn = find(operation);
      const calldata = call(fn);
      const boolWord = `${calldata.data!.slice(0, -64)}${'0'.repeat(63)}2`;
      await expect(policy.authorizeContractCalls([{ ...calldata, data: boolWord }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    }
    const max = (1n << 256n) - 1n;
    await expect(policy.authorizeContractCalls([call(find('deposit'), [max, max, false])], context(1, [find('deposit').capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(find('deposit-all'), [max, false])], context(1, [find('deposit-all').capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(find('withdraw'), [max, max])], context(1, [find('withdraw').capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(find('withdraw-all'), [max])], context(1, [find('withdraw-all').capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(find('withdraw-and-unwrap'), [max, false])], context(1, [find('withdraw-and-unwrap').capabilityId]))).resolves.toBeDefined();
  });

  it('labels the shutdown historical reward pool as exit/claim evidence, not deposit readiness', () => {
    const rewardPoolFunctions = functions.filter((fn) => fn.contract.toLowerCase() === '0x712cc5bed99aa06fc4d5fb50aea3750fa5161d0f');
    expect(rewardPoolFunctions).toHaveLength(2);
    for (const fn of rewardPoolFunctions) {
      expect(fn.warnings?.join(' ')).toContain('shutdown flag was true');
      expect(fn.warnings?.join(' ')).toContain('not new-stake readiness');
      expect(fn.warnings?.join(' ')).toContain('No currently open Aura deposit pool was verified');
    }
  });
});
