import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildEtherfiRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Ether.fi source fixture', () => {
  const fragment = buildEtherfiRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (operation: string) => functions.find((fn) => fn.operation === operation)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (fn: DefiFunctionPolicy, args: readonly unknown[], value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), value });
  const cases: Array<{ operation: string; args: readonly unknown[]; payable: boolean }> = [
    { operation: 'deposit-empty', args: [], payable: true },
    { operation: 'deposit-referral', args: [A], payable: true },
    { operation: 'deposit-user-referral', args: [A, B], payable: true },
    { operation: 'request-withdraw', args: [B, 123n], payable: false },
    { operation: 'wrap', args: [123n], payable: false },
    { operation: 'unwrap', args: [123n], payable: false },
    { operation: 'claim-withdraw', args: [123n], payable: false },
  ];

  it('exposes exactly seven Mainnet functions with selector-qualified IDs and complete canonical ABI', () => {
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([1]);
    expect(functions).toHaveLength(7);
    expect(new Set(functions.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(7);
    for (const fn of functions) {
      expect(fn.capabilityId).toBe(`etherfi:v1:1:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature).slice(2)}`);
      expect(fn.abi).toMatchObject({ type: 'function', name: fn.functionName, stateMutability: fn.abi.stateMutability, inputs: expect.any(Array), outputs: expect.any(Array) });
      expect(fn.provenance.sourceRef).toContain('15ff96d4d5e8e6a19a472cd40a7bcb858c9e7a88');
    }
    expect(functions.filter((fn) => fn.functionName === 'deposit').map((fn) => fn.signature)).toEqual(['deposit()', 'deposit(address)', 'deposit(address,address)']);
    expect(functions.some((fn) => fn.functionName === 'requestWithdraw' && fn.contract.toLowerCase() === '0x7d5706f6ef3f89b3951e23e557cdfbc3239d4e2c')).toBe(false);
  });

  it.each(cases)('$operation requires its exact grant and canonical target/chain/selector/data', async ({ operation, args, payable }) => {
    const fn = find(operation);
    const calldata = call(fn, args, payable ? '17' : undefined);
    await expect(policy.authorizeContractCalls([calldata], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([calldata], context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, to: C }], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([calldata], context(5, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `0xffffffff${calldata.data!.slice(10)}` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...calldata, data: `${calldata.data}00` }], context(1, [fn.capabilityId]))).rejects.toBeDefined();
    if (payable) {
      await expect(policy.authorizeContractCalls([call(fn, args, '1')], context(1, [fn.capabilityId]))).resolves.toBeDefined();
    } else {
      await expect(policy.authorizeContractCalls([call(fn, args, '1')], context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('does not let one overloaded deposit grant authorize another overload or a withdrawal NFT-only selector', async () => {
    const emptyDeposit = find('deposit-empty');
    const referralDeposit = find('deposit-referral');
    const request = find('request-withdraw');
    await expect(policy.authorizeContractCalls([call(referralDeposit, [A], '1')], context(1, [emptyDeposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call(emptyDeposit, [], '1')], context(1, [referralDeposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ ...call(request, [B, 123n]), to: find('claim-withdraw').contract }], context(1, [request.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });
});
