import { readFileSync } from 'node:fs';
import { encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildSiloVaultRegistry } from './index';

const vaults = ['0x84D1B853C1F34a01c6120013AC7AC704D5383a8D', '0x5B73fb33c602351664D02ed199847B7A155297B5'];
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'silo-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
describe('Silo WETH/USDC market vault fixture', () => {
  const fragment = buildSiloVaultRegistry(); const contracts = fragment.chains[0].contracts;
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
  const args: any[][] = [[maxUint256, B, 0], [maxUint256, B, 1], [maxUint256, B, A, 1], [maxUint256, B, A, 0], [maxUint256, B, A], [maxUint256, A]];
  const fn = (v: number, i: number) => contracts[v].functions[i];
  const call = (v: number, i: number, values = args[i]) => ({ to: vaults[v], data: encodeFunctionData({ abi: [fn(v, i).abi], functionName: fn(v, i).functionName, args: values }) });

  it('binds all twelve inactive source functions to full fixture ABIs, source records, IDs and unique selectors', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/silo.json', 'utf8'));
    const rawContracts = source.families[0].chains[0].contracts; const allRaw = rawContracts.flatMap((c: any) => c.functions);
    const allFns = contracts.flatMap(c => c.functions);
    expect(rawContracts).toHaveLength(2); expect(allRaw).toHaveLength(12); expect(allFns).toHaveLength(12);
    expect(source.sources.every((r: any) => Object.keys(r).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    allRaw.forEach((r: any, i: number) => {
      expect(r.status).toBe('inactive'); expect(source.sources.some((s: any) => s.sourceId === r.provenance.sourceRef)).toBe(true);
      expect(r.abi).toEqual(allFns[i].abi); expect(functionAbiHash({ abi: r.abi })).toBe(functionAbiHash(allFns[i]));
      expect(r.capabilityId).toBe(`silo-vault:v3-market:42161:${r.contract.toLowerCase()}:${r.functionName}`);
    });
    expect(new Set(allFns.map(f => f.capabilityId)).size).toBe(12);
    expect(new Set(allFns.map(f => `${f.contract.toLowerCase()}:${toFunctionSelector(f.signature)}`)).size).toBe(12);
  });

  it('requires each exact grant and isolates both vault target identities', async () => {
    for (let v = 0; v < 2; v++) for (let i = 0; i < 6; i++) {
      const id = fn(v, i).capabilityId;
      await expect(policy.authorizeContractCalls([call(v, i)], ctx(42161, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(v, i)], ctx(42161, [id]))).resolves.toMatchObject({ matches: [{ capabilityId: id }] });
      await expect(policy.authorizeContractCalls([call(v, i)], ctx(42161, [fn(1 - v, i).capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(v, i)], ctx(1, [id]))).rejects.toBeDefined();
    }
  });

  it('rejects foreign target, selector, trailing bytes, malformed enum padding, and truncated uint calldata', async () => {
    const good = call(0, 0); const grant = ctx(42161, [fn(0, 0).capabilityId]);
    await expect(policy.authorizeContractCalls([{ ...good, to: B }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `0xdeadbeef${good.data.slice(10)}` }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data}00` }], grant)).rejects.toBeDefined();
    const badEnum = `${good.data.slice(0, -64)}${'0'.repeat(62)}0100` as `0x${string}`;
    await expect(policy.authorizeContractCalls([{ ...good, data: badEnum }], grant)).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...good, data: good.data.slice(0, -2) as `0x${string}` }], grant)).rejects.toBeDefined();
  });

  it('accepts maximal financial amounts, arbitrary parties and both protocol enum values without native value', async () => {
    for (let v = 0; v < 2; v++) {
      for (const kind of [0, 1]) {
        for (const i of [0, 1, 2, 3]) {
          const values = [...args[i]]; values[values.length - 1] = kind;
          await expect(policy.authorizeContractCalls([call(v, i, values)], ctx(42161, [fn(v, i).capabilityId]))).resolves.toBeDefined();
        }
      }
      for (const i of [4, 5]) await expect(policy.authorizeContractCalls([call(v, i)], ctx(42161, [fn(v, i).capabilityId]))).resolves.toBeDefined();
      for (let i = 0; i < 6; i++) await expect(policy.authorizeContractCalls([{ ...call(v, i), value: '1' }], ctx(42161, [fn(v, i).capabilityId]))).rejects.toBeDefined();
    }
  });
});
