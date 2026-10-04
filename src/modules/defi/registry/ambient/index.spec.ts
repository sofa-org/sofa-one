import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { functionAbiHash } from '../defi-manifest';
import { executionScopeHash } from '../../execution/scope';
import { buildReviewedManifest } from '../defi-manifest';
import { buildAmbientRegistry } from './index';

const target = '0xAaAaAAAaA24eEeb8d57D431224f73832bC34f688';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const conduit = '0x3333333333333333333333333333333333333333';
const ctx = (chainId: number, grants: string[]): DefiExecutionContext => ({ userId: 'ambient-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: A, allowedCapabilityIds: grants });
const types1 = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'uint128' }, { type: 'uint16' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }] as const;
const types2 = [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }, { type: 'address' }] as const;
const payload1 = () => encodeAbiParameters(types1, [A, B, (1n << 256n) - 1n, true, false, (1n << 128n) - 1n, 65535, (1n << 128n) - 1n, 0n, 255]);
const payload2 = (code: number) => encodeAbiParameters(types2, [code, A, B, (1n << 256n) - 1n, -8388608, 8388607, (1n << 128n) - 1n, 0n, (1n << 128n) - 1n, 255, conduit]);
const rootAbi = { type: 'function', name: 'userCmd', stateMutability: 'payable', inputs: [{ name: 'callpath', type: 'uint16', internalType: 'uint16' }, { name: 'cmd', type: 'bytes', internalType: 'bytes' }], outputs: [{ name: '', type: 'bytes', internalType: 'bytes' }] } as const;
const root = (callpath: number, payload: `0x${string}`, value?: string) => ({ to: target, value, data: encodeFunctionData({ abi: [rootAbi], functionName: 'userCmd', args: [callpath, payload] }) });

describe('Ambient cold-path registry fixture', () => {
  const fragment = buildAmbientRegistry();
  const fn = fragment.chains[0].contracts[0].functions[0];
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const manifest = buildReviewedManifest([fragment]);
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));

  it('binds the source candidate, full ABI, closed scope, target and stable capability identity', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v5/sources/ambient.json', 'utf8'));
    const raw = source.families[0].chains[0].contracts[0].functions[0];
    expect(source.sources.map((record: { sourceId: string }) => record.sourceId)).toContain(raw.provenance.sourceRef);
    expect(raw.status).toBe('inactive');
    expect(raw.executionScope).toEqual(fn.executionScope);
    expect(raw.abi).toEqual(fn.abi);
    expect(functionAbiHash({ abi: raw.abi })).toBe(functionAbiHash(fn));
    expect(executionScopeHash(raw.executionScope)).toBe(executionScopeHash(fn.executionScope!));
    expect(fragment.chains.map((chain) => chain.chainId)).toEqual([1]);
    expect(fragment.chains[0].contracts.map((contract) => contract.address)).toEqual([target]);
    expect(fn.capabilityId).toBe(`ambient:coldpath-v1:1:${target.toLowerCase()}:user-cmd`);
    expect(fn.signature).toBe('userCmd(uint16,bytes)');
    expect(toFunctionSelector(fn.signature)).toBe('0xa15112f9');
    expect(fn.abi).toEqual({ type: 'function', name: 'userCmd', stateMutability: 'payable', inputs: [{ name: 'callpath', type: 'uint16', internalType: 'uint16' }, { name: 'cmd', type: 'bytes', internalType: 'bytes' }], outputs: [{ name: '', type: 'bytes', internalType: 'bytes' }] });
  });

  it('rejects a missing or altered Ambient scope and a nonpayable root declaration', () => {
    const manifestWith = (patch: Partial<DefiFunctionPolicy>) => buildReviewedManifest([{ chains: [{ chainId: 1, status: 'active', contracts: [{ address: target, status: 'active', functions: [{ ...fn, ...patch } as DefiFunctionPolicy] }] }] }]);
    expect(() => manifestWith({ executionScope: undefined })).toThrow();
    expect(() => manifestWith({ executionScope: { kind: 'ambient-coldpath-v1', callpathArgIndex: 1, bytesArgIndex: 1 } as never })).toThrow();
    expect(() => manifestWith({ abi: { ...fn.abi, stateMutability: 'nonpayable' } as DefiFunctionPolicy['abi'] })).toThrow();
  });

  it('authorizes the one canonical root for swap and every one of the twelve LP codes with exact grants', async () => {
    const swap = await policy.authorizeContractCalls([root(1, payload1(), '17')], ctx(1, [fn.capabilityId]));
    expect(swap.matches).toHaveLength(1);
    expect(swap.executionPlan).toHaveLength(1);
    expect(swap.executionPlan[0].path).toEqual([0]);
    expect(swap.executionPlan[0].match.nativeValue).toBe('17');
    for (const code of [1, 2, 3, 4, 11, 12, 21, 22, 31, 32, 41, 42]) {
      await expect(policy.authorizeContractCalls([root(2, payload2(code))], ctx(1, [fn.capabilityId]))).resolves.toMatchObject({ executionPlan: [{ path: [0], match: { capabilityId: fn.capabilityId } }] });
    }
  });

  it('denies ungranted, wrong target/chain/selector, unknown grammar, malformed bytes and recursive wrapper', async () => {
    const grant = ctx(1, [fn.capabilityId]);
    await expect(policy.authorizeContractCalls([root(1, payload1())], ctx(1, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([root(1, payload1())], ctx(10, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...root(1, payload1()), to: A }], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ ...root(1, payload1()), data: `0xdeadbeef${root(1, payload1()).data.slice(10)}` }], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    for (const path of [0, 3, 5]) await expect(policy.authorizeContractCalls([root(path, payload1())], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const validRoot = root(1, payload1());
    const overflowCallpath = `${validRoot.data.slice(0, 10)}${'0'.repeat(59)}10000${validRoot.data.slice(10 + 64)}`;
    await expect(policy.authorizeContractCalls([{ to: target, data: overflowCallpath }], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([root(2, payload2(5))], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ ...root(1, payload1()), data: `${root(1, payload1()).data}00` }], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const good = root(1, payload1());
    const offsetStart = 10 + 64;
    await expect(policy.authorizeContractCalls([{ ...good, data: `${good.data.slice(0, offsetStart)}${'0'.repeat(62)}80${good.data.slice(offsetStart + 64)}` }], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const badBool = `${payload1().slice(0, 2 + 3 * 64)}${'0'.repeat(63)}2${payload1().slice(2 + 4 * 64)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([root(1, badBool)], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const badSignedPadding = `${payload2(1).slice(0, 2 + 4 * 64)}00${payload2(1).slice(2 + 4 * 64 + 2)}` as `0x${string}`;
    await expect(policy.authorizeContractCalls([root(2, badSignedPadding)], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const wrapped = encodeFunctionData({ abi: [rootAbi], functionName: 'userCmd', args: [1, payload1()] });
    await expect(policy.authorizeContractCalls([root(1, wrapped)], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([root(1, payload1(), (1n << 256n).toString())], grant)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('accepts ABI-valid negative ticks, arbitrary conduit and maximal financial parameters', async () => {
    const arbitrary = encodeAbiParameters(types2, [42, '0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555', (1n << 256n) - 1n, -1, -8388608, (1n << 128n) - 1n, 9n, (1n << 128n) - 1n, 3, '0x6666666666666666666666666666666666666666']);
    await expect(policy.authorizeContractCalls([root(2, arbitrary, '1')], ctx(1, [fn.capabilityId]))).resolves.toBeDefined();
  });
});
