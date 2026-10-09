import { readFileSync } from 'node:fs';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { buildIZumiRegistry, IZUMI_CAPABILITIES } from './index';

const swapTarget = '0x2db0AFD0045F3518c77eC6591a542e326Befd3D7';
const liquidityManager = '0x19b683A2F45012318d9B2aE1280d68d3eC54D663';
const miner = '0x1111111111111111111111111111111111111111';
const tokenX = '0x2222222222222222222222222222222222222222';
const tokenY = '0x3333333333333333333333333333333333333333';
const recipient = '0x4444444444444444444444444444444444444444';
const max256 = (1n << 256n) - 1n;
const max128 = (1n << 128n) - 1n;
const max24 = (1n << 24n) - 1n;
const path = `0x${tokenX.slice(2)}000bb8${tokenY.slice(2)}` as `0x${string}`;
const expectedAbiShape: Record<string, { inputs: unknown[]; outputs: readonly (readonly [string, string])[] }> = {
  swapAmount: {
    inputs: [{ name: 'params', type: 'tuple', internalType: 'struct ISwap.SwapAmountParams', components: [['path', 'bytes'], ['recipient', 'address'], ['amount', 'uint128'], ['minAcquired', 'uint256'], ['deadline', 'uint256']].map(([name, type]) => ({ name, type, internalType: type })) }],
    outputs: [['cost', 'uint256'], ['acquire', 'uint256']],
  },
  mint: {
    inputs: [{ name: 'mintParam', type: 'tuple', internalType: 'struct ILiquidityManager.MintParam', components: [['miner', 'address'], ['tokenX', 'address'], ['tokenY', 'address'], ['fee', 'uint24'], ['pl', 'int24'], ['pr', 'int24'], ['xLim', 'uint128'], ['yLim', 'uint128'], ['amountXMin', 'uint128'], ['amountYMin', 'uint128'], ['deadline', 'uint256']].map(([name, type]) => ({ name, type, internalType: type })) }],
    outputs: [['lid', 'uint256'], ['liquidity', 'uint128'], ['amountX', 'uint256'], ['amountY', 'uint256']],
  },
  addLiquidity: {
    inputs: [{ name: 'addLiquidityParam', type: 'tuple', internalType: 'struct ILiquidityManager.AddLiquidityParam', components: [['lid', 'uint256'], ['xLim', 'uint128'], ['yLim', 'uint128'], ['amountXMin', 'uint128'], ['amountYMin', 'uint128'], ['deadline', 'uint256']].map(([name, type]) => ({ name, type, internalType: type })) }],
    outputs: [['liquidityDelta', 'uint128'], ['amountX', 'uint256'], ['amountY', 'uint256']],
  },
  decLiquidity: {
    inputs: [['lid', 'uint256'], ['liquidDelta', 'uint128'], ['amountXMin', 'uint256'], ['amountYMin', 'uint256'], ['deadline', 'uint256']].map(([name, type]) => ({ name, type, internalType: type })),
    outputs: [['amountX', 'uint256'], ['amountY', 'uint256']],
  },
  collect: {
    inputs: [['recipient', 'address'], ['lid', 'uint256'], ['amountXLim', 'uint128'], ['amountYLim', 'uint128']].map(([name, type]) => ({ name, type, internalType: type })),
    outputs: [['amountX', 'uint256'], ['amountY', 'uint256']],
  },
};
const fragment = buildIZumiRegistry();
const contracts = fragment.chains[0].contracts;
const manifest = buildReviewedManifest([fragment]);
const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(fragment.chains, prisma as never, manifest));
const context = (grants: string[] = [], chainId = 1): DefiExecutionContext => ({ userId: 'izumi-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key', executionOwner: recipient, allowedCapabilityIds: grants });
function args(fn: DefiFunctionPolicy): readonly unknown[] {
  switch (fn.functionName) {
    case 'swapAmount': return [[path, recipient, max128, max256, max256]];
    case 'mint': return [[miner, tokenX, tokenY, max24, -8388608, 8388607, max128, max128, max128, max128, max256]];
    case 'addLiquidity': return [[max256, max128, max128, max128, max128, max256]];
    case 'decLiquidity': return [max256, max128, max256, max256, max256];
    case 'collect': return [recipient, max256, max128, max128];
    default: throw new Error(`Unexpected iZUMi method ${fn.functionName}`);
  }
}
const call = (fn: DefiFunctionPolicy, value?: bigint) => ({ to: fn.contract, data: encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args(fn) as never }), ...(value === undefined ? {} : { value }) });

