import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildSkyRegistry, SKY_CAPABILITIES } from './index';

const target = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const implementation = '0x4e7991e5C547ce825BdEb665EE14a3274f9F61e0';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildSkyRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'sky-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy, amount = max) => {
  const isDepositOrMint = fn.functionName === 'deposit' || fn.functionName === 'mint';
  const base = isDepositOrMint ? [amount, other] : [amount, other, other];
  return fn.abi.inputs.some((input) => input.type === 'uint16') ? [...base, 65535] : base;
};
const call = (fn: DefiFunctionPolicy, amount = max, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn, amount) as never }), ...(value === undefined ? {} : { value }) });

describe('Sky sUSDS Ethereum Savings fixture', () => {
  it('binds all six inactive overloads to literal ABI hashes, selector IDs and source refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/sky.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('sky');
    expect(family.familyVersion).toBe('susds-v1@5381240');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Sky Ethereum sUSDS' });
    expect(contract.abiFunctions).toHaveLength(6);
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(SKY_CAPABILITIES).toHaveLength(6);
    const signatures = [
      ['deposit', 'deposit(uint256,address)', 'shares'],
      ['deposit', 'deposit(uint256,address,uint16)', 'shares'],
      ['mint', 'mint(uint256,address)', 'assets'],
      ['mint', 'mint(uint256,address,uint16)', 'assets'],
      ['withdraw', 'withdraw(uint256,address,address)', 'shares'],
      ['redeem', 'redeem(uint256,address,address)', 'assets'],
    ];
    expect(SKY_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.abi.stateMutability, fn.abi.outputs[0]?.name])).toEqual(signatures.map(([name, signature, output]) => [name, signature, 'nonpayable', output]));
    expect(SKY_CAPABILITIES.map((fn) => fn.capabilityId)).toEqual(signatures.map(([name, signature]) => `sky:susds-v1:1:${target.toLowerCase()}:${name}-${toFunctionSelector(signature as string).slice(2)}`));
    for (const fn of SKY_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName && entry.inputs.length === fn.abi.inputs.length);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.abi.inputs.map((input) => input.internalType)).toEqual(fn.abi.inputs.map((input) => input.type));
      expect(fn.status).toBe('active');
    }
    expect(new Set(SKY_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(6);
  });

  it('requires exact grants, accepts maximum uint256 amounts, and rejects native value', async () => {
    for (const fn of SKY_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 0n)], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, max)], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates overload grants, selectors, chain, proxy target, and listed implementation target', async () => {
    for (const fn of SKY_CAPABILITIES) {
      for (const otherFn of SKY_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: implementation }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('accepts caller-selected receivers, owners and referral; rejects malformed address and uint16 padding', async () => {
    const recipient = '0x00000000000000000000000000000000000000c3';
    const referralMint = SKY_CAPABILITIES.find((fn) => fn.functionName === 'mint' && fn.abi.inputs.length === 3)!;
    const data = encodeFunctionData({ abi: [referralMint.abi], functionName: referralMint.functionName, args: [max, recipient, 0x1234] });
    await expect(policy.authorizeContractCalls([{ to: target, data }], context([referralMint.capabilityId]))).resolves.toBeDefined();
    for (const fn of SKY_CAPABILITIES) {
      const valid = call(fn);
      const malformedAddress = `${valid.data.slice(0, 74)}${'1'.repeat(24)}${valid.data.slice(98)}`;
      const malformed: string[] = [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2), malformedAddress];
      if (fn.abi.inputs.some((input) => input.type === 'uint16')) {
        malformed.push(`${valid.data.slice(0, 138)}${'1'.repeat(60)}${valid.data.slice(198)}`);
      }
      for (const calldata of malformed) {
        await expect(policy.authorizeContractCalls([{ ...valid, data: calldata }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});
