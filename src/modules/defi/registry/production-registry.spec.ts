jest.mock('../../security-events/security-event.module', () => ({ SecurityEventModule: class SecurityEventModule {} }));
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_APPROVALS, PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS } from './production-registry';
import { DefiCatalogService } from '../defi-catalog.service';
import { Test } from '@nestjs/testing';
import { DefiModule } from '../defi.module';
import { DefiEvidenceService } from '../evidence/defi-evidence.service';
import { PrismaService } from '../../../core/database/prisma.service';
import { DefiGrantService } from '../defi-grant.service';
import { DefiPauseService } from '../defi-pause.service';
import { DefiPolicyService } from '../defi-policy.service';
import { Global, Module } from '@nestjs/common';

const mockPrisma={defiPolicyState:{findUnique:jest.fn()}};
@Global() @Module({providers:[{provide:PrismaService,useValue:mockPrisma}],exports:[PrismaService]}) class MockDatabaseModule {}

describe('production DeFi registry assembly', () => {
  it('wires only the narrowly reviewed prospective three authorities; preserves every other candidate inactive', () => {
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST)).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.length).toBeGreaterThan(0);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(70);
    expect(PRODUCTION_DEFI_APPROVALS.length).toBeGreaterThan(0);
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(18);
    const activeIds=PRODUCTION_DEFI_MANIFEST.capabilities.filter(fn=>fn.status==='active').map(fn=>fn.capabilityId).sort();
    expect(activeIds).toEqual([...PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS].sort());
    expect(PRODUCTION_DEFI_CATALOG).toBe(PRODUCTION_DEFI_MANIFEST.chains);
    expect(PRODUCTION_DEFI_CATALOG.filter(c=>c.status==='active')).toHaveLength(1);
    expect(PRODUCTION_DEFI_CATALOG.find(c=>c.chainId===1)?.contracts.filter(c=>c.status==='active').flatMap(c=>c.functions.map(f=>f.capabilityId)).sort()).toEqual(activeIds);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter(fn=>!PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS.includes(fn.capabilityId)).every(fn=>fn.status==='inactive')).toBe(true);
    expect(PRODUCTION_DEFI_CATALOG.filter(c=>c.chainId!==1).every(c=>c.status==='inactive')).toBe(true);
    const keys=new Set<string>();
    for(const fn of PRODUCTION_DEFI_APPROVALS){
      expect(fn.functionName).toBe('approve');
      expect(fn.approval?.spenderRefs?.length).toBeGreaterThan(0);
      const key=`${fn.chainId}:${fn.contract.toLowerCase()}`;expect(keys.has(key)).toBe(false);keys.add(key);
    }
    const ethUsdc=PRODUCTION_DEFI_APPROVALS.find(fn=>fn.chainId===1&&fn.contract.toLowerCase()==='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')!;
    expect(ethUsdc.capabilityId).toBe('erc20:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:approve');
    expect(ethUsdc.approval?.spenderRefs?.map(ref=>PRODUCTION_DEFI_MANIFEST.deployments.find(d=>d.ref===ref)?.address)).toEqual(['0xE592427A0AEce92De3Edee1F18E0157C05861564']);
    const ctx={userId:'u',apiKeyId:'k',walletId:'w',chainId:1,executionMode:'user_operation',executionOwner:'0x1111111111111111111111111111111111111111',allowedCapabilityIds:[]};
    expect(ethUsdc.validate([ethUsdc.approval!.spenderRefs!.map(ref=>PRODUCTION_DEFI_MANIFEST.deployments.find(d=>d.ref===ref)!.address)[0],0n],ctx)).toBe(true);
    expect(ethUsdc.validate(['0x1111111111111111111111111111111111111111',1n],ctx)).toBe(false);
    expect(ethUsdc.validate([ethUsdc.contract,1000_000_000n],ctx)).toBe(false);
  });

  it('validates merged catalog definitions at startup without requiring RPC access', () => {
    const service=new DefiCatalogService(PRODUCTION_DEFI_CATALOG,{ } as never,PRODUCTION_DEFI_MANIFEST);
    expect(service.chains()).toHaveLength(PRODUCTION_DEFI_CATALOG.length);
    expect(service.manifest().manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('resolves the wired catalog and evidence providers with mocked config/database dependencies', async () => {
    const module=await Test.createTestingModule({imports:[MockDatabaseModule,DefiModule]})
      .overrideProvider(DefiGrantService).useValue({})
      .overrideProvider(DefiPauseService).useValue({})
      .overrideProvider(DefiPolicyService).useValue({})
      .compile();
    const catalog=module.get(DefiCatalogService);
    expect(catalog.manifest().manifestHash).toBe(PRODUCTION_DEFI_MANIFEST.manifestHash);
    expect(catalog.chains().map(c=>({chainId:c.chainId,status:c.status,activeIds:c.contracts.flatMap(k=>k.functions.filter(f=>f.status==='active').map(f=>f.capabilityId)).sort()}))).toEqual(PRODUCTION_DEFI_CATALOG.map(c=>({chainId:c.chainId,status:c.status,activeIds:c.contracts.flatMap(k=>k.functions.filter(f=>f.status==='active').map(f=>f.capabilityId)).sort()})));
    expect(module.get(DefiEvidenceService)).toBeDefined();
    await module.close();
  });
});
