import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildOneInchRegistry, ONE_INCH_CAPABILITIES } from './index';

const target = '0x111111125421ca6dc452d289314280a0f8842a65';
const other = '0x2222222222222222222222222222222222222222';
const max = (1n << 256n) - 1n;
const fragment = buildOneInchRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'one-inch-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const call = (fn: DefiFunctionPolicy, value = 0n, extremes = true) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: fn.abi.inputs.map(() => extremes ? max : 0n) as never }),
  value,
});

describe('1inch Ethereum AggregationRouterV6 isolated fixture', () => {
  it('matches the inactive source candidate, full ABI objects, exact selectors, and twelve selected methods', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v7/sources/one-inch.json', 'utf8'));
    const contract = source.families[0].contracts[0];
    expect(source.families[0].familyId).toBe('one-inch');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive' });
    expect(contract.abiFunctions).toHaveLength(12);
    expect(contract.abiFunctions.map((entry: any) => entry.name).sort()).toEqual(['unoswap','unoswap2','unoswap3','unoswapTo','unoswapTo2','unoswapTo3','ethUnoswap','ethUnoswap2','ethUnoswap3','ethUnoswapTo','ethUnoswapTo2','ethUnoswapTo3'].sort());
    for (const fn of ONE_INCH_CAPABILITIES) {
      const { sourceId, ...abi } = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      expect(abi).toEqual(fn.abi);
      expect(sourceId).toBe('one-inch-official-sdk-abi');
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.abi.outputs).toEqual([{ internalType: 'uint256', name: 'returnAmount', type: 'uint256' }]);
      expect(fn.abi.inputs.filter((input) => ['token','to','dex','dex2','dex3'].includes(input.name ?? '')).every((input) => input.type === 'uint256' && input.internalType === 'Address')).toBe(true);
    }
    expect(ONE_INCH_CAPABILITIES.map((fn) => [fn.functionName, toFunctionSelector(fn.signature)])).toEqual([
      ['ethUnoswap','0xa76dfc3b'], ['ethUnoswap2','0x89af926a'], ['ethUnoswap3','0x188ac35d'], ['ethUnoswapTo','0x175accdc'], ['ethUnoswapTo2','0x0f449d71'], ['ethUnoswapTo3','0x493189f0'],
      ['unoswap','0x83800a8e'], ['unoswap2','0x8770ba91'], ['unoswap3','0x19367472'], ['unoswapTo','0xe2c95c82'], ['unoswapTo2','0xea76dddf'], ['unoswapTo3','0xf7a70056'],
    ]);
  });

  it('applies exact grants and canonical chain, target, selector, calldata, and value policy to every method', async () => {
    for (const fn of ONE_INCH_CAPABILITIES) {
      const valid = call(fn);
      const unrelatedGrant = ONE_INCH_CAPABILITIES.find((candidate) => candidate.capabilityId !== fn.capabilityId)!.capabilityId;
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([valid], context([unrelatedGrant]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...valid, to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([call(fn, 0n, false)], context([fn.capabilityId]))).resolves.toBeDefined();
      const nonzeroValue = call(fn, 1n);
      if (fn.abi.stateMutability === 'payable') {
        await expect(policy.authorizeContractCalls([nonzeroValue], context([fn.capabilityId]))).resolves.toBeDefined();
      } else {
        await expect(policy.authorizeContractCalls([nonzeroValue], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});
