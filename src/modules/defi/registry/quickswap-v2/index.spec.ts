import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildQuickSwapV2Registry } from './index';
const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
describe('QuickSwap V2 source fixture', () => {
 const fragment = buildQuickSwapV2Registry();
 const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
 const find = (name: string) => functions.find((fn) => fn.functionName === name)!;
 it('exposes precisely the bounded chain/router/function set and collision-free selectors', () => {
  expect(fragment.chains.map((x) => x.chainId)).toEqual([137]);
  expect(fragment.chains[0].contracts.map((x) => x.address)).toEqual(['0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff']);
  expect(functions).toHaveLength(10);
  expect(functions.filter((x) => x.functionName.startsWith('swap'))).toHaveLength(6);
  expect(functions.filter((x) => x.functionName.startsWith('add') || x.functionName.startsWith('remove'))).toHaveLength(4);
  expect(new Set(functions.map((x) => `${x.chainId}:${x.contract}:${toFunctionSelector(x.signature)}`)).size).toBe(10);
  expect(functions.map((x) => x.capabilityId)).toEqual(functions.map((x) => `quickswap-v2:v2:137:0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff:${x.operation}`));
  expect(functions.filter((x) => x.abi.stateMutability === 'payable').map((x) => x.functionName).sort()).toEqual(['addLiquidityETH', 'swapETHForExactTokens', 'swapExactETHForTokens'].sort());
 });
 it('matches Router interface names and named outputs', () => {
  for (const name of ['swapExactTokensForTokens','swapTokensForExactTokens','swapExactETHForTokens','swapTokensForExactETH','swapExactTokensForETH','swapETHForExactTokens']) expect(find(name).abi.outputs).toEqual([{ name: 'amounts', type: 'uint256[]' }]);
  expect(find('addLiquidity').abi.outputs.map(x => x.name)).toEqual(['amountA','amountB','liquidity']);
  expect(find('addLiquidityETH').abi.outputs.map(x => x.name)).toEqual(['amountToken','amountETH','liquidity']);
  expect(find('removeLiquidity').abi.outputs.map(x => x.name)).toEqual(['amountA','amountB']);
  expect(find('removeLiquidityETH').abi.outputs.map(x => x.name)).toEqual(['amountToken','amountETH']);
 });
 it('uses actual manifest and policy for exact grants, canonical calldata, and payability', async () => {
  const manifest = buildReviewedManifest([fragment]);
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (fn: DefiFunctionPolicy, args: readonly unknown[], value?: string) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never }), value });
  const argsFor = (fn: DefiFunctionPolicy) => fn.abi.inputs.map((input) => input.type === 'address[]' ? [A, B] : input.type === 'address' ? B : (1n << 256n) - 1n);
  for (const fn of functions) {
   const args = argsFor(fn);
   const positiveValue = fn.abi.stateMutability === 'payable' ? '17' : undefined;
   await expect(policy.authorizeContractCalls([call(fn,args,positiveValue)],context(137,[fn.capabilityId]))).resolves.toBeDefined();
   await expect(policy.authorizeContractCalls([call(fn,args,positiveValue)],context(137,[]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
   if (fn.abi.stateMutability === 'nonpayable') {
    await expect(policy.authorizeContractCalls([call(fn,args,'1')],context(137,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
   }
   const canonical = call(fn,args).data!;
   await expect(policy.authorizeContractCalls([{to:fn.contract,data:`${canonical}00`}],context(137,[fn.capabilityId]))).rejects.toBeDefined();
  }
  const fn = find('swapExactTokensForTokens');
  const other = find('swapTokensForExactTokens');
  await expect(policy.authorizeContractCalls([call(other,argsFor(other))],context(137,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  await expect(policy.authorizeContractCalls([{to:fn.contract,data:'0xdeadbeef'}],context(137,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  await expect(policy.authorizeContractCalls([call(fn,[1n,0n,[A,B],B,1n])],context(10,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
  await expect(policy.authorizeContractCalls([{...call(fn,[1n,0n,[A,B],B,1n]),to:A}],context(137,[fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
 });
});
