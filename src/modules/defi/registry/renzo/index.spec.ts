import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildRenzoRegistry } from './index';

const manager = '0x74a09653A083691711cF8215a6ab074BB4e99ef5';
const queue = '0x5efc9D10E42FB517456f4ac41EB5e2eBe42C8918';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'renzo-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });

describe('Renzo ordinary deposit/withdraw fixture', () => {
  const fragment = buildRenzoRegistry(); const fns = fragment.chains.flatMap(c => c.contracts.flatMap(k => k.functions));
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const args: any[][] = [[], [maxUint256], [A, maxUint256], [B, maxUint256, maxUint256], [maxUint256, B], [maxUint256, A]];
  const target = (i: number) => i < 4 ? manager : queue;
  const call = (i: number, value?: string) => ({ to: target(i), value, data: encodeFunctionData({ abi: [fns[i].abi], functionName: fns[i].functionName, args: args[i] }) });

  it('binds six inactive source declarations to exact fixture ABI hashes and selector-derived IDs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/renzo.json', 'utf8'));
    const raw = source.families[0].chains[0].contracts.flatMap((c: any) => c.functions);
    expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(raw).toHaveLength(6); expect(fns).toHaveLength(6);
    raw.forEach((r: any, i: number) => {
      expect(r.status).toBe('inactive'); expect(source.sources.some((s: any) => s.sourceId === r.provenance.sourceRef)).toBe(true);
      expect(r.abi).toEqual(fns[i].abi); expect(functionAbiHash({ abi: r.abi })).toBe(functionAbiHash(fns[i]));
      expect(r.capabilityId).toBe(`renzo:v1:1:${target(i).toLowerCase()}:${toFunctionSelector(r.signature).slice(2)}`);
    });
    expect(new Set(fns.map(f => f.capabilityId)).size).toBe(6);
  });

  it('authorizes each exact grant, separates overloads, and defaults to deny', async () => {
    for (let i = 0; i < 6; i++) {
      await expect(policy.authorizeContractCalls([call(i)], ctx(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(i)], ctx(1, [fns[i].capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fns[i].capabilityId }] });
      await expect(policy.authorizeContractCalls([call(i)], ctx(1, [fns[(i + 1) % 6].capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(i)], ctx(8453, [fns[i].capabilityId]))).rejects.toBeDefined();
    }
  });

  it('rejects wrong target, selector, trailing bytes, and malformed uint canonicality', async () => {
    const good = call(2); const grant = ctx(1, [fns[2].capabilityId]);
    await expect(policy.authorizeContractCalls([{ ...good, to: B }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `0xdeadbeef${good.data.slice(10)}` }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], grant)).rejects.toBeDefined();
    const badAddressPadding = `${good.data.slice(0, 10)}${'f'.repeat(24)}${good.data.slice(34)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...good, data: badAddressPadding }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: good.data.slice(0, -2) as `0x${string}` }], grant)).rejects.toBeDefined();
  });

  it('enforces ABI payability only and accepts arbitrary ABI-valid collateral, amounts, asset-out and user values', async () => {
    for (const i of [0, 1]) await expect(policy.authorizeContractCalls([call(i, '17')], ctx(1, [fns[i].capabilityId]))).resolves.toBeDefined();
    for (const i of [2, 3, 4, 5]) await expect(policy.authorizeContractCalls([call(i, '1')], ctx(1, [fns[i].capabilityId]))).rejects.toBeDefined();
    const anyToken = { to: manager, data: encodeFunctionData({ abi: [fns[2].abi], functionName: 'deposit', args: [B, maxUint256] }) };
    const thirdPartyClaim = { to: queue, data: encodeFunctionData({ abi: [fns[5].abi], functionName: 'claim', args: [maxUint256, B] }) };
    await expect(policy.authorizeContractCalls([anyToken], ctx(1, [fns[2].capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([thirdPartyClaim], ctx(1, [fns[5].capabilityId]))).resolves.toBeDefined();
  });
});
