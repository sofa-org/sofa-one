import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildIntegralSizeRelayerRegistry, INTEGRAL_SIZE_RELAYER_CAPABILITIES } from './index';

const target = '0xd17b3c9784510E33cD5B87b490E79253BcD81e2E';
const tokenIn = '0x1111111111111111111111111111111111111111';
const tokenOut = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const max256 = (1n << 256n) - 1n;
const max32 = (1n << 32n) - 1n;
const fragment = buildIntegralSizeRelayerRegistry();
const contracts = fragment.chains[0].contracts;
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'integral-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: recipient, allowedCapabilityIds: grants });
const params = (fn: DefiFunctionPolicy) => fn.functionName === 'sell'
  ? [tokenIn, tokenOut, max256, max256, true, recipient, max32]
  : [tokenIn, tokenOut, max256, max256, true, recipient, max32];
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({
  to: fn.contract,
  data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [params(fn)] as never }),
  ...(value === undefined ? {} : { value }),
});

describe('Integral SIZE Ethereum relayer fixture', () => {
  it('binds both inactive raw source declarations to exact tuple ABI hashes, return identity, target and source references', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/integral.json', 'utf8'));
    const family = source.families[0];
    const rawContract = family.contracts[0];
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('integral');
    expect(family.familyVersion).toBe('size-relayer@91d8803b');
    expect(rawContract.chainId).toBe(1);
    expect(rawContract.address).toBe(target);
    expect(rawContract.status).toBe('inactive');
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(rawContract.abiFunctions).toHaveLength(2);
    expect(INTEGRAL_SIZE_RELAYER_CAPABILITIES).toHaveLength(2);
    expect(contracts.map((contract) => contract.address)).toEqual([target]);
    expect(INTEGRAL_SIZE_RELAYER_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.capabilityId, fn.abi.stateMutability])).toEqual([
      ['sell', 'sell((address,address,uint256,uint256,bool,address,uint32))', `integral:size-relayer-v1:1:${target.toLowerCase()}:sell`, 'payable'],
      ['buy', 'buy((address,address,uint256,uint256,bool,address,uint32))', `integral:size-relayer-v1:1:${target.toLowerCase()}:buy`, 'payable'],
    ]);
    for (const fn of INTEGRAL_SIZE_RELAYER_CAPABILITIES) {
      const raw = rawContract.abiFunctions.find((entry: any) => entry.name === fn.functionName);
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(rawContract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
      expect(fn.provenance.status).toBe('verified');
      expect(fn.abi.inputs).toEqual([{
        name: fn.functionName === 'sell' ? 'sellParams' : 'buyParams',
        type: 'tuple',
        internalType: `struct ITwapRelayer.${fn.functionName === 'sell' ? 'SellParams' : 'BuyParams'}`,
        components: fn.functionName === 'sell'
          ? [
            { name: 'tokenIn', type: 'address', internalType: 'address' }, { name: 'tokenOut', type: 'address', internalType: 'address' },
            { name: 'amountIn', type: 'uint256', internalType: 'uint256' }, { name: 'amountOutMin', type: 'uint256', internalType: 'uint256' },
            { name: 'wrapUnwrap', type: 'bool', internalType: 'bool' }, { name: 'to', type: 'address', internalType: 'address' },
            { name: 'submitDeadline', type: 'uint32', internalType: 'uint32' },
          ]
          : [
            { name: 'tokenIn', type: 'address', internalType: 'address' }, { name: 'tokenOut', type: 'address', internalType: 'address' },
            { name: 'amountInMax', type: 'uint256', internalType: 'uint256' }, { name: 'amountOut', type: 'uint256', internalType: 'uint256' },
            { name: 'wrapUnwrap', type: 'bool', internalType: 'bool' }, { name: 'to', type: 'address', internalType: 'address' },
            { name: 'submitDeadline', type: 'uint32', internalType: 'uint32' },
          ],
      }]);
      expect(fn.abi.outputs).toEqual([{ name: 'orderId', type: 'uint256', internalType: 'uint256' }]);
    }
    expect(new Set(INTEGRAL_SIZE_RELAYER_CAPABILITIES.map((fn) => toFunctionSelector(fn.signature))).size).toBe(2);
  });

  it('authorizes sell and buy only with their exact grants; payable native value and maximal ABI values remain accepted', async () => {
    for (const fn of INTEGRAL_SIZE_RELAYER_CAPABILITIES) {
      await expect(policy.authorizeContractCalls([call(fn)], context([fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([call(fn, 17n)], context([fn.capabilityId]))).resolves.toMatchObject({
        matches: [{ capabilityId: fn.capabilityId }], interactions: [{ value: '17' }],
      });
    }
  });

  it('isolates sell/buy, rejects wrong target and chain, and excludes unknown selectors', async () => {
    const sell = INTEGRAL_SIZE_RELAYER_CAPABILITIES.find((fn) => fn.functionName === 'sell')!;
    const buy = INTEGRAL_SIZE_RELAYER_CAPABILITIES.find((fn) => fn.functionName === 'buy')!;
    await expect(policy.authorizeContractCalls([call(buy)], context([sell.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(sell)], context([buy.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(sell), to: recipient }], context([sell.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(sell)], context([sell.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...call(sell), data: `0xdeadbeef${call(sell).data.slice(10)}` }], context([sell.capabilityId]))).rejects.toBeDefined();
  });

  it('rejects noncanonical tuple bool/address padding and trailing calldata', async () => {
    const fn = INTEGRAL_SIZE_RELAYER_CAPABILITIES.find((item) => item.functionName === 'sell')!;
    const valid = call(fn);
    const addressPaddingStart = 10;
    const boolWordStart = 10 + 4 * 64;
    const badAddressPadding = `${valid.data.slice(0, addressPaddingStart)}${'f'.repeat(24)}${valid.data.slice(addressPaddingStart + 24)}` as `0x${string}`;
    const badBool = `${valid.data.slice(0, boolWordStart)}${'0'.repeat(63)}2${valid.data.slice(boolWordStart + 64)}` as `0x${string}`;
    for (const data of [badAddressPadding, badBool, `${valid.data}00`]) {
      await expect(policy.authorizeContractCalls([{ ...valid, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});
