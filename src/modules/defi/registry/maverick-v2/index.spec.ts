import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { functionAbiHash, buildReviewedManifest } from '../defi-manifest';
import { buildMaverickV2Registry } from './index';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'maverick-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Maverick V2 bounded router fixture', () => {
  const fragment = buildMaverickV2Registry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (fn: DefiFunctionPolicy, tokenAIn: boolean, value?: string) => ({
    to: fn.contract,
    value,
    data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [B, A, tokenAIn, (1n << 256n) - 1n, (1n << 256n) - 1n] }),
  });

  it('has exactly one chain-specific active fixture call per documented router with full source ABI identity', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/maverick.json', 'utf8'));
    const rawFunctions = source.families[0].chains.flatMap((chain: { contracts: Array<{ functions: unknown[] }> }) => chain.contracts.flatMap((contract) => contract.functions));
    const sources = new Map(source.sources.map((record: { sourceId: string }) => [record.sourceId, record]));
    expect(rawFunctions).toHaveLength(2);
    expect(source.sources.every((record: Record<string, unknown>) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([42161, 8453]);
    expect(fragment.chains.map((chain) => chain.contracts[0].address)).toEqual(['0x5c3b380e5Aeec389d1014Da3Eb372FA2C9e0fc76', '0x5eDEd0d7E76C563FF081Ca01D9d12D6B404Df527']);
    expect(functions).toHaveLength(2);
    for (const [index, fn] of functions.entries()) {
      const raw = rawFunctions[index] as { abi: unknown; provenance: { sourceRef: string }; status: string; signature: string; capabilityId: string };
      expect(raw.status).toBe('inactive');
      expect(sources.has(raw.provenance.sourceRef)).toBe(true);
      expect(raw.abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: raw.abi as DefiFunctionPolicy['abi'] })).toBe(functionAbiHash(fn));
      expect(fn.signature).toBe('exactInputSingle(address,address,bool,uint256,uint256)');
      expect(toFunctionSelector(fn.signature)).toBe(toFunctionSelector(raw.signature));
      expect(fn.capabilityId).toBe(`maverick-v2:v2:${fn.chainId}:${fn.contract.toLowerCase()}:exact-input-single`);
      expect(fn.abi.inputs.map((input) => input.name)).toEqual(['recipient', 'pool', 'tokenAIn', 'amountIn', 'amountOutMinimum']);
      expect(fn.abi.inputs.map((input) => (input as { internalType?: string }).internalType)).toEqual(['address', 'contract IMaverickV2Pool', 'bool', 'uint256', 'uint256']);
      expect(fn.abi.outputs).toEqual([{ name: 'amountOut', type: 'uint256', internalType: 'uint256' }]);
      expect(fn.abi.stateMutability).toBe('payable');
    }
  });

  it('authorizes both directions and payable value only under each exact chain-target grant', async () => {
    for (const fn of functions) {
      await expect(policy.authorizeContractCalls([call(fn, true, '17')], ctx(fn.chainId, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId, chainId: fn.chainId, contract: fn.contract }] });
      await expect(policy.authorizeContractCalls([call(fn, false, '17')], ctx(fn.chainId, [fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, true, '17')], ctx(fn.chainId, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const other = functions.find((candidate) => candidate.chainId !== fn.chainId)!;
      await expect(policy.authorizeContractCalls([call(fn, true)], ctx(other.chainId, [fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, true)], ctx(fn.chainId, [other.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ ...call(fn, true), to: A }], ctx(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    }
  });

  it('rejects wrong selector, trailing bytes, malformed bool and tuple/five-argument ABI impostors', async () => {
    for (const fn of functions) {
      const good = call(fn, true);
      await expect(policy.authorizeContractCalls([{ ...good, data: `0xdeadbeef${good.data.slice(10)}` }], ctx(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], ctx(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      const boolWordOffset = 10 + 2 * 64;
      const malformedBool = `${good.data.slice(0, boolWordOffset)}${'0'.repeat(63)}2${good.data.slice(boolWordOffset + 64)}`;
      await expect(policy.authorizeContractCalls([{ ...good, data: malformedBool }], ctx(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    const fn = functions[0];
    const fakeTuple = { type: 'function', name: 'exactInputSingle', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'recipient', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'tokenAIn', type: 'bool' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }] };
    const impostor = `${toFunctionSelector('exactInputSingle((address,address,bool,uint256,uint256))')}${encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [B, A, true, 1n, 1n]).slice(2)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: impostor }], ctx(fn.chainId, [fn.capabilityId]))).rejects.toBeDefined();
  });
});
