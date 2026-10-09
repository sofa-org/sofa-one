import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildEulerVaultRegistry } from './index';

const vaults = ['0xb3b36220fA7d12f7055dab5c9FD18E860e9a6bF8', '0xF6E2EfDF175e7a91c8847dade42f2d39A9aE57D4'];
const evc = '0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'euler-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
describe('Euler registered EVault and EVC fixture', () => {
  const fragment = buildEulerVaultRegistry(); const contracts = fragment.chains[0].contracts;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const vaultArgs: any[][] = [[maxUint256, B], [maxUint256, B], [maxUint256, B, A], [maxUint256, B, A], [maxUint256, B], [maxUint256, B]];
  const evcArgs: any[][] = [[A, B], [A, B], [A, B], [A]];
  const f = (c: number, i: number) => contracts[c].functions[i];
  const call = (c: number, i: number, values?: any[], value?: string) => ({ to: contracts[c].address, value, data: encodeFunctionData({ abi: [f(c, i).abi], functionName: f(c, i).functionName, args: values ?? (c < 2 ? vaultArgs[i] : evcArgs[i]) }) });

  it('binds all sixteen inactive source ABIs, role addresses, full hashes, source refs and exact IDs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/euler.json', 'utf8'));
    const raw = source.families.flatMap((family: any) => family.chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions)));
    const fns = contracts.flatMap(c => c.functions);
    expect(contracts.map(c => c.address)).toEqual([...vaults, evc]); expect(raw).toHaveLength(16); expect(fns).toHaveLength(16);
    expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    raw.forEach((r: any, i: number) => {
      expect(r.status).toBe('inactive'); expect(source.sources.some((s: any) => s.sourceId === r.provenance.sourceRef)).toBe(true);
      expect(r.abi).toEqual(fns[i].abi); expect(functionAbiHash({ abi: r.abi })).toBe(functionAbiHash(fns[i]));
      expect(r.capabilityId).toBe(fns[i].capabilityId);
    });
    expect(new Set(fns.map(fn => fn.capabilityId)).size).toBe(16);
    expect(new Set(fns.map(fn => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(16);
  });

  it('requires exact grants and isolates vault, EVC, method and chain authority', async () => {
    for (const c of [0, 1, 2]) for (let i = 0; i < contracts[c].functions.length; i++) {
      const id = f(c, i).capabilityId;
      await expect(policy.authorizeContractCalls([call(c, i)], ctx(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(c, i)], ctx(1, [id]))).resolves.toMatchObject({ matches: [{ capabilityId: id }] });
      const other = c === 0 ? f(1, i).capabilityId : f(c === 1 ? 0 : 2, c === 2 ? (i + 1) % 4 : i).capabilityId;
      await expect(policy.authorizeContractCalls([call(c, i)], ctx(1, [other]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(c, i)], ctx(42161, [id]))).rejects.toBeDefined();
    }
  });

  it('rejects foreign target, selector, trailing bytes, malformed address padding, and truncated calldata', async () => {
    const good = call(0, 0); const grant = ctx(1, [f(0, 0).capabilityId]);
    await expect(policy.authorizeContractCalls([{ ...good, to: A }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `0xdeadbeef${good.data.slice(10)}` }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], grant)).rejects.toBeDefined();
    const badAddress = `${good.data.slice(0, 10)}${'f'.repeat(24)}${good.data.slice(10 + 64)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...good, data: badAddress }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: good.data.slice(0, -2) as `0x${string}` }], grant)).rejects.toBeDefined();
  });

  it('accepts maxuint financial inputs and arbitrary recipients/owners/accounts/vaults, with payability determined only by ABI', async () => {
    for (const c of [0, 1]) for (let i = 0; i < 6; i++) {
      await expect(policy.authorizeContractCalls([call(c, i)], ctx(1, [f(c, i).capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(c, i), value: '1' }], ctx(1, [f(c, i).capabilityId]))).rejects.toBeDefined();
    }
    for (let i = 0; i < 4; i++) {
      const free = i === 3 ? [B] : [B, vaults[0]];
      await expect(policy.authorizeContractCalls([call(2, i, free)], ctx(1, [f(2, i).capabilityId]))).resolves.toBeDefined();
      await expect(policy.authorizeContractCalls([call(2, i, free, '17')], ctx(1, [f(2, i).capabilityId]))).resolves.toBeDefined();
    }
  });
});
