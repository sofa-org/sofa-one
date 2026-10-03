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
import { toFunctionSelector } from 'viem';

const mockPrisma = { defiPolicyState: { findUnique: jest.fn() } };
@Global() @Module({ providers: [{ provide: PrismaService, useValue: mockPrisma }], exports: [PrismaService] }) class MockDatabaseModule {}

describe('production DeFi registry assembly', () => {
  it('assembles 108 exact, source-verified function capabilities as active', () => {
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST.capabilities)).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(108);
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(20);
    expect(PRODUCTION_DEFI_CATALOG).toBe(PRODUCTION_DEFI_MANIFEST.chains);
    expect(PRODUCTION_DEFI_CATALOG.map((chain) => chain.chainId)).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.provenance.sourceRef.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(fn.provenance.verifiedAt))).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => Object.isFrozen(fn) && Object.isFrozen(fn.abi) && Object.isFrozen(fn.abi.inputs) && Object.isFrozen(fn.abi.outputs) && Object.isFrozen(fn.provenance))).toBe(true);
    expect(PRODUCTION_DEFI_CATALOG.every((chain) => Object.isFrozen(chain) && Object.isFrozen(chain.contracts) && chain.contracts.every((contract) => Object.isFrozen(contract) && Object.isFrozen(contract.functions)))).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => !PRODUCTION_DEFI_APPROVALS.some((approval) => approval.capabilityId === fn.capabilityId))).toHaveLength(88);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Aave V3')).toHaveLength(28);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Compound III')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Morpho Vault V2')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'uniswap-v3' || fn.protocol === 'uniswap-v3-router02' || fn.protocol === 'pancakeswap-v3')).toHaveLength(12);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'aerodrome')).toHaveLength(7);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'velodrome')).toHaveLength(7);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Lido')).toHaveLength(8);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Morpho Blue')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'pancakeswap-v2')).toHaveLength(10);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Lido' && fn.capabilityId.startsWith('lido-withdrawal-queue:'))).toHaveLength(3);
    expect(PRODUCTION_DEFI_APPROVALS.filter((fn) => fn.protocol === 'Lido')).toHaveLength(2);
    expect(PRODUCTION_DEFI_APPROVALS.every((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toBe(true);
    const baselineIds = [buildDexRegistry(), buildLendingRegistry(), buildVaultRegistry(), buildApprovalFragment()]
      .flatMap((fragment) => fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
    const priorExpansionIds = [buildClassicDexRegistry(), buildStakingRegistry(), buildMorphoBlueRegistry(), buildPancakeV2Registry()]
      .flatMap((fragment) => fragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
    const exitIds = buildStakingExitRegistry().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId)));
    const classicIds = buildClassicDexRegistry().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId)));
    const assembledIds = new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => fn.capabilityId));
    expect(baselineIds).toHaveLength(70);
    expect(baselineIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(classicIds).toHaveLength(14);
    expect(classicIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(priorExpansionIds).toHaveLength(35);
    expect(priorExpansionIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(exitIds).toHaveLength(3);
    expect(exitIds.every((id) => assembledIds.has(id))).toBe(true);
    expect(new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(108);
    expect(PRODUCTION_DEFI_MANIFEST.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('keeps all twenty canonical approvals independently grantable with arbitrary spender and uint256 amounts', () => {
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
