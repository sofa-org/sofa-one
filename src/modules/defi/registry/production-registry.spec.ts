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

const mockPrisma = { defiPolicyState: { findUnique: jest.fn() } };
@Global() @Module({ providers: [{ provide: PrismaService, useValue: mockPrisma }], exports: [PrismaService] }) class MockDatabaseModule {}

describe('production DeFi registry assembly', () => {
  it('assembles the 70 exact, source-verified function capabilities as active', () => {
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST)).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(70);
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(18);
    expect(PRODUCTION_DEFI_CATALOG).toBe(PRODUCTION_DEFI_MANIFEST.chains);
    expect(PRODUCTION_DEFI_CATALOG.map((chain) => chain.chainId)).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol !== 'ERC-20')).toHaveLength(52);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Aave V3')).toHaveLength(28);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Compound III')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Morpho Vault V2')).toHaveLength(6);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'uniswap-v3' || fn.protocol === 'uniswap-v3-router02' || fn.protocol === 'pancakeswap-v3')).toHaveLength(12);
    expect(PRODUCTION_DEFI_MANIFEST.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('keeps approvals independently grantable and admits arbitrary spender and uint256 amounts', () => {
    const usdt = PRODUCTION_DEFI_APPROVALS.find((fn) => fn.chainId === 1 && fn.contract.toLowerCase() === '0xdac17f958d2ee523a2206206994597c13d831ec7')!;
    expect(usdt.capabilityId).toBe('erc20:1:0xdac17f958d2ee523a2206206994597c13d831ec7:approve');
    expect(usdt.abi.outputs).toEqual([]);
    expect(PRODUCTION_DEFI_APPROVALS.every((fn) => fn.signature === 'approve(address,uint256)' && fn.status === 'active')).toBe(true);
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