describe('iZUMi Ethereum fixed-selector fixture', () => {
  it('binds all five inactive source declarations to exact fixture ABIs, hashes, source references, and IDs', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/v6/sources/izumi.json', 'utf8'));
    const family = source.families[0];
    const rawContracts = family.contracts;
    const rawFunctions = rawContracts.flatMap((contract: any) => contract.abiFunctions.map((abi: any) => ({ contract, abi })));
    const sourceIds = new Set(source.sources.map((record: any) => record.sourceId));
    expect(family.familyId).toBe('izumi');
    expect(family.familyVersion).toBe('periphery@69d6e509');
    expect(rawContracts.map((contract: any) => contract.address)).toEqual([swapTarget, liquidityManager]);
    expect(rawContracts.every((contract: any) => contract.chainId === 1 && contract.status === 'inactive')).toBe(true);
    expect(source.sources.every((record: any) => Object.keys(record).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
    expect(rawFunctions).toHaveLength(5);
    expect(IZUMI_CAPABILITIES).toHaveLength(5);
    expect(contracts.map((contract) => contract.address)).toEqual([swapTarget, liquidityManager]);
    const expected = [
      ['swapAmount', 'swapAmount((bytes,address,uint128,uint256,uint256))', 'izumi:v1:1:0x2db0afd0045f3518c77ec6591a542e326befd3d7:swap-amount', 'payable'],
      ['mint', 'mint((address,address,address,uint24,int24,int24,uint128,uint128,uint128,uint128,uint256))', 'izumi:v1:1:0x19b683a2f45012318d9b2ae1280d68d3ec54d663:mint', 'payable'],
      ['addLiquidity', 'addLiquidity((uint256,uint128,uint128,uint128,uint128,uint256))', 'izumi:v1:1:0x19b683a2f45012318d9b2ae1280d68d3ec54d663:add-liquidity', 'payable'],
      ['decLiquidity', 'decLiquidity(uint256,uint128,uint256,uint256,uint256)', 'izumi:v1:1:0x19b683a2f45012318d9b2ae1280d68d3ec54d663:dec-liquidity', 'nonpayable'],
      ['collect', 'collect(address,uint256,uint128,uint128)', 'izumi:v1:1:0x19b683a2f45012318d9b2ae1280d68d3ec54d663:collect', 'payable'],
    ] as const;
    expect(IZUMI_CAPABILITIES.map((fn) => [fn.functionName, fn.signature, fn.capabilityId, fn.abi.stateMutability])).toEqual(expected);
    for (const fn of IZUMI_CAPABILITIES) {
      const rawContract = rawContracts.find((contract: any) => contract.address.toLowerCase() === fn.contract.toLowerCase());
      const raw = rawContract.abiFunctions.find((abi: any) => abi.name === fn.functionName);
      expect(raw).toBeDefined();
      const { sourceId, ...rawAbi } = raw;
      expect(rawAbi).toEqual(fn.abi);
      expect(functionAbiHash({ abi: rawAbi })).toBe(functionAbiHash(fn));
      expect(sourceIds.has(sourceId)).toBe(true);
      expect(rawContract.sourceRefs).toContain('izumi-ethereum-deployment-config');
      expect(rawContract.sourceRefs).toContain(sourceId);
      expect(fn.status).toBe('active');
      expect(fn.provenance.status).toBe('verified');
      expect(fn.abi.inputs.map((param) => ({ name: param.name, type: param.type, internalType: param.internalType, ...('components' in param && param.components ? { components: param.components.map((part) => ({ name: part.name, type: part.type, internalType: part.internalType })) } : {}) }))).toEqual(expectedAbiShape[fn.functionName].inputs);
      expect(fn.abi.outputs.map(({ name, type, internalType }) => [name, type, internalType])).toEqual(expectedAbiShape[fn.functionName].outputs.map(([name, type]) => [name, type, type]));
    }
    expect(IZUMI_CAPABILITIES.find((fn) => fn.functionName === 'swapAmount')?.abi.inputs[0]).toEqual({
      name: 'params', type: 'tuple', internalType: 'struct ISwap.SwapAmountParams', components: [
        { name: 'path', type: 'bytes', internalType: 'bytes' },
        { name: 'recipient', type: 'address', internalType: 'address' },
        { name: 'amount', type: 'uint128', internalType: 'uint128' },
        { name: 'minAcquired', type: 'uint256', internalType: 'uint256' },
        { name: 'deadline', type: 'uint256', internalType: 'uint256' },
      ],
    });
    expect(IZUMI_CAPABILITIES.find((fn) => fn.functionName === 'mint')?.abi.inputs[0].internalType).toBe('struct ILiquidityManager.MintParam');
    expect(IZUMI_CAPABILITIES.find((fn) => fn.functionName === 'addLiquidity')?.abi.inputs[0].internalType).toBe('struct ILiquidityManager.AddLiquidityParam');
    expect(new Set(IZUMI_CAPABILITIES.map((fn) => `${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(5);
    expect(path).toMatch(/^0x[0-9a-f]{86}$/);
  });

  it('authorizes all five functions under exact grants; only the four payable methods accept positive value', async () => {
    for (const fn of IZUMI_CAPABILITIES) {
      const id = fn.capabilityId;
      await expect(policy.authorizeContractCalls([call(fn)], context([id]))).resolves.toMatchObject({ matches: [{ capabilityId: id }] });
      await expect(policy.authorizeContractCalls([call(fn)], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      if (fn.abi.stateMutability === 'payable') {
        await expect(policy.authorizeContractCalls([call(fn, 17n)], context([id]))).resolves.toMatchObject({ matches: [{ capabilityId: id }], interactions: [{ value: '17' }] });
      } else {
        await expect(policy.authorizeContractCalls([call(fn, 1n)], context([id]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }
  });

  it('isolates exact function, target, and chain authority without inventing an executor or callback', async () => {
    const swapFn = IZUMI_CAPABILITIES.find((fn) => fn.functionName === 'swapAmount')!;
    const mintFn = IZUMI_CAPABILITIES.find((fn) => fn.functionName === 'mint')!;
    const addFn = IZUMI_CAPABILITIES.find((fn) => fn.functionName === 'addLiquidity')!;
    await expect(policy.authorizeContractCalls([call(mintFn)], context([swapFn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(addFn)], context([mintFn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([{ ...call(swapFn), to: liquidityManager }], context([swapFn.capabilityId]))).rejects.toBeDefined();
    await expect(policy.authorizeContractCalls([call(swapFn)], context([swapFn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_FOUND' } });
    await expect(policy.authorizeContractCalls([{ ...call(swapFn), data: `0xdeadbeef${call(swapFn).data.slice(10)}` }], context([swapFn.capabilityId]))).rejects.toBeDefined();
  });

  it('rejects noncanonical dynamic tuple offsets and bytes padding as well as trailing calldata', async () => {
    const fn = IZUMI_CAPABILITIES.find((item) => item.functionName === 'swapAmount')!;
    const valid = call(fn);
    const badOffset = `${valid.data.slice(0, 10)}${'0'.repeat(62)}40${valid.data.slice(10 + 64)}` as `0x${string}`;
    const badPathPadding = `${valid.data.slice(0, -2)}01` as `0x${string}`;
    const mint = IZUMI_CAPABILITIES.find((item) => item.functionName === 'mint')!;
    const mintCall = call(mint);
    const feeWordStart = 10 + 3 * 64;
    const badUint24Padding = `${mintCall.data.slice(0, feeWordStart)}${'f'.repeat(24)}${mintCall.data.slice(feeWordStart + 24)}` as `0x${string}`;
    for (const data of [badOffset, badPathPadding, `${valid.data}00`, badUint24Padding]) {
      const target = data === badUint24Padding ? mint.contract : fn.contract;
      const granted = data === badUint24Padding ? mint.capabilityId : fn.capabilityId;
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([granted]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});
