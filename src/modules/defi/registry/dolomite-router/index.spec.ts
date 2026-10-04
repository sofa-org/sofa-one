import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { functionAbiHash, buildReviewedManifest } from '../defi-manifest';
import { buildDolomiteRouterRegistry } from './index';

const target = '0xf8b2c637A68cF6A17b1DF9F8992EeBeFf63d2dFf';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'dolomite-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: '0x1111111111111111111111111111111111111111', allowedCapabilityIds: grants });
describe('Dolomite deposit/withdraw router fixture', () => {
  const fragment = buildDolomiteRouterRegistry(); const fns = fragment.chains[0].contracts[0].functions;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const args: any[][] = [[1n, 2n, 3n, maxUint256, 1], [1n, 2n, 0], [1n, 2n, 3n, maxUint256, 1], [1n, 2n, 3n, maxUint256, 3], [1n, 2n, maxUint256, 3], [1n, 2n, 3n, maxUint256, 3]];
  const call = (i: number, value?: string) => ({ to: target, value, data: encodeFunctionData({ abi: [fns[i].abi], functionName: fns[i].functionName, args: args[i] }) });
  it('matches all six source ABI candidates and stable selectors/IDs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/dolomite.json', 'utf8')); const raw = source.families[0].chains[0].contracts[0].functions;
    expect(source.sources).toHaveLength(4); expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(raw).toHaveLength(6); expect(fns).toHaveLength(6);
    raw.forEach((r: any, i: number) => { expect(r.status).toBe('inactive'); expect(source.sources.some((s: any) => s.sourceId === r.provenance.sourceRef)).toBe(true); expect(r.abi).toEqual(fns[i].abi); expect(functionAbiHash({ abi: r.abi })).toBe(functionAbiHash(fns[i])); });
    expect(new Set(fns.map(f => f.capabilityId)).size).toBe(6); expect(new Set(fns.map(f => toFunctionSelector(f.signature))).size).toBe(6);
  });
  it('requires exact grants and rejects cross-function and cross-chain authority', async () => {
    for (let i = 0; i < 6; i++) {
      await expect(policy.authorizeContractCalls([call(i)], ctx(42161, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(i)], ctx(42161, [fns[i].capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fns[i].capabilityId }] });
      await expect(policy.authorizeContractCalls([call(i)], ctx(42161, [fns[(i + 1) % 6].capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(i)], ctx(8453, [fns[i].capabilityId]))).rejects.toBeDefined();
    }
  });
  it('accepts the reviewed flag values and caller-controlled maximum values without economic claims', async () => {
    for (const flag of [0, 1]) await expect(policy.authorizeContractCalls([{ to: target, data: encodeFunctionData({ abi: [fns[0].abi], functionName: fns[0].functionName, args: [1n, 2n, 3n, maxUint256, flag] }) }], ctx(42161, [fns[0].capabilityId]))).resolves.toBeDefined();
    for (const flag of [0, 1, 2, 3]) await expect(policy.authorizeContractCalls([{ to: target, data: encodeFunctionData({ abi: [fns[3].abi], functionName: fns[3].functionName, args: [1n, 2n, 3n, maxUint256, flag] }) }], ctx(42161, [fns[3].capabilityId]))).resolves.toBeDefined();
  });
  it('rejects wrong target, selector, trailing bytes and malformed uint8 flag padding', async () => {
    const good = call(0); const grant = ctx(42161, [fns[0].capabilityId]);
    await expect(policy.authorizeContractCalls([{ ...good, to: '0x1111111111111111111111111111111111111111' }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `0xdeadbeef${good.data.slice(10)}` }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], grant)).rejects.toBeDefined();
    const badFlag = `${good.data.slice(0, -64)}${'0'.repeat(62)}0100` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...good, data: badFlag }], grant)).rejects.toBeDefined();
  });
  it('permits native value only for depositPayable (both zero and positive)', async () => {
    for (const i of [0, 2, 3, 4, 5]) await expect(policy.authorizeContractCalls([call(i, '1')], ctx(42161, [fns[i].capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(1)], ctx(42161, [fns[1].capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(1, '17')], ctx(42161, [fns[1].capabilityId]))).resolves.toBeDefined();
  });
});
