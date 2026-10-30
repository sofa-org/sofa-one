import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildRocketPoolRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Rocket Pool source fixture', () => {
  const fragment = buildRocketPoolRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (name: string) => functions.find((fn) => fn.functionName === name)!;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (fn: DefiFunctionPolicy, args: readonly unknown[] = [], value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), value });

  it('contains only the two canonical Mainnet calls and stable source-qualified ids', () => {
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([1]);
    expect(functions).toHaveLength(2);
    expect(functions.map((fn) => [fn.functionName, fn.contract, fn.signature])).toEqual([
      ['deposit', '0xDD3f50F8A6CafbE9b31a427582963f465E745AF8', 'deposit()'],
      ['burn', '0xae78736Cd615f374D3085123A210448E74Fc6393', 'burn(uint256)'],
    ]);
    expect(functions.map((fn) => fn.capabilityId)).toEqual(functions.map((fn) => `rocket-pool:v1:1:${fn.contract.toLowerCase()}:${fn.operation}`));
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(2);
    expect(find('deposit').abi).toMatchObject({ stateMutability: 'payable', inputs: [], outputs: [] });
    expect(find('burn').abi).toMatchObject({ stateMutability: 'nonpayable', inputs: [{ name: '_rethAmount', type: 'uint256' }], outputs: [] });
  });

  it('authorizes each function only with its exact grant, target, chain, and canonical calldata', async () => {
    const deposit = find('deposit');
    const burn = find('burn');
    await expect(policy.authorizeContractCalls([call(deposit, [], '17')], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(burn, [17n])], context(1, [burn.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(deposit, [], '17')], context(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call(burn, [17n])], context(1, [deposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call(deposit)], context(5, [deposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...call(deposit, [], '17'), to: A }], context(1, [deposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...call(burn, [17n]), data: `${call(burn, [17n]).data}00` }], context(1, [burn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(burn, [17n]), data: `0xffffffff${call(burn, [17n]).data!.slice(10)}` }], context(1, [burn.capabilityId]))).rejects.toBeDefined();
  });

  it('enforces payable versus nonpayable value and does not widen a token grant to another target', async () => {
    const deposit = find('deposit');
    const burn = find('burn');
    await expect(policy.authorizeContractCalls([call(deposit, [], '17')], context(1, [deposit.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(burn, [17n], '17')], context(1, [burn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...call(burn, [17n]), to: '0x0000000000000000000000000000000000000003' }], context(1, [burn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
  });
});
