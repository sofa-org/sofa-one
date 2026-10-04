import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildAngleRegistry, ANGLE_CAPABILITIES } from './index';

const target = '0x004626A008B1aCdC4c74ab51644093b155e59A23';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildAngleRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'angle-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const argsFor = (fn: DefiFunctionPolicy, amount = max) => fn.functionName === 'deposit' || fn.functionName === 'mint'
  ? [amount, other] : [amount, other, other];
const call = (fn: DefiFunctionPolicy, amount = max, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn, amount) as never }), ...(value === undefined ? {} : { value }) });

describe('Angle agEUR Savings Ethereum fixture', () => {
  it('binds exactly four literal inactive source declarations to ABI hashes, IDs and refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/angle.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('angle');
    expect(family.familyVersion).toBe('ageur-savings-v1@c3667da6');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Angle Ethereum agEUR Savings' });
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(contract.abiFunctions).toHaveLength(4);
    expect(ANGLE_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['deposit', `angle:ageur-savings-v1:1:${target.toLowerCase()}:deposit`, 'deposit(uint256,address)', 'nonpayable'],
      ['mint', `angle:ageur-savings-v1:1:${target.toLowerCase()}:mint`, 'mint(uint256,address)', 'nonpayable'],
      ['withdraw', `angle:ageur-savings-v1:1:${target.toLowerCase()}:withdraw`, 'withdraw(uint256,address,address)', 'nonpayable'],
      ['redeem', `angle:ageur-savings-v1:1:${target.toLowerCase()}:redeem`, 'redeem(uint256,address,address)', 'nonpayable'],
    ]);
    expect(ANGLE_CAPABILITIES.map((fn) => fn.abi.outputs)).toEqual([
      [{ name: 'shares', type: 'uint256', internalType: 'uint256' }],
      [{ name: 'assets', type: 'uint256', internalType: 'uint256' }],
      [{ name: 'shares', type: 'uint256', internalType: 'uint256' }],
      [{ name: 'assets', type: 'uint256', internalType: 'uint256' }],
    ]);
    for (const fn of ANGLE_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(ANGLE_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(4);
  });

  it('requires exact grants, accepts ABI-valid maximum amounts and rejects native value', async () => {
    for (const fn of ANGLE_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 0n)], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, max)], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('does not share grants across methods, chain or target', async () => {
    for (const fn of ANGLE_CAPABILITIES) {
      for (const otherFn of ANGLE_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('accepts caller-selected receiver and owner values but rejects noncanonical calldata', async () => {
    const recipient = '0x00000000000000000000000000000000000000c3';
    const fn = ANGLE_CAPABILITIES.find((candidate) => candidate.functionName === 'withdraw')!;
    const callerChosen = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [max, recipient, other] });
    await expect(policy.authorizeContractCalls([{ to: target, data: callerChosen }], context([fn.capabilityId]))).resolves.toBeDefined();
    for (const candidate of ANGLE_CAPABILITIES) {
      const valid = call(candidate);
      const malformedAddress = `${valid.data.slice(0, 74)}${'1'.repeat(24)}${valid.data.slice(98)}`;
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2), malformedAddress]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([candidate.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});
