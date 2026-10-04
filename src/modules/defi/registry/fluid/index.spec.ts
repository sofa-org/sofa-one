import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest } from '../defi-manifest';
import { buildFluidRegistry, FLUID_CAPABILITIES } from './index';

const chains = buildFluidRegistry().chains;
const manifest = buildReviewedManifest([{ chains }]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const context = (allowedCapabilityIds: string[] = FLUID_CAPABILITIES.map((fn) => fn.capabilityId), chainId = 8453): DefiExecutionContext => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
const policy = () => new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(chains, prisma as never, manifest));
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const max = (1n << 256n) - 1n;
const maxSigned = (1n << 255n) - 1n;
function argsFor(fn: (typeof FLUID_CAPABILITIES)[number]): readonly unknown[] {
  if (fn.functionName === 'operate') return [0n, maxSigned, -maxSigned, address(90)];
  const inputs = fn.abi.inputs;
  return inputs.map(({ name, type }, index) => type === 'address' ? address(20 + index) : max);
}
function calldata(fn: (typeof FLUID_CAPABILITIES)[number], args = argsFor(fn)): `0x${string}` {
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
}

describe('Fluid Base registry fixture', () => {
  it('keeps the source snapshot source-qualified and consistent with all three official artifacts', () => {
    const source = JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v5/sources/fluid.json'), 'utf8')) as {
      families: { familyId: string; familyVersion: string; contracts: { chainId: number; address: string; abiFunctions: { name: string; inputs: { type: string }[] }[] }[] }[];
      sources: { sourceId: string; url: string; retrievedAtUtc: string; evidence: string }[];
    };
    expect(source.families.map(({ familyId, familyVersion }) => [familyId, familyVersion])).toEqual([['fluid-lending', 'v1'], ['fluid-vault-t1', 'v1']]);
    expect(source.families.flatMap(({ contracts }) => contracts.map(({ chainId, address }) => [chainId, address]))).toEqual([
      [8453, '0xf42f5795d9ac7e9d757db633d693cd548cfd9169'],
      [8453, '0x9272d6153133175175bc276512b2336be3931ce9'],
      [8453, '0x03271c337c86a6fd89625a2820e48621dc2a128b'],
    ]);
    expect(source.families.flatMap(({ contracts }) => contracts.flatMap(({ abiFunctions }) => abiFunctions))).toHaveLength(17);
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every(({ retrievedAtUtc }) => retrievedAtUtc === '2026-10-04')).toBe(true);
    expect(source.sources.map(({ url }) => url)).toEqual([
      'https://raw.githubusercontent.com/Instadapp/fluid-contracts-public/9496626f71a761fc296dc3b2efbfd54c504e18f0/deployments/base/fToken_fUSDC.json',
      'https://raw.githubusercontent.com/Instadapp/fluid-contracts-public/9496626f71a761fc296dc3b2efbfd54c504e18f0/deployments/base/fToken_fWETH.json',
      'https://raw.githubusercontent.com/Instadapp/fluid-contracts-public/9496626f71a761fc296dc3b2efbfd54c504e18f0/deployments/base/VaultT1_ETH_GHO.json',
    ]);
  });

  it('declares exactly 17 source-qualified artifact functions and selector-qualified overload IDs', () => {
    expect(chains.map(({ chainId }) => chainId)).toEqual([8453]);
    expect(FLUID_CAPABILITIES).toHaveLength(17);
    expect(FLUID_CAPABILITIES.filter(({ functionName }) => functionName !== 'operate')).toHaveLength(16);
    expect(FLUID_CAPABILITIES.filter(({ functionName }) => functionName === 'operate')).toHaveLength(1);
    expect(FLUID_CAPABILITIES.every(({ status, provenance }) => status === 'active' && provenance.status === 'verified' && provenance.verifiedAt === '2026-10-04')).toBe(true);
    expect(FLUID_CAPABILITIES.every(({ signature, capabilityId, contract }) => capabilityId.includes(`:${contract.toLowerCase()}:`) && (signature === 'operate(uint256,int256,int256,address)' ? capabilityId.endsWith(':operate') : capabilityId.endsWith(toFunctionSelector(signature).slice(2))))).toBe(true);
    expect(FLUID_CAPABILITIES.slice(0, 16).every(({ abi }) => abi.stateMutability === 'nonpayable')).toBe(true);
    expect(FLUID_CAPABILITIES[16].abi).toMatchObject({ name: 'operate', stateMutability: 'payable', inputs: [{ name: 'nftId_', type: 'uint256' }, { name: 'newCol_', type: 'int256' }, { name: 'newDebt_', type: 'int256' }, { name: 'to_', type: 'address' }], outputs: [{ name: '', type: 'uint256' }, { name: '', type: 'int256' }, { name: '', type: 'int256' }] });
    for (const token of ['0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169', '0x9272D6153133175175Bc276512B2336BE3931CE9']) {
      const functions = FLUID_CAPABILITIES.filter(({ contract }) => contract === token);
      expect(functions).toHaveLength(8);
      expect(new Set(functions.map(({ signature }) => signature)).size).toBe(8);
      expect(new Set(functions.map(({ capabilityId }) => capabilityId)).size).toBe(8);
    }
  });

  it.each(FLUID_CAPABILITIES)('authorizes the exact explicitly granted $signature ABI', async (fn) => {
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: calldata(fn) }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId, functionSignature: fn.signature }] });
  });

  it('denies empty grants, wrong chain/target/selector, noncanonical or trailing calldata', async () => {
    const fn = FLUID_CAPABILITIES[0];
    const data = calldata(fn);
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data }], context([fn.capabilityId], 1))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy().authorizeContractCalls([{ to: address(99), data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data: `${data}00` }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('keeps overload grants independent and rejects value on each fToken overload', async () => {
    const twoArgDeposit = FLUID_CAPABILITIES.find(({ contract, signature }) => contract === '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169' && signature === 'deposit(uint256,address)')!;
    const threeArgDeposit = FLUID_CAPABILITIES.find(({ contract, signature }) => contract === twoArgDeposit.contract && signature === 'deposit(uint256,address,uint256)')!;
    await expect(policy().authorizeContractCalls([{ to: twoArgDeposit.contract, data: calldata(threeArgDeposit) }], context([twoArgDeposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    for (const fn of FLUID_CAPABILITIES.filter(({ functionName }) => functionName !== 'operate')) {
      await expect(policy().authorizeContractCalls([{ to: fn.contract, data: calldata(fn), value: 1n }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    const otherMarketOverload = FLUID_CAPABILITIES.find(({ contract, signature }) => contract === '0x9272D6153133175175Bc276512B2336BE3931CE9' && signature === twoArgDeposit.signature)!;
    await expect(policy().authorizeContractCalls([{ to: otherMarketOverload.contract, data: calldata(otherMarketOverload) }], context([twoArgDeposit.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('allows caller-selected signed operate deltas, zero position ID and native value', async () => {
    const fn = FLUID_CAPABILITIES[16];
    const data = calldata(fn, [0n, -maxSigned, maxSigned, address(777)]);
    await expect(policy().authorizeContractCalls([{ to: fn.contract, data, value: max }], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
  });
});
