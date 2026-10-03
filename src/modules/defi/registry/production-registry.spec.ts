jest.mock('../../security-events/security-event.module', () => ({ SecurityEventModule: class SecurityEventModule {} }));
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_APPROVALS } from './production-registry';
import { DefiCatalogService } from '../defi-catalog.service';
import { Test } from '@nestjs/testing';
import { DefiModule } from '../defi.module';
import { PrismaService } from '../../../core/database/prisma.service';
import { DefiGrantService } from '../defi-grant.service';
import { DefiPauseService } from '../defi-pause.service';
import { DefiPolicyService } from '../defi-policy.service';
import { Global, Module } from '@nestjs/common';
import { buildDexRegistry } from './dex';
import { buildLendingRegistry } from './lending';
import { buildVaultRegistry } from './vaults';
import { buildApprovalFragment } from './approvals';
import { buildClassicDexRegistry } from './classic-dex';
import { buildStakingRegistry } from './staking';
import { buildMorphoBlueRegistry } from './morpho-blue';
import { buildPancakeV2Registry } from './pancake-v2';
import { buildStakingExitRegistry } from './staking-exit';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { buildSparkLendRegistry } from './spark-lend';
import { buildVenusRegistry } from './venus';
import { buildSushiV2Registry } from './sushi-v2';
import { buildExpansionTokenApprovalRegistry } from './expansion-token-approvals';

const mockPrisma = { defiPolicyState: { findUnique: jest.fn() } };
@Global() @Module({ providers: [{ provide: PrismaService, useValue: mockPrisma }], exports: [PrismaService] }) class MockDatabaseModule {}

