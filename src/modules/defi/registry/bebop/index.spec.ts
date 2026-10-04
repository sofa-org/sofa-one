import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildBebopRegistry, BEBOP_CAPABILITIES } from './index';

const router = '0xb098881c587f623fac85eae60809bee7a174cee7';
const other = '0x1111111111111111111111111111111111111111';
const fragment = buildBebopRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const fn = BEBOP_CAPABILITIES[0];
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'bebop-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const args = [other, router, 0n, (1n << 256n) - 1n, other, 0n, (1n << 256n) - 1n] as const;
const call = (data: `0x${string}` = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args }), value = 0n) => ({ to: router, data, value });

describe('Bebop BOP AMM isolated fixture', () => {
  it('pins inactive source candidate and exact selected full-ABI function', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v7/sources/bebop.json', 'utf8'));
    const contract = source.families[0].contracts[0];
    expect(source.families[0].familyId).toBe('bebop');
    expect(contract).toMatchObject({ chainId: 1, address: '0xB098881c587f623FAC85eAe60809bEE7A174CeE7', status: 'inactive' });
    expect(contract.abiFunctions).toHaveLength(1);
    const { sourceId, ...abi } = contract.abiFunctions[0];
    expect(sourceId).toBe('bebop-official-full-abi');
    expect(abi).toEqual(fn.abi);
    expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
    expect(fn.signature).toBe('swapWithAllowance(address,address,uint256,uint256,address,uint256,uint256)');
    expect(toFunctionSelector(fn.signature)).toBe('0xa2e6fd72');
    expect(source.sources.map((s: any) => s.sourceId)).toEqual(['bebop-official-full-abi', 'bebop-etherscan-source', 'bebop-official-role-docs']);
  });

  it('requires the exact grant and binds chain, router, and selector', async () => {
    await expect(policy.authorizeContractCalls([call()], context([fn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call()], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call()], context(['unrelated-grant']))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call()], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([call(`0xdeadbeef${call().data.slice(10)}`)], context([fn.capabilityId]))).rejects.toBeDefined();
  });

  it('requires canonical calldata, recognizes payable value, and preserves unrestricted financial inputs', async () => {
    const valid = call();
    for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)] as `0x${string}`[]) {
      await expect(policy.authorizeContractCalls([call(data)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
    await expect(policy.authorizeContractCalls([call(valid.data, 7n)], context([fn.capabilityId]))).resolves.toBeDefined();
    const zeroArgs = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [other, other, 0n, 0n, other, 0n, 0n] });
    await expect(policy.authorizeContractCalls([call(zeroArgs)], context([fn.capabilityId]))).resolves.toBeDefined();
    expect(fn.abi.stateMutability).toBe('payable');
  });
});
