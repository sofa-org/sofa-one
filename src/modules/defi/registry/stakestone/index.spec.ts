import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildStakeStoneRegistry, STAKESTONE_CAPABILITIES } from './index';

const target = '0xA62F9C5af106FeEE069F38dE51098D9d81B90572';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildStakeStoneRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'stakestone-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const call = (fn: DefiFunctionPolicy, amount = max, value?: bigint) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: fn.functionName === 'deposit' ? [] : [amount] as never }),
  ...(value === undefined ? {} : { value }),
});

describe('StakeStone Ethereum StoneVault fixture', () => {
  it('binds all three inactive source methods to exact ABI hashes, IDs and refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/stakestone.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('stakestone');
    expect(family.familyVersion).toBe('stone-vault-v1@5315569');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'StakeStone Ethereum StoneVault' });
    expect(contract.abiFunctions).toHaveLength(3);
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(STAKESTONE_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability, fn.abi.outputs])).toEqual([
      ['deposit', `stakestone:stone-vault-v1:1:${target.toLowerCase()}:deposit`, 'deposit()', 'payable', [{ name: 'mintAmount', type: 'uint256', internalType: 'uint256' }]],
      ['requestWithdraw', `stakestone:stone-vault-v1:1:${target.toLowerCase()}:request-withdraw`, 'requestWithdraw(uint256)', 'nonpayable', []],
      ['cancelWithdraw', `stakestone:stone-vault-v1:1:${target.toLowerCase()}:cancel-withdraw`, 'cancelWithdraw(uint256)', 'nonpayable', []],
    ]);
    for (const fn of STAKESTONE_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(STAKESTONE_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(3);
  });

  it('requires exact grants, accepts native value for deposit, and denies it for request/cancel', async () => {
    for (const fn of STAKESTONE_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      if (fn.functionName === 'deposit') {
        await expect(policy.authorizeContractCalls([call(fn, max, 17n)], context([fn.capabilityId]))).resolves.toMatchObject({ interactions: [{ value: '17' }] });
      } else {
        await expect(policy.authorizeContractCalls([call(fn, max)], context([fn.capabilityId]))).resolves.toBeDefined();
        await expect(policy.authorizeContractCalls([call(fn, 0n)], context([fn.capabilityId]))).resolves.toBeDefined();
        await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });

  it('isolates method, chain, selector and exact target', async () => {
    for (const fn of STAKESTONE_CAPABILITIES) {
      for (const otherFn of STAKESTONE_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 56))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('accepts maximum uint256 request values and rejects unknown/trailing/truncated calldata', async () => {
    for (const fn of STAKESTONE_CAPABILITIES) {
      const valid = call(fn);
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
    const request = STAKESTONE_CAPABILITIES.find((fn) => fn.functionName === 'requestWithdraw')!;
    const maxCall = call(request, max);
    await expect(policy.authorizeContractCalls([maxCall], context([request.capabilityId]))).resolves.toBeDefined();
  });
});
