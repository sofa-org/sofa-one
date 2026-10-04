import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildBeefyStandardRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Beefy standard source fixture', () => {
  const fragment = buildBeefyStandardRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (contract: string, name: string) => functions.find((fn) => fn.contract.toLowerCase() === contract.toLowerCase() && fn.functionName === name)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (fn: DefiFunctionPolicy, args: readonly unknown[] = [], value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), value });
  const eurc = '0x01F1A592B0b757B2931bbcCf28227cdC1e892dde';
  const lcap = '0x028baCa249B33d24FC32ac01d6531F6be0061c8E';
  const source = JSON.parse(readFileSync(join(process.cwd(), 'data/defi-catalog/v5/sources/beefy.json'), 'utf8')) as {
    families: Array<{ contracts: Array<{ chainId: number; address: string; abiFunctions: Array<Record<string, unknown>> }> }>;
  };

  it('declares only the two official Base standard vaults and four canonical source-qualified calls apiece', () => {
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([8453]);
    expect(functions).toHaveLength(8);
    expect(fragment.chains[0].contracts.map((contract) => contract.address)).toEqual([eurc, lcap]);
    expect(functions.map((fn) => [fn.contract, fn.functionName, fn.signature])).toEqual([eurc, lcap].flatMap((contract) => [
      [contract, 'deposit', 'deposit(uint256)'], [contract, 'depositAll', 'depositAll()'],
      [contract, 'withdraw', 'withdraw(uint256)'], [contract, 'withdrawAll', 'withdrawAll()'],
    ]));
    expect(functions.map((fn) => fn.capabilityId)).toEqual(functions.map((fn) => `beefy-standard:v1:8453:${fn.contract.toLowerCase()}:${fn.operation}`));
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(8);
    for (const fn of functions) expect(fn.abi).toMatchObject({ type: 'function', stateMutability: 'nonpayable', outputs: [] });
    expect(find(eurc, 'deposit').abi.inputs).toEqual([{ name: '_amount', type: 'uint256', internalType: 'uint256' }]);
    expect(find(eurc, 'withdraw').abi.inputs).toEqual([{ name: '_shares', type: 'uint256', internalType: 'uint256' }]);
    expect(find(eurc, 'depositAll').abi.inputs).toEqual([]);
    expect(find(eurc, 'withdrawAll').abi.inputs).toEqual([]);
    const sourceContracts = source.families.flatMap((family) => family.contracts);
    expect(sourceContracts).toHaveLength(2);
    for (const fn of functions) {
      const sourceContract = sourceContracts.find((contract) => contract.chainId === fn.chainId && contract.address.toLowerCase() === fn.contract.toLowerCase());
      const sourceAbi = sourceContract?.abiFunctions.find((candidate) => candidate.name === fn.functionName);
      expect(sourceAbi).toBeDefined();
      expect(functionAbiHash({ abi: fn.abi })).toBe(functionAbiHash({ abi: sourceAbi as never }));
    }
    expect(buildReviewedManifest([fragment]).capabilities).toHaveLength(8);
  });

  it('requires the exact grant, Base chain, target and canonical selector/data', async () => {
    for (const fn of functions) {
      const args = fn.functionName === 'deposit' || fn.functionName === 'withdraw' ? [17n] : [];
      await expect(policy.authorizeContractCalls([call(fn, args)], context(8453, [fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, args)], context(8453, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, args)], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
      const other = fn.contract.toLowerCase() === eurc.toLowerCase() ? lcap : eurc;
      await expect(policy.authorizeContractCalls([{ ...call(fn, args), to: other }], context(8453, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...call(fn, args), data: `${call(fn, args).data}00` }], context(8453, [fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn, args), data: `0xffffffff${call(fn, args).data!.slice(10)}` }], context(8453, [fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('allows caller-selected uint256 arguments without adding token, spender, or amount policy, but rejects malformed arguments and native value', async () => {
    for (const fn of functions.filter((candidate) => candidate.functionName === 'deposit' || candidate.functionName === 'withdraw')) {
      await expect(policy.authorizeContractCalls([call(fn, [2n ** 256n - 1n])], context(8453, [fn.capabilityId]))).resolves.toBeDefined();
      const encoded = call(fn, [17n]);
      await expect(policy.authorizeContractCalls([{ ...encoded, data: encoded.data!.slice(0, -2) }], context(8453, [fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, [17n], '1')], context(8453, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    for (const fn of functions.filter((candidate) => candidate.functionName === 'depositAll' || candidate.functionName === 'withdrawAll')) {
      await expect(policy.authorizeContractCalls([call(fn)], context(8453, [fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), data: `${call(fn).data}00` }], context(8453, [fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, [], '1')], context(8453, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});
