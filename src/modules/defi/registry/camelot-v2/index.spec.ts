import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildCamelotRegistry } from './index';
const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'test-user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
const arg = (input: { type: string; components?: readonly { name: string; type: string; components?: readonly unknown[] }[] }): unknown => {
 if (input.type === 'tuple') return (input.components ?? []).map((part) => arg(part as never));
 if (input.type.endsWith('[]')) {
  const base = input.type.slice(0, -2);
  if (base === 'tuple') return [[...(input.components ?? []).map((part) => arg(part as never))]];
  if (base.startsWith('int')) return [-3n, 2n];
  if (base.startsWith('uint')) return [(1n << 255n) - 1n, 0n];
  if (base === 'address') return [A, B];
 }
 if (input.type === 'address') return B;
 if (input.type.startsWith('int')) return -3n;
 if (input.type.startsWith('uint')) return (1n << 255n) - 1n;
 return 0n;
};
describe('camelot bounded ABI policy matrix', () => {
 const fragment = buildCamelotRegistry();
 const functions = fragment.chains.flatMap((c) => c.contracts.flatMap((x) => x.functions));
 const find = (name: string) => functions.find((fn) => fn.functionName === name)!;
 it('keeps exactly the three documented active fixture calls at the exact chain/router with stable unique selectors', () => {
  expect(fragment.chains.map((c) => c.chainId)).toEqual([42161]);
  expect(fragment.chains[0].contracts.map((c) => c.address)).toEqual(['0xc873fEcbd354f5A56E00E710B90EF4201db2448d']);
  expect(functions).toHaveLength(3);
  expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract}:${toFunctionSelector(fn.signature)}`)).size).toBe(3);
  expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
 });
 it('checks exact one-capability authorization and default-empty denial for every canonical method', async () => {
  const manifest = buildReviewedManifest([fragment]);
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (fn: DefiFunctionPolicy, value: string | undefined = undefined) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: fn.abi.inputs.map((input) => arg(input as never)) as never }), value });
  for (const fn of functions) {
   const canonical = call(fn);
   await expect(policy.authorizeContractCalls([canonical],ctx(42161,[fn.capabilityId]))).resolves.toBeDefined();
   await expect(policy.authorizeContractCalls([canonical],ctx(42161,[]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
   await expect(policy.authorizeContractCalls([{...canonical,data:`${canonical.data}00`}],ctx(42161,[fn.capabilityId]))).rejects.toBeDefined();
   await expect(policy.authorizeContractCalls([{...canonical,to:A}],ctx(42161,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
   await expect(policy.authorizeContractCalls([canonical],ctx(137,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  }
  const fn = functions[0];
  await expect(policy.authorizeContractCalls([{to:fn.contract,data:'0xdeadbeef'}],ctx(42161,functions.map((x) => x.capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  const other = functions[1];
  await expect(policy.authorizeContractCalls([call(other)],ctx(42161,[functions[0].capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
 });
 it('preserves the protocol-specific referrer and dynamic-array ABI shapes', () => {
  const liquidity = find('addLiquidity');
  expect(liquidity.abi.inputs.map((x) => x.name)).toEqual(['tokenA','tokenB','amountADesired','amountBDesired','amountAMin','amountBMin','to','deadline']);
  const swap = find('swapExactTokensForTokensSupportingFeeOnTransferTokens');
  expect(swap.abi.inputs.map((x) => x.name)).toEqual(['amountIn','amountOutMin','path','to','referrer','deadline']);
  expect(swap.abi.inputs.map((x) => x.type)).toContain('address[]');
  expect(swap.abi.outputs).toEqual([]);
 });
});