describe('production DeFi registry assembly', () => {
  it('assembles 315 exact, source-verified function capabilities as active', () => {
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST.capabilities)).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(315);
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(23);
    expect(PRODUCTION_DEFI_CATALOG).toBe(PRODUCTION_DEFI_MANIFEST.chains);
    expect(PRODUCTION_DEFI_CATALOG.map((chain) => chain.chainId)).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.provenance.sourceRef.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(fn.provenance.verifiedAt))).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => Object.isFrozen(fn) && Object.isFrozen(fn.abi) && Object.isFrozen(fn.abi.inputs) && Object.isFrozen(fn.abi.outputs) && Object.isFrozen(fn.provenance))).toBe(true);
    expect(PRODUCTION_DEFI_CATALOG.every((chain) => Object.isFrozen(chain) && Object.isFrozen(chain.contracts) && chain.contracts.every((contract) => Object.isFrozen(contract) && Object.isFrozen(contract.functions)))).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => !PRODUCTION_DEFI_APPROVALS.some((approval) => approval.capabilityId === fn.capabilityId))).toHaveLength(292);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Aave V3')).toHaveLength(28);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Compound III')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Morpho Vault V2')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'uniswap-v3' || fn.protocol === 'uniswap-v3-router02' || fn.protocol === 'pancakeswap-v3')).toHaveLength(12);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'aerodrome')).toHaveLength(7);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'velodrome')).toHaveLength(7);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Lido')).toHaveLength(8);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Morpho Blue')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'pancakeswap-v2')).toHaveLength(10);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'SparkLend')).toHaveLength(4);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Venus')).toHaveLength(27);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'SushiSwap V2')).toHaveLength(60);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'SushiSwap V2').map((fn) => fn.chainId).filter((id, i, ids) => ids.indexOf(id) === i)).toEqual([1, 10, 56, 137, 8453, 42161]);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Lido' && fn.capabilityId.startsWith('lido-withdrawal-queue:'))).toHaveLength(3);
    expect(PRODUCTION_DEFI_APPROVALS.filter((fn) => fn.protocol === 'Lido')).toHaveLength(2);
    expect(PRODUCTION_DEFI_APPROVALS.every((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toBe(true);
    const baselineIds = [buildDexRegistry(), buildLendingRegistry(), buildVaultRegistry(), buildApprovalFragment()]
      .flatMap((fragment) => fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
    const baselineFunctions = [buildDexRegistry(), buildLendingRegistry(), buildVaultRegistry(), buildApprovalFragment(), buildClassicDexRegistry(), buildStakingRegistry(), buildMorphoBlueRegistry(), buildPancakeV2Registry(), buildStakingExitRegistry()]
      .flatMap((fragment) => fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)));
    const priorExpansionIds = [buildClassicDexRegistry(), buildStakingRegistry(), buildMorphoBlueRegistry(), buildPancakeV2Registry()]
      .flatMap((fragment) => fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
    const exitIds = buildStakingExitRegistry().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId)));
    const classicIds = buildClassicDexRegistry().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId)));
    const assembledIds = new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => fn.capabilityId));
    const newFamilyIds = [buildSparkLendRegistry(), buildVenusRegistry(), buildSushiV2Registry()]
      .flatMap((fragment) => fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
    const newApprovalFunctions = buildExpansionTokenApprovalRegistry().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(baselineIds).toHaveLength(70);
    expect(baselineIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(baselineFunctions).toHaveLength(108);
    for (const baselineFn of baselineFunctions) {
      expect(PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === baselineFn.capabilityId)).toEqual(baselineFn);
    }
    expect(classicIds).toHaveLength(14);
    expect(classicIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(priorExpansionIds).toHaveLength(35);
    expect(priorExpansionIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(exitIds).toHaveLength(3);
    expect(exitIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(newFamilyIds).toHaveLength(91);
    expect(newFamilyIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(newApprovalFunctions).toHaveLength(3);
    expect(newApprovalFunctions.map((fn) => fn.capabilityId)).toEqual([
      'erc20:1:0x6b175474e89094c44da98b954eedeac495271d0f:approve',
      'erc20:56:0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c:approve',
      'erc20:56:0x2170ed0880ac9a755fd29b2688956bd959f933f8:approve',
    ]);
    expect(newApprovalFunctions.every((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toBe(true);
    expect(newApprovalFunctions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}`)).toEqual([
      '1:0x6b175474e89094c44da98b954eedeac495271d0f',
      '56:0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
      '56:0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    ]);
    const baselineApprovalIds = baselineFunctions.filter((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)').map((fn) => fn.capabilityId);
    expect(baselineApprovalIds).toHaveLength(20);
    expect(newApprovalFunctions.every((fn) => !baselineApprovalIds.includes(fn.capabilityId))).toBe(true);
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(23);
    expect(new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => fn.capabilityId)).size).toBe(315);
    expect(new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(315);
    expect(PRODUCTION_DEFI_MANIFEST.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    const sourceFunctions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => /^(?:uniswap-v3-position-manager|balancer-v2-vault|aave-v3|compound-iii|compound-v2)$/.test(fn.protocol ?? ''));
    expect(sourceFunctions).toHaveLength(113);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager')).toHaveLength(35);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'balancer-v2-vault')).toHaveLength(24);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'aave-v3')).toHaveLength(12);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-iii')).toHaveLength(20);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-v2')).toHaveLength(22);
    expect(sourceFunctions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && !fn.capabilityId.startsWith('candidate:'))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager').every((fn) => fn.abi.stateMutability === 'payable')).toBe(true);
    expect(sourceFunctions.find((fn) => fn.protocol === 'compound-v2' && fn.contract.toLowerCase() === '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5' && fn.functionName === 'mint')?.abi.stateMutability).toBe('payable');
    expect(sourceFunctions.filter((fn) => fn.protocol === 'balancer-v2-vault' && fn.functionName === 'exitPool').every((fn) => fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(sourceFunctions.some((fn) => /^(?:approve|permit|setApprovalForAll|transferFrom|safeTransferFrom|multicall)$/.test(fn.functionName))).toBe(false);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager').every((fn) => fn.warnings?.some((warning) => warning.includes('NFT permits')))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'balancer-v2-vault').every((fn) => fn.warnings?.some((warning) => warning.includes('pool IDs and userData')))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-v2').every((fn) => fn.warnings?.some((warning) => warning.includes('uint error-code')))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-v2' && fn.abi.stateMutability === 'payable').every((fn) => fn.warnings?.some((warning) => warning.includes('Native CEther')))).toBe(true);
  });

  it('keeps source-added calls subject to exact capability, chain, target, selector, and ABI matching', async () => {
    const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.protocol === 'aave-v3' && item.functionName === 'supply')!;
    const args = ['0x0000000000000000000000000000000000000001', 1n << 255n, '0x0000000000000000000000000000000000000001', 65535n] as const;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args });
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const context = (chainId: number, allowedCapabilityIds: string[]) => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(fn.chainId, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(fn.chainId, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(10, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ to: '0x0000000000000000000000000000000000000001', data }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00` }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const noncanonical = `${data.slice(0, 10)}ff${data.slice(12)}`;
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: noncanonical }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const payableNpm = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.protocol === 'uniswap-v3-position-manager' && item.chainId === 1 && item.functionName === 'mint')!;
    const payableData = encodeFunctionData({ abi: [payableNpm.abi], functionName: payableNpm.functionName, args: [{ token0: '0x0000000000000000000000000000000000000001', token1: '0x0000000000000000000000000000000000000002', fee: 3000, tickLower: -10, tickUpper: 10, amount0Desired: 1n << 255n, amount1Desired: 1n << 254n, amount0Min: 0n, amount1Min: 0n, recipient: '0x0000000000000000000000000000000000000003', deadline: 1n }] });
    await expect(policy.authorizeContractCalls([{ to: payableNpm.contract, data: payableData, value: '17' }], context(1, [payableNpm.capabilityId]))).resolves.toBeDefined();
  });

  it('keeps all twenty-three canonical approvals independently grantable with arbitrary spender and uint256 amounts', () => {
    const usdt = PRODUCTION_DEFI_APPROVALS.find((fn) => fn.chainId === 1 && fn.contract.toLowerCase() === '0xdac17f958d2ee523a2206206994597c13d831ec7')!;
    expect(usdt.capabilityId).toBe('erc20:1:0xdac17f958d2ee523a2206206994597c13d831ec7:approve');
    expect(usdt.abi.outputs).toEqual([]);
    expect(PRODUCTION_DEFI_APPROVALS.every((fn) => fn.signature === 'approve(address,uint256)' && fn.status === 'active')).toBe(true);
    expect(PRODUCTION_DEFI_APPROVALS.map((fn) => fn.capabilityId)).toEqual(expect.arrayContaining([
      'erc20:1:0xae7ab96520de3a18e5e111b5eaab095312d7fe84:approve',
      'erc20:1:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0:approve',
    ]));
  });

  it('validates the merged catalog at startup without RPC access', () => {
    const service = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, {} as never, PRODUCTION_DEFI_MANIFEST);
    expect(service.chains()).toHaveLength(7);
    expect(service.manifest().manifestHash).toBe(PRODUCTION_DEFI_MANIFEST.manifestHash);
  });

  it('resolves the wired catalog providers with mocked database dependencies', async () => {
    const module = await Test.createTestingModule({ imports: [MockDatabaseModule, DefiModule] })
      .overrideProvider(DefiGrantService).useValue({})
      .overrideProvider(DefiPauseService).useValue({})
      .overrideProvider(DefiPolicyService).useValue({})
      .compile();
    const catalog = module.get(DefiCatalogService);
    expect(catalog.manifest().manifestHash).toBe(PRODUCTION_DEFI_MANIFEST.manifestHash);
    expect(catalog.chains()).toEqual(PRODUCTION_DEFI_CATALOG);
    await module.close();
  });
});
