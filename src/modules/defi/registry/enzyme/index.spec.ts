import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildEnzymeRegistry, ENZYME_CAPABILITIES } from './index';

const comptroller = '0x3714E016690aC209aB173A2B4b86Aaa1c8f48327';
const vaultProxy = '0x0468AcaBf15f4B933491B5B3C4DcCaacb63f7eF4';
const fundDeployer = '0x4f1c53f096533c04d8157efb6bca3eb22ddc6360';
const recipient = '0x1111111111111111111111111111111111111111';
const assetA = '0x2222222222222222222222222222222222222222';
const assetB = '0x3333333333333333333333333333333333333333';
const max = (1n << 256n) - 1n;
const fragment = buildEnzymeRegistry();
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'enzyme-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: recipient, allowedCapabilityIds: grants });

function argsFor(fn: DefiFunctionPolicy): readonly unknown[] {
  if (fn.functionName === 'buyShares') return [max, max];
  if (fn.functionName === 'redeemSharesInKind') return [recipient, max, [assetA, assetB], [assetB]];
  return [recipient, max, [assetA, assetB], [max, max]];
}
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argsFor(fn) as never }), ...(value === undefined ? {} : { value }) });

describe('Enzyme Ethereum Comptroller fixture', () => {
  it('binds all three inactive source functions to full ABI hashes, IDs and references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/enzyme.json', 'utf8'));
    const family = source.families[0];
    const contract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('enzyme');
    expect(family.familyVersion).toBe('sulu-v4@65ec056b');
    expect(contract).toMatchObject({ chainId: 1, address: comptroller, status: 'inactive', contractName: 'Enzyme Ethereum Comptroller' });
    expect(contract.abiFunctions).toHaveLength(3);
    expect(source.sources).toHaveLength(3);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(ENZYME_CAPABILITIES.map((fn) => [fn.functionName, fn.capabilityId, fn.signature, fn.abi.stateMutability])).toEqual([
      ['buyShares', `enzyme:sulu-v4:1:${comptroller.toLowerCase()}:buy-shares`, 'buyShares(uint256,uint256)', 'nonpayable'],
      ['redeemSharesInKind', `enzyme:sulu-v4:1:${comptroller.toLowerCase()}:redeem-shares-in-kind`, 'redeemSharesInKind(address,uint256,address[],address[])', 'nonpayable'],
      ['redeemSharesForSpecificAssets', `enzyme:sulu-v4:1:${comptroller.toLowerCase()}:redeem-shares-for-specific-assets`, 'redeemSharesForSpecificAssets(address,uint256,address[],uint256[])', 'nonpayable'],
    ]);
    expect(ENZYME_CAPABILITIES[0].abi.outputs).toEqual([{ name: 'sharesReceived_', type: 'uint256', internalType: 'uint256' }]);
    expect(ENZYME_CAPABILITIES[1].abi.outputs).toEqual([
      { name: 'payoutAssets_', type: 'address[]', internalType: 'address[]' },
      { name: 'payoutAmounts_', type: 'uint256[]', internalType: 'uint256[]' },
    ]);
    expect(ENZYME_CAPABILITIES[2].abi.outputs).toEqual([{ name: 'payoutAmounts_', type: 'uint256[]', internalType: 'uint256[]' }]);
    for (const fn of ENZYME_CAPABILITIES) {
      const raw = contract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      const { sourceId, ...abi } = raw;
      expect(abi).toEqual(fn.abi);
      expect(functionAbiHash({ abi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(contract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
    }
    expect(new Set(ENZYME_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(3);
  });

  it('requires each exact grant, accepts maximum uint256 and caller-chosen arrays, rejects empty grants/native value', async () => {
    for (const fn of ENZYME_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 1n)], context([fn.capabilityId]))).rejects.toBeDefined();
    }
  });

  it('isolates each function, chain, comptroller target, and rejects vault/infrastructure targets', async () => {
    for (const fn of ENZYME_CAPABILITIES) {
      for (const otherFn of ENZYME_CAPABILITIES.filter((candidate) => candidate !== fn)) {
        await expect(policy.authorizeContractCalls([call(fn)], context([otherFn.capabilityId]))).rejects.toBeDefined();
      }
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: vaultProxy }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([{ ...call(fn), to: fundDeployer }], context([fn.capabilityId]))).rejects.toBeDefined();
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    }
  });

  it('rejects noncanonical dynamic offsets, address-array padding, trailing bytes and truncation', async () => {
    const dynamicFns = ENZYME_CAPABILITIES.filter((fn) => fn.abi.inputs.some((input) => input.type.endsWith('[]')));
    for (const fn of dynamicFns) {
      const valid = call(fn);
      const firstOffset = Number(BigInt(`0x${valid.data.slice(138, 202)}`));
      const arrayStart = 10 + firstOffset * 2;
      const addressWord = arrayStart + 64;
      const malformedAddressPadding = `${valid.data.slice(0, addressWord)}${'1'.repeat(24)}${valid.data.slice(addressWord + 24)}`;
      const wrongOffset = `${valid.data.slice(0, 138)}${'0'.repeat(62)}20${valid.data.slice(202)}`;
      for (const data of [wrongOffset, malformedAddressPadding, `${valid.data}00`, valid.data.slice(0, -2), `0xdeadbeef${valid.data.slice(10)}`]) {
        await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toBeDefined();
      }
    }
    const staticCall = call(ENZYME_CAPABILITIES[0]);
    await expect(policy.authorizeContractCalls([{ ...staticCall, data: `${staticCall.data}00` }], context([ENZYME_CAPABILITIES[0].capabilityId]))).rejects.toBeDefined();
  });
});
