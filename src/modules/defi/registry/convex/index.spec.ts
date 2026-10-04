import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildConvexRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Convex source fixture', () => {
  const fragment = buildConvexRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (operation: string) => functions.find((fn) => fn.operation === operation)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/convex.json', 'utf8')) as { families: Array<{ familyId: string; familyVersion: string; contracts: Array<{ chainId: number; address: string; status: string; sourceRefs: string[]; abiFunctions: DefiFunctionPolicy['abi'][] }> }>; sources: Array<{ sourceId: string; url: string }> };
  const args: Record<string, readonly unknown[]> = {
    deposit: [0n, 1n, true], 'deposit-all': [0n, true], withdraw: [0n, 1n], 'withdraw-all': [0n],
    'withdraw-and-unwrap': [1n, true], 'get-reward': [],
  };
  const call = (fn: DefiFunctionPolicy, values = args[fn.operation!]!, value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), value });

  it('matches all six full source ABIs at the exact two targets and has unique stable IDs', () => {
    expect(source.families).toHaveLength(1);
    const family = source.families[0]!;
    expect(family).toMatchObject({ familyId: 'convex', familyVersion: 'platform@4f220383' });
    expect(family.contracts.map(({ address }) => address.toLowerCase()).sort()).toEqual([
      '0xf34dff761145ff0b05e917811d488b441f33a968', '0xf403c135812408bfbe8713b5a23a04b3d48aae31',
    ]);
    const sourceFunctions = family.contracts.flatMap((contract) => contract.abiFunctions.map((abi) => ({ chainId: contract.chainId, address: contract.address, abi })));
    expect(sourceFunctions).toHaveLength(6);
    expect(functions).toHaveLength(6);
    expect(fragment.chains.map(({ chainId }) => chainId)).toEqual([1]);
    expect(new Set(functions.map((fn) => fn.capabilityId)).size).toBe(6);
    expect(new Set(functions.map(({ contract, signature }) => `${contract.toLowerCase()}:${toFunctionSelector(signature)}`)).size).toBe(6);
    const sourceIds = new Set(source.sources.map(({ sourceId }) => sourceId));
    for (const contract of family.contracts) for (const ref of contract.sourceRefs) expect(sourceIds.has(ref)).toBe(true);
    for (const fn of functions) {
      expect(fn.capabilityId).toBe(`convex:v1:1:${fn.contract.toLowerCase()}:${fn.operation}`);
      expect(fn.abi.outputs).toEqual([{ name: '', type: 'bool' }]);
      const matches = sourceFunctions.filter((row) => row.chainId === fn.chainId && row.address.toLowerCase() === fn.contract.toLowerCase() && row.abi.name === fn.functionName && `${fn.functionName}(${row.abi.inputs.map(({ type }) => type).join(',')})` === fn.signature && functionAbiHash({ abi: row.abi as never }) === functionAbiHash(fn));
      expect(matches).toHaveLength(1);
      expect(fn.provenance.sourceRef).toContain('4f22038387ca4ce014dec3d7f5781a8e28051c13');
    }
  });

  it.each(['deposit', 'deposit-all', 'withdraw', 'withdraw-all', 'withdraw-and-unwrap', 'get-reward'])('%s requires its exact grant, target, chain, selector and canonical ABI', async (operation) => {
    const fn = find(operation);
    const calldata = call(fn);
    await expect(policy.authorizeContractCalls([calldata], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([calldata], context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const other = find(operation === 'get-reward' ? 'deposit' : 'get-reward');
    await expect(policy.authorizeContractCalls([calldata], context(1, [other.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, to: B }], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([calldata], context(5, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `0xffffffff${calldata.data!.slice(10)}` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `${calldata.data}00` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(fn, args[operation], '1')], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rejects foreign overloads and noncanonical bools without blocking ABI-valid caller values', async () => {
    const getReward = find('get-reward');
    const rewardPool = '0xf34DFF761145FF0B05e917811d488B441F33a968';
    const foreignOverload = { to: rewardPool, data: `${toFunctionSelector('getReward(address,bool)')}${'0'.repeat(64)}${'0'.repeat(63)}1` };
    await expect(policy.authorizeContractCalls([foreignOverload], context(1, [getReward.capabilityId]))).rejects.toBeDefined();
    const deposit = find('deposit');
    const depositCall = call(deposit, [0n, 0n, true]);
    const invalidBool = `${depositCall.data!.slice(0, -64)}${'0'.repeat(63)}2`;
    await expect(policy.authorizeContractCalls([{ ...depositCall, data: invalidBool }], context(1, [deposit.capabilityId]))).rejects.toBeDefined();
    const max = (1n << 256n) - 1n;
    await expect(policy.authorizeContractCalls([call(deposit, [max, max, false])], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
    const withdraw = find('withdraw');
    await expect(policy.authorizeContractCalls([call(withdraw, [max, max])], context(1, [withdraw.capabilityId]))).resolves.toBeDefined();
  });
});
