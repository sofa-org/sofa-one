import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildKelpRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Kelp source fixture', () => {
  const fragment = buildKelpRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (operation: string) => functions.find((fn) => fn.operation === operation)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const values: Record<string, readonly unknown[]> = {
    'deposit-eth': [0n, 'ref'], 'deposit-asset': [B, 1n, 0n, 'ref'],
    'initiate-withdrawal': [B, 1n, 'ref'], 'complete-withdrawal': [B, 'ref'],
  };
  const call = (fn: DefiFunctionPolicy, args: readonly unknown[] = values[fn.operation!]!, value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), value });

  it('describes exactly four source-qualified Mainnet methods with void outputs and exact stable identities', () => {
    expect(fragment.chains.map(({ chainId }) => chainId)).toEqual([1]);
    expect(functions.map(({ operation }) => operation)).toEqual(['deposit-eth', 'deposit-asset', 'initiate-withdrawal', 'complete-withdrawal']);
    expect(new Set(functions.map(({ contract, signature }) => `${contract.toLowerCase()}:${toFunctionSelector(signature)}`)).size).toBe(4);
    for (const fn of functions) {
      expect(fn.capabilityId).toBe(`kelp:v1:1:${fn.contract.toLowerCase()}:${fn.operation}`);
      expect(fn.abi.outputs).toEqual([]);
      expect(fn.provenance.sourceRef).toContain('3dded885f6f797f5959aff449c3a30c5cbb6ce23');
    }
    expect(functions.map(({ signature }) => signature)).toEqual([
      'depositETH(uint256,string)', 'depositAsset(address,uint256,uint256,string)',
      'initiateWithdrawal(address,uint256,string)', 'completeWithdrawal(address,string)',
    ]);
  });

  it.each(['deposit-eth', 'deposit-asset', 'initiate-withdrawal', 'complete-withdrawal'])('%s is authorized only by its exact canonical grant and target', async (operation) => {
    const fn = find(operation);
    const value = operation === 'deposit-eth' ? '17' : undefined;
    const calldata = call(fn, values[operation], value);
    await expect(policy.authorizeContractCalls([calldata], context(1, [fn.capabilityId])).then(() => true)).resolves.toBe(true);
    await expect(policy.authorizeContractCalls([calldata], context(1, [])).then(() => true)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const other = find(operation === 'deposit-eth' ? 'deposit-asset' : 'deposit-eth');
    await expect(policy.authorizeContractCalls([calldata], context(1, [other.capabilityId])).then(() => true)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, to: A }], context(1, [fn.capabilityId])).then(() => true)).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([calldata], context(5, [fn.capabilityId])).then(() => true)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `0xffffffff${calldata.data!.slice(10)}` }], context(1, [fn.capabilityId])).then(() => true)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `${calldata.data}00` }], context(1, [fn.capabilityId])).then(() => true)).rejects.toBeDefined();
    if (operation === 'deposit-eth') await expect(policy.authorizeContractCalls([call(fn, values[operation], '0')], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    else await expect(policy.authorizeContractCalls([call(fn, values[operation], '1')], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('leaves ABI-valid amounts, minimum output, asset and referral caller-selected without inferred policy', async () => {
    const max = (1n << 256n) - 1n;
    const eth = find('deposit-eth');
    const asset = find('deposit-asset');
    const withdrawal = find('initiate-withdrawal');
    await expect(policy.authorizeContractCalls([call(eth, [max, 'arbitrary\u0000referral'], '1')], context(1, [eth.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(asset, [A, max, max, 'caller string'])], context(1, [asset.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(withdrawal, [A, max, 'caller string'])], context(1, [withdrawal.capabilityId]))).resolves.toBeDefined();
  });
});
