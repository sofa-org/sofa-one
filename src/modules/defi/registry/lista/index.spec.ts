import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildListaRegistry, LISTA_CAPABILITIES } from './index';

const target = '0x1adB950d8bB3dA4bE104211D5AB038628e477fE6';
const other = '0x1111111111111111111111111111111111111111';
const max = (1n << 256n) - 1n;
const fragment = buildListaRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 56): DefiExecutionContext => ({ userId: 'lista-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });
const call = (fn: DefiFunctionPolicy, amount = max, value?: bigint) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: fn.functionName === 'deposit' ? [] : [amount] as never }),
  ...(value === undefined ? {} : { value }),
});

describe('Lista BSC StakeManager fixture', () => {
  it('matches all three inactive source ABIs, hashes, IDs and references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/lista.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('lista');
    expect(family.familyVersion).toBe('v1@9ee9a952');
    expect(contract).toMatchObject({ chainId: 56, address: target, status: 'inactive', contractName: 'Lista BSC StakeManager' });
    expect(contract.abiFunctions).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(LISTA_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability, fn.abi.outputs])).toEqual([
      ['deposit', `lista:stake-manager-v1:56:${target.toLowerCase()}:deposit`, 'deposit()', 'payable', []],
      ['requestWithdraw', `lista:stake-manager-v1:56:${target.toLowerCase()}:request-withdraw`, 'requestWithdraw(uint256)', 'nonpayable', []],
      ['claimWithdraw', `lista:stake-manager-v1:56:${target.toLowerCase()}:claim-withdraw`, 'claimWithdraw(uint256)', 'nonpayable', []],
    ]);
    for (const fn of LISTA_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(LISTA_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(3);
  });

  it('allows exact grants, payable deposits, and maximum uint256 arguments; defaults deny', async () => {
    const [deposit, request, claim] = LISTA_CAPABILITIES;
    await expect(policy.authorizeContractCalls([call(deposit, max, 17n)], context([deposit.capabilityId]))).resolves.toMatchObject({
      matches: [{ capabilityId: deposit.capabilityId }], interactions: [{ value: '17' }],
    });
    await expect(policy.authorizeContractCalls([call(deposit, max, 2n)], context([deposit.capabilityId]))).resolves.toBeDefined();
    for (const fn of [deposit, request, claim]) {
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    for (const fn of [request, claim]) {
      await expect(policy.authorizeContractCalls([call(fn, max)], context([fn.capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates each method, chain, target and selector', async () => {
    for (const fn of LISTA_CAPABILITIES) {
      for (const otherFn of LISTA_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: other }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 1))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects noncanonical calldata and native value on nonpayable operations', async () => {
    for (const fn of LISTA_CAPABILITIES) {
      const valid = call(fn);
      for (const data of [`0xdeadbeef${valid.data.slice(10)}`, `${valid.data}00`, valid.data.slice(0, -2)]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
      if (fn.functionName !== 'deposit') {
        await expect(policy.authorizeContractCalls([call(fn, max, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});
