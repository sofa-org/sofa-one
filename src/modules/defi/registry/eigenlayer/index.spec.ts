import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildEigenLayerRegistry, EIGENLAYER_CAPABILITIES } from './index';

const strategyManager = '0x858646372CC42E1A627fcE94aa7A7033e7CF075A';
const delegationManager = '0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A';
const strategy = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const max = (1n << 256n) - 1n;
const fragment = buildEigenLayerRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'eigenlayer-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const args = (fn: DefiFunctionPolicy): any[] => {
  switch (fn.functionName) {
    case 'depositIntoStrategy': return [strategy, token, max];
    case 'queueWithdrawals': return [[{ strategies: [strategy, other], depositShares: [max, max], __deprecated_withdrawer: other }]];
    default: return [{ staker: other, delegatedTo: strategy, withdrawer: other, nonce: max, startBlock: 0xffffffff, strategies: [strategy], scaledShares: [max] }, [token, other], true];
  }
};
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args(fn) as never }), ...(value === undefined ? {} : { value }) });

describe('EigenLayer source-qualified fixture', () => {
  it('matches all three inactive source ABIs, hashes, stable IDs, and strict provenance', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/eigenlayer.json', 'utf8'));
    const family = source.families[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('eigenlayer');
    expect(family.familyVersion).toBe('v1-4-1@ef8f9799');
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(family.contracts.map((c: any) => [c.chainId, c.address, c.status])).toEqual([[1, strategyManager, 'inactive'], [1, delegationManager, 'inactive']]);
    expect(EIGENLAYER_CAPABILITIES).toHaveLength(3);
    expect(EIGENLAYER_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['depositIntoStrategy', `eigenlayer:v1-4-1:1:${strategyManager.toLowerCase()}:deposit-into-strategy`, 'depositIntoStrategy(address,address,uint256)', 'nonpayable'],
      ['queueWithdrawals', `eigenlayer:v1-4-1:1:${delegationManager.toLowerCase()}:queue-withdrawals`, 'queueWithdrawals((address[],uint256[],address)[])', 'nonpayable'],
      ['completeQueuedWithdrawal', `eigenlayer:v1-4-1:1:${delegationManager.toLowerCase()}:complete-queued-withdrawal`, 'completeQueuedWithdrawal((address,address,address,uint256,uint32,address[],uint256[]),address[],bool)', 'nonpayable'],
    ]);
    for (const fn of EIGENLAYER_CAPABILITIES) {
      const c = family.contracts.find((entry: any) => entry.address === fn.contract);
      const raw = c.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(c.sourceRefs).toContain(sourceId);
      expect(fn.abi.stateMutability).toBe('nonpayable');
    }
    expect(new Set(EIGENLAYER_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(3);
  });

  it('allows only exact explicit grants and caller-selected maximal financial/array arguments', async () => {
    for (const fn of EIGENLAYER_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates methods, exact targets and chain', async () => {
    for (const fn of EIGENLAYER_CAPABILITIES) {
      const wrong = EIGENLAYER_CAPABILITIES.find((candidate) => candidate.capabilityId !== fn.capabilityId)!;
      await expect(policy.authorizeContractCalls([call(fn)], context([wrong.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects malformed canonical encodings and trailing bytes for nested calldata', async () => {
    for (const fn of EIGENLAYER_CAPABILITIES) {
      const valid = call(fn);
      for (const data of [`${valid.data}00`, `0xdeadbeef${valid.data.slice(10)}`]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
    const queue = EIGENLAYER_CAPABILITIES.find((fn) => fn.functionName === 'queueWithdrawals')!;
    const encoded = call(queue);
    const dynamicArrayOffsetStart = 10 + 64;
    const badOffset = `${encoded.data.slice(0, dynamicArrayOffsetStart)}${'0'.repeat(62)}21${encoded.data.slice(dynamicArrayOffsetStart + 64)}`;
    await expect(policy.authorizeContractCalls([{ ...encoded, data: badOffset }], context([queue.capabilityId]))).rejects.toBeDefined();
  });
});
