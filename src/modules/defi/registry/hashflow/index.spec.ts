import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildHashflowRegistry, HASHFLOW_CAPABILITIES } from './index';

const target = '0x55084eE0fEf03f14a305cd24286359A35D735151';
const otherTarget = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const max = (1n << 256n) - 1n;
const txid = `0x${'ab'.repeat(32)}` as const;
const fragment = buildHashflowRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'hashflow-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: other, allowedCapabilityIds: grants });

function quoteFor(fn: DefiFunctionPolicy): readonly unknown[] {
  if (fn.functionName === 'tradeRFQT') {
    return [other, otherTarget, other, otherTarget, otherTarget, other, max, max, max, max, max, txid, '0x1234'];
  }
  return [other, otherTarget, other, otherTarget, other, max, max, max, txid, '0x1234', '0xabcd'];
}
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [quoteFor(fn)] as never }),
  ...(value === undefined ? {} : { value }),
});

describe('Hashflow Ethereum RFQ router fixture', () => {
  it('binds both inactive source declarations to exact tuple ABI hashes, signatures, IDs and refs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/hashflow.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('hashflow');
    expect(family.familyVersion).toBe('rfq-v1@e41cfaad');
    expect(contract).toMatchObject({ chainId: 1, address: target, status: 'inactive', contractName: 'Hashflow Ethereum Router' });
    expect(contract.abiFunctions).toHaveLength(2);
    expect(source.sources).toHaveLength(2);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(HASHFLOW_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.abi.stateMutability, fn.abi.outputs])).toEqual([
      ['tradeRFQT', 'tradeRFQT((address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,bytes32,bytes))', 'payable', []],
      ['tradeRFQM', 'tradeRFQM((address,address,address,address,address,uint256,uint256,uint256,bytes32,bytes,bytes))', 'nonpayable', []],
    ]);
    expect(HASHFLOW_CAPABILITIES.map((fn) => fn.capabilityId)).toEqual([
      `hashflow:rfq-v1:1:${target.toLowerCase()}:trade-rfqt`,
      `hashflow:rfq-v1:1:${target.toLowerCase()}:trade-rfqm`,
    ]);
    for (const fn of HASHFLOW_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(HASHFLOW_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(2);
  });

  it('requires exact grants, permits RFQT native value and denies RFQM value', async () => {
    const rfqt = HASHFLOW_CAPABILITIES.find((fn) => fn.functionName === 'tradeRFQT')!;
    const rfqm = HASHFLOW_CAPABILITIES.find((fn) => fn.functionName === 'tradeRFQM')!;
    await expect(policy.authorizeContractCalls([call(rfqt, 17n)], context([rfqt.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: rfqt.capabilityId }], interactions: [{ value: '17' }] });
    await expect(policy.authorizeContractCalls([call(rfqt, 17n)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call(rfqm)], context([rfqm.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(rfqm)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([call(rfqm, 1n)], context([rfqm.capabilityId]))).rejects.toBeDefined();
  });

  it('isolates function, chain, target, and selector grants while allowing arbitrary quote counterparties and max amounts', async () => {
    const [rfqt, rfqm] = HASHFLOW_CAPABILITIES;
    await expect(policy.authorizeContractCalls([call(rfqt)], context([rfqm.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(rfqm)], context([rfqt.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(rfqt), to: otherTarget }], context([rfqt.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(rfqt)], context([rfqt.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([call(rfqt)], context([rfqt.capabilityId]))).resolves.toBeDefined();
    await expect(policy.authorizeContractCalls([call(rfqm)], context([rfqm.capabilityId]))).resolves.toBeDefined();
  });

  it('rejects noncanonical nested offsets, tuple address/bytes padding, trailing and truncated calldata', async () => {
    for (const fn of HASHFLOW_CAPABILITIES) {
      const valid = call(fn);
      const malformedAddress = `${valid.data.slice(0, 74)}${'1'.repeat(24)}${valid.data.slice(98)}`;
      const wrongTupleOffset = `${valid.data.slice(0, 10)}${'0'.repeat(62)}40${valid.data.slice(74)}`;
      const malformedBytesPadding = `${valid.data.slice(0, -1)}1`;
      for (const data of [
        `0xdeadbeef${valid.data.slice(10)}`,
        `${valid.data}00`,
        valid.data.slice(0, -2),
        malformedAddress,
        wrongTupleOffset,
        malformedBytesPadding,
      ]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
  });
});
