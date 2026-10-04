import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildPendleV3Registry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Pendle v3 source fixture', () => {
  const fragment = buildPendleV3Registry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/pendle.json', 'utf8')) as { families: Array<{ familyId: string; familyVersion: string; contracts: Array<{ chainId: number; address: string; status: string; abiFunctions: DefiFunctionPolicy['abi'][] }> }>; sources: Array<Record<string, unknown>> };
  const args: Record<string, readonly unknown[]> = {
    'add-liquidity-dual-sy-pt': [B, C, 1n, 2n, 0n], 'remove-liquidity-dual-sy-pt': [B, C, 1n, 0n, 0n],
    'mint-py-from-sy': [B, C, 1n, 0n], 'redeem-py-to-sy': [B, C, 1n, 0n],
    'deposit-sy': [B, C, 1n, 0n], 'redeem-sy': [B, 1n, C, 0n, false],
  };
  const call = (fn: DefiFunctionPolicy, values = args[fn.operation!]!, value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never }), value });

  it('binds all six fixture functions to source rows by exact target, signature and ABI hash', () => {
    expect(source.families).toHaveLength(1);
    expect(source.families[0]).toMatchObject({ familyId: 'pendle-v3', familyVersion: 'router-sy@87685c89' });
    expect(source.sources.every((row) => Object.keys(row).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    const sourceFunctions = source.families.flatMap((family) => family.contracts.flatMap((contract) => contract.abiFunctions.map((abi) => ({ chainId: contract.chainId, address: contract.address, abi }))));
    expect(sourceFunctions).toHaveLength(6);
    expect(functions).toHaveLength(6);
    expect(fragment.chains.map(({ chainId }) => chainId)).toEqual([1]);
    for (const fn of functions) {
      expect(fn.capabilityId).toBe(`pendle-v3:v3:1:${fn.contract.toLowerCase()}:${fn.operation}`);
      const matches = sourceFunctions.filter((row) => row.chainId === fn.chainId && row.address.toLowerCase() === fn.contract.toLowerCase() && row.abi.name === fn.functionName && `${fn.functionName}(${row.abi.inputs.map(({ type }) => type).join(',')})` === fn.signature && functionAbiHash({ abi: row.abi as never }) === functionAbiHash(fn));
      expect(matches).toHaveLength(1);
      expect(fn.provenance.sourceRef).toContain('87685c89d05087535e9b9647eeda0e3d297d1f06');
    }
    expect(new Set(functions.map(({ contract, signature }) => `${contract.toLowerCase()}:${toFunctionSelector(signature)}`)).size).toBe(6);
    expect(functions.map(({ signature }) => signature)).toEqual([
      'addLiquidityDualSyAndPt(address,address,uint256,uint256,uint256)', 'removeLiquidityDualSyAndPt(address,address,uint256,uint256,uint256)',
      'mintPyFromSy(address,address,uint256,uint256)', 'redeemPyToSy(address,address,uint256,uint256)',
      'deposit(address,address,uint256,uint256)', 'redeem(address,uint256,address,uint256,bool)',
    ]);
  });

  it.each(['add-liquidity-dual-sy-pt', 'remove-liquidity-dual-sy-pt', 'mint-py-from-sy', 'redeem-py-to-sy', 'deposit-sy', 'redeem-sy'])('%s requires its exact grant, target, chain, selector and canonical calldata', async (operation) => {
    const fn = functions.find((item) => item.operation === operation)!;
    const value = operation === 'deposit-sy' ? '17' : undefined;
    const calldata = call(fn, args[operation], value);
    await expect(policy.authorizeContractCalls([calldata], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([calldata], context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const other = functions.find((item) => item.operation !== operation)!;
    await expect(policy.authorizeContractCalls([calldata], context(1, [other.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, to: A }], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([calldata], context(5, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `0xffffffff${calldata.data!.slice(10)}` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `${calldata.data}00` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    if (operation === 'redeem-sy') {
      const nonCanonicalBool = `${calldata.data!.slice(0, -64)}${'0'.repeat(63)}2`;
      await expect(policy.authorizeContractCalls([{ ...calldata, data: nonCanonicalBool }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    }
    if (operation === 'deposit-sy') await expect(policy.authorizeContractCalls([call(fn, args[operation], '1')], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    else await expect(policy.authorizeContractCalls([call(fn, args[operation], '1')], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('does not impose new financial or asset/receiver/YT restrictions on ABI-valid parameters', async () => {
    const max = (1n << 256n) - 1n;
    const add = functions.find((fn) => fn.operation === 'add-liquidity-dual-sy-pt')!;
    const deposit = functions.find((fn) => fn.operation === 'deposit-sy')!;
    const redeem = functions.find((fn) => fn.operation === 'redeem-sy')!;
    await expect(policy.authorizeContractCalls([call(add, [A, C, max, max, max])], context(1, [add.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit, [A, C, max, max], '17')], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(redeem, [A, max, C, max, true])], context(1, [redeem.capabilityId]))).resolves.toBeDefined();
  });
});
