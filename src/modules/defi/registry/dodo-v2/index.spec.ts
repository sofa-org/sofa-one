import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { functionAbiHash, buildReviewedManifest } from '../defi-manifest';
import { buildDodoV2Registry } from './index';

const target = '0x4CAD0052524648A7Fa2cfE279997b00239295F33';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const pairs = [A, B];
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'dodo-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
describe('DODO V2 registry fixture', () => {
  const fragment = buildDodoV2Registry();
  const fns = fragment.chains[0].contracts[0].functions;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const call = (index: number, args: any[], value?: string) => ({ to: target, value, data: encodeFunctionData({ abi: [fns[index].abi], functionName: fns[index].functionName, args }) });
  it('matches all three inactive source candidates, full ABI hashes and unique selectors', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/dodo.json', 'utf8'));
    const rawFns = source.families[0].chains[0].contracts[0].functions;
    expect(source.sources).toHaveLength(2);
    expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(rawFns).toHaveLength(3); expect(fns).toHaveLength(3);
    rawFns.forEach((raw: any, i: number) => { expect(raw.status).toBe('inactive'); expect(source.sources.some((s: any) => s.sourceId === raw.provenance.sourceRef)).toBe(true); expect(raw.abi).toEqual(fns[i].abi); expect(functionAbiHash({ abi: raw.abi })).toBe(functionAbiHash(fns[i])); });
    expect(new Set(fns.map(f => f.capabilityId)).size).toBe(3);
    expect(new Set(fns.map(f => toFunctionSelector(f.signature))).size).toBe(3);
  });
  it('defaults to deny, authorizes exact per-method grants only, and leaves financial inputs caller-controlled', async () => {
    const args: any[][] = [[A, B, maxUint256, 0n, pairs, maxUint256, true, maxUint256], [B, 0n, pairs, maxUint256, false, maxUint256], [A, maxUint256, 0n, pairs, maxUint256, false, maxUint256]];
    for (let i = 0; i < 3; i++) {
      await expect(policy.authorizeContractCalls([call(i, args[i])], ctx(8453, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(i, args[i])], ctx(8453, [fns[i].capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fns[i].capabilityId }] });
      await expect(policy.authorizeContractCalls([call(i, args[i])], ctx(8453, [fns[(i + 1) % 3].capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });
  it('rejects foreign chain/target/selector, trailing bytes and malformed bool/array calldata', async () => {
    const id = fns[0].capabilityId; const good = call(0, [A, B, 1n, 0n, pairs, 1n, true, 1n]); const grant = ctx(8453, [id]);
    await expect(policy.authorizeContractCalls([good], ctx(42161, [id]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, to: A }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `0xdeadbeef${good.data.slice(10)}` }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], grant)).rejects.toBeDefined();
    const badBool = `${good.data.slice(0, 10 + 6 * 64)}${'0'.repeat(63)}2${good.data.slice(10 + 7 * 64)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...good, data: badBool }], grant)).rejects.toBeDefined();
    const offsetWord = 10 + 4 * 64;
    const badArray = `${good.data.slice(0, offsetWord)}${'0'.repeat(62)}41${good.data.slice(offsetWord + 64)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...good, data: badArray }], grant)).rejects.toBeDefined();
  });
  it('allows value only on the payable ETH-input function', async () => {
    const args: any[][] = [[A, B, 1n, 0n, pairs, 1n, true, 1n], [B, 0n, pairs, 1n, false, 1n], [A, 1n, 0n, pairs, 1n, false, 1n]];
    for (const i of [0, 2]) await expect(policy.authorizeContractCalls([call(i, args[i], '1')], ctx(8453, [fns[i].capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(1, args[1], '17')], ctx(8453, [fns[1].capabilityId]))).resolves.toBeDefined();
  });
});
