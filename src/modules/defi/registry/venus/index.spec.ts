import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildVenusRegistry } from './index';

const A = '0x0000000000000000000000000000000000000001';
const context = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
const addresses = ['0xA07c5b74C9B40447a954e1466938b865b6BBea36', '0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B', '0xf508fCD89b8bd15579dc79A6827cB4686A3592c8', '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8', '0xfD5840Cd36d94D7229439859C0112a4185BC0255'];

describe('Venus registry', () => {
  const fragment = buildVenusRegistry();
  const functions = fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
  const find = (address: string, signature: string) => functions.find((fn) => fn.contract.toLowerCase() === address.toLowerCase() && fn.signature === signature)!;
  const policy = () => {
    const manifest = buildReviewedManifest([fragment]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    return new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  };
  const encode = (fn: DefiFunctionPolicy, args: readonly unknown[]) => encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });

  it('publishes exactly 27 verified BNB calls at five markets and the Unitroller proxy', () => {
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([56]);
    expect(fragment.chains[0].contracts.map((contract) => contract.address)).toEqual([...addresses, '0xfD36E2c2a6789Db23113685031d7F16329158384']);
    expect(functions).toHaveLength(27);
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && fn.provenance.verifiedAt === '2026-10-03')).toBe(true);
    expect(new Set(functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(27);
    expect(find(addresses[0], 'mint()').abi).toMatchObject({ stateMutability: 'payable', inputs: [], outputs: [] });
    expect(find(addresses[0], 'repayBorrow()').abi).toMatchObject({ stateMutability: 'payable', inputs: [], outputs: [] });
    expect(find(addresses[0], 'mint(uint256)')).toBeUndefined();
    for (const address of addresses.slice(1)) for (const name of ['mint(uint256)', 'redeem(uint256)', 'redeemUnderlying(uint256)', 'borrow(uint256)', 'repayBorrow(uint256)']) expect(find(address, name).abi.outputs).toEqual([{ name: '', type: 'uint256' }]);
    expect(find('0xfD36E2c2a6789Db23113685031d7F16329158384', 'enterMarkets(address[])').abi.outputs).toEqual([{ name: '', type: 'uint256[]' }]);
    expect(find('0xfD36E2c2a6789Db23113685031d7F16329158384', 'exitMarket(address)').abi.outputs).toEqual([{ name: '', type: 'uint256' }]);
    expect(find(addresses[1], 'mint(uint256)').label).toContain('vBTC');
    expect(functions.every((fn) => fn.warnings?.some((warning) => warning.includes('nonzero protocol error codes')))).toBe(true);
  });

  it('authorizes all 27 exact functions including arbitrary arrays, native value, and returned protocol error codes', async () => {
    const svc = policy();
    for (const fn of functions) {
      const args = fn.signature === 'enterMarkets(address[])' ? [[addresses[3], addresses[4]]] : fn.signature === 'exitMarket(address)' ? [addresses[3]] : fn.signature.endsWith('()') ? [] : [0n];
      const value = fn.abi.stateMutability === 'payable' ? '123456' : undefined;
      await expect(svc.authorizeContractCalls([{ to: fn.contract, data: encode(fn, args), value }], context(56, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    }
  });

  it('denies absent grants, wrong chain/contract, unknown selectors, malformed calldata and value on nonpayable functions', async () => {
    const svc = policy();
    const fn = find(addresses[3], 'mint(uint256)');
    const data = encode(fn, [0n]);
    const deny = (call: { to: string; data: string; value?: string | number | bigint }, ctx = context(56, [fn.capabilityId])) => svc.authorizeContractCalls([call], ctx);
    await expect(deny({ to: fn.contract, data }, context(56, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(deny({ to: fn.contract, data }, context(1, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(deny({ to: addresses[0], data })).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: '0xdeadbeef' })).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(deny({ to: fn.contract, data: `${data}00` })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(deny({ to: fn.contract, data, value: '1' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const payable = find(addresses[0], 'mint()');
    await expect(deny({ to: payable.contract, data: encode(payable, []), value: '1' }, context(56, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const repay = find(addresses[0], 'repayBorrow()');
    await expect(svc.authorizeContractCalls([{ to: repay.contract, data: encode(repay, []), value: '99' }], context(56, [repay.capabilityId]))).resolves.toBeDefined();
  });
});
