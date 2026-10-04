import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildStakeWiseRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('StakeWise source fixture', () => {
  const fragment = buildStakeWiseRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (operation: string) => functions.find((fn) => fn.operation === operation)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/stakewise.json', 'utf8')) as { families: Array<{ familyId: string; familyVersion: string; contracts: Array<{ chainId: number; address: string; status: string; sourceRefs: string[]; abiFunctions: DefiFunctionPolicy['abi'][] }> }>; sources: Array<{ sourceId: string; url: string }> };
  const args: Record<string, readonly unknown[]> = {
    deposit: [A, B], 'enter-exit-queue': [1n, A], 'claim-exited-assets': [1n, 2n, 3n],
  };
  const call = (fn: DefiFunctionPolicy, values = args[fn.operation!]!, value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), value });

  it('binds exactly three full source ABIs to the canonical Ethereum Genesis Vault with unique identities', () => {
    expect(source.families).toHaveLength(1);
    const family = source.families[0]!;
    expect(family).toMatchObject({ familyId: 'stakewise', familyVersion: 'v3-genesis' });
    expect(family.contracts).toHaveLength(1);
    const target = family.contracts[0]!;
    expect(target).toMatchObject({ chainId: 1, address: '0xAC0F906E433d58FA868F936E8A43230473652885', status: 'inactive' });
    expect(target.abiFunctions).toHaveLength(3);
    expect(functions).toHaveLength(3);
    expect(new Set(functions.map((fn) => fn.capabilityId)).size).toBe(3);
    expect(new Set(functions.map(({ contract, signature }) => `${contract.toLowerCase()}:${toFunctionSelector(signature)}`)).size).toBe(3);
    const sourceIds = new Set(source.sources.map(({ sourceId }) => sourceId));
    for (const ref of target.sourceRefs) expect(sourceIds.has(ref)).toBe(true);
    for (const fn of functions) {
      expect(fn.capabilityId).toBe(`stakewise:v3-genesis:1:${target.address.toLowerCase()}:${fn.operation}`);
      const matches = target.abiFunctions.filter((abi) => abi.name === fn.functionName && functionAbiHash({ abi: abi as never }) === functionAbiHash(fn));
      expect(matches).toHaveLength(1);
      expect(fn.provenance.sourceRef).toContain('fc70cbe1b3d41bc5f78434830d837aa270ca33bc');
    }
  });

  it.each(['deposit', 'enter-exit-queue', 'claim-exited-assets'])('%s authorizes only its exact grant, chain, target, selector and canonical calldata', async (operation) => {
    const fn = find(operation);
    const calldata = call(fn);
    await expect(policy.authorizeContractCalls([calldata], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([calldata], context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const other = find(operation === 'deposit' ? 'enter-exit-queue' : 'deposit');
    await expect(policy.authorizeContractCalls([calldata], context(1, [other.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, to: B }], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([calldata], context(5, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `${calldata.data}00` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    if (operation === 'deposit') await expect(policy.authorizeContractCalls([call(fn, args[operation], '17')], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    else await expect(policy.authorizeContractCalls([call(fn, args[operation], '1')], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('accepts ABI-valid arbitrary financial/receiver choices and maximum uints while enforcing structural payability', async () => {
    const max = (1n << 256n) - 1n;
    const deposit = find('deposit');
    await expect(policy.authorizeContractCalls([call(deposit, [B, A], '17')], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit, [B, A])], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
    const queue = find('enter-exit-queue');
    await expect(policy.authorizeContractCalls([call(queue, [max, B])], context(1, [queue.capabilityId]))).resolves.toBeDefined();
    const claim = find('claim-exited-assets');
    await expect(policy.authorizeContractCalls([call(claim, [max, max, max])], context(1, [claim.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(queue, args['enter-exit-queue'], '1')], context(1, [queue.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const depositCalldata = call(deposit, [B, A], '17');
    await expect(policy.authorizeContractCalls([depositCalldata], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
  });
});
