import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildOpenOceanRegistry, OPEN_OCEAN_CAPABILITIES } from './index';

const proxy = '0x6352a56caadc4f1e25cd6c75970fa768a3304e64';
const other = '0x1111111111111111111111111111111111111111';
const fragment = buildOpenOceanRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'open-ocean-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argumentsFor = (fn: DefiFunctionPolicy, extreme = true, recipient = other): readonly unknown[] => fn.abi.inputs.map((input: any) => {
  if (input.type === 'address') return recipient;
  if (input.type === 'bytes32[]') return extreme ? [`0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`] : [];
  if (input.type === 'uint256[]') return extreme ? [(1n << 256n) - 1n, 0n] : [];
  if (input.type.startsWith('uint')) return extreme ? (1n << 256n) - 1n : 0n;
  throw new Error(`Unexpected ABI type ${input.type}`);
});
const call = (fn: DefiFunctionPolicy, data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argumentsFor(fn) as never }), value = 0n) => ({ to: proxy, data, value });

const selectors = ['0x8980041a', '0x6b58f2f0', '0xbc80f1a8'];
const hashes = [
  '0xc7ec253d9ee59a49d06c1942f2995ffccd21cd50b125fdf83971ad46ad3b47e6',
  '0x7de60cbecd83a62e79134c59d2406f26e9c811cbc919cc9052b7f0a42b36b898',
  '0x5172af3b624cb6351564e15c7c097ab72071588a5b94a553b0f9a1420a610c0e',
];

describe('OpenOcean bounded Uniswap proxy isolated fixture', () => {
  it('pins inactive proxy candidate, exact full ABI objects, selectors, and ABI identities', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v7/sources/open-ocean.json', 'utf8'));
    const contract = source.families[0].contracts[0];
    expect(source.families[0].familyId).toBe('open-ocean');
    expect(contract).toMatchObject({ chainId: 1, address: proxy, status: 'inactive' });
    expect(contract.abiFunctions).toHaveLength(3);
    expect(source.sources.map((entry: any) => entry.sourceId)).toEqual(['open-ocean-implementation-abi', 'open-ocean-implementation-source', 'open-ocean-official-docs', 'open-ocean-proxy-association']);
    expect(new Set(OPEN_OCEAN_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(3);
    for (const [index, fn] of OPEN_OCEAN_CAPABILITIES.entries()) {
      const { sourceId, ...abi } = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      expect(sourceId).toBe('open-ocean-implementation-abi');
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(functionAbiHash(fn)).toBe(hashes[index]);
      expect(toFunctionSelector(fn.signature)).toBe(selectors[index]);
    }
  });

  it('requires exact grants and isolates target, chain, and each selector', async () => {
    for (const fn of OPEN_OCEAN_CAPABILITIES) {
      const valid = call(fn);
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([valid], context(['unrelated-grant']))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...valid, to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([valid], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)] as `0x${string}`[]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([call(fn, undefined, 1n)], context([fn.capabilityId]))).resolves.toBeDefined();
      expect(fn.abi.stateMutability).toBe('payable');
    }
  });

  it('accepts ABI-width zero/max financial values, empty and multi-element route arrays, and caller-selected recipients', async () => {
    for (const fn of OPEN_OCEAN_CAPABILITIES) {
      const zero = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argumentsFor(fn, false, '0x0000000000000000000000000000000000000000') as never });
      await expect(policy.authorizeContractCalls([call(fn, zero)], context([fn.capabilityId]))).resolves.toBeDefined();
      const freelyRouted = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argumentsFor(fn, true, other) as never });
      await expect(policy.authorizeContractCalls([call(fn, freelyRouted)], context([fn.capabilityId]))).resolves.toBeDefined();
    }
    const v2 = OPEN_OCEAN_CAPABILITIES.find((fn) => fn.functionName === 'callUniswap')!;
    expect(v2.abi.inputs.find((input) => input.name === 'pools')?.type).toBe('bytes32[]');
    const v3 = OPEN_OCEAN_CAPABILITIES.find((fn) => fn.functionName === 'uniswapV3SwapTo')!;
    expect(v3.abi.inputs.find((input) => input.name === 'pools')?.type).toBe('uint256[]');
  });
});
