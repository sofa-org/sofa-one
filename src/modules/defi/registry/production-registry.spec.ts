jest.mock('../../security-events/security-event.module', () => ({ SecurityEventModule: class SecurityEventModule {} }));
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_APPROVALS } from './production-registry';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';
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
import { encodeAbiParameters, encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';
import { buildSparkLendRegistry } from './spark-lend';
import { buildVenusRegistry } from './venus';
import { buildSushiV2Registry } from './sushi-v2';
import { buildExpansionTokenApprovalRegistry } from './expansion-token-approvals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReviewedManifest, functionAbiHash } from './defi-manifest';
import { validateCatalogDocument } from '../catalog-tooling/catalog-generator';
import { V6_SOURCE_IDENTITIES } from '../catalog-tooling/v6-identities';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from '../execution/enso-identity';
import { executionScopeHash } from '../execution/scope';
import { V9_SDAI_BINDINGS } from '../catalog-tooling/v9-identities';

const mockPrisma = { defiPolicyState: { findUnique: jest.fn() } };
@Global() @Module({ providers: [{ provide: PrismaService, useValue: mockPrisma }], exports: [PrismaService] }) class MockDatabaseModule {}

describe('production DeFi registry assembly', () => {
  it('assembles the selected catalog as exact, source-verified function capabilities', () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    const byCapabilityId = (a: { capabilityId: string }, b: { capabilityId: string }) => a.capabilityId.localeCompare(b.capabilityId);
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_DEFI_MANIFEST.capabilities)).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    expect([...PRODUCTION_DEFI_MANIFEST.capabilities].sort(byCapabilityId)).toEqual([...expected.capabilities].sort(byCapabilityId));
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(expected.approvals);
    expect(PRODUCTION_DEFI_CATALOG).toBe(PRODUCTION_DEFI_MANIFEST.chains);
    expect(PRODUCTION_DEFI_CATALOG.map((chain) => chain.chainId)).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => fn.provenance.sourceRef.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(fn.provenance.verifiedAt))).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.every((fn) => Object.isFrozen(fn) && Object.isFrozen(fn.abi) && Object.isFrozen(fn.abi.inputs) && Object.isFrozen(fn.abi.outputs) && Object.isFrozen(fn.provenance))).toBe(true);
    expect(PRODUCTION_DEFI_CATALOG.every((chain) => Object.isFrozen(chain) && Object.isFrozen(chain.contracts) && chain.contracts.every((contract) => Object.isFrozen(contract) && Object.isFrozen(contract.functions)))).toBe(true);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => !PRODUCTION_DEFI_APPROVALS.some((approval) => approval.capabilityId === fn.capabilityId))).toHaveLength(expected.actions);
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
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(expected.approvals);
    expect(new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => fn.capabilityId)).size).toBe(expected.definitions);
    expect(new Set(PRODUCTION_DEFI_MANIFEST.capabilities.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`)).size).toBe(expected.definitions);
    const v9Functions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => V9_SDAI_BINDINGS.some((binding) => binding.capabilityId === fn.capabilityId));
    expect(v9Functions).toHaveLength(4);
    expect(v9Functions.map((fn) => fn.capabilityId).sort()).toEqual(V9_SDAI_BINDINGS.map((binding) => binding.capabilityId).sort());
    for (const binding of V9_SDAI_BINDINGS) {
      const fn = v9Functions.find((candidate) => candidate.capabilityId === binding.capabilityId)!;
      expect(fn).toMatchObject({ chainId: 1, contract: '0x83f20f44975d03b1b09e64809b757c47f942beea', functionName: binding.functionName, signature: binding.signature, status: 'active', provenance: { status: 'verified' } });
      expect(toFunctionSelector(fn.signature)).toBe(binding.selector);
      expect(functionAbiHash(fn)).toBe(binding.abiHash);
      expect(fn.executionScope).toBeUndefined();
    }
    const frozenV8 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v8/catalog.json'), 'utf8')));
    const v8Functions = buildReviewedManifest([frozenV8]).capabilities;
    expect(v8Functions).toHaveLength(669);
    for (const prior of v8Functions) expect(PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === prior.capabilityId)).toEqual(prior);
    const pinnedV9 = buildReviewedManifest([validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v9/catalog.json'), 'utf8')))]).capabilities;
    for (const prior of pinnedV9) expect(PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === prior.capabilityId)).toEqual(prior);
    expect(pinnedV9.filter((fn) => fn.protocol === 'aave-v3')).toHaveLength(12);
    expect(PRODUCTION_DEFI_MANIFEST.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    const isSourceFunction = (fn: { protocol?: string }) => /^(?:uniswap-v3-position-manager|balancer-v2-vault|aave-v3|compound-iii|compound-v2|curve-3pool-stableswap|pancakeswap-v3-position-manager|yearn-tokenized-strategy)$/.test(fn.protocol ?? '');
    const sourceFunctions = PRODUCTION_DEFI_MANIFEST.capabilities.filter(isSourceFunction);
    expect(sourceFunctions).toHaveLength(expected.capabilities.filter(isSourceFunction).length);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager')).toHaveLength(63);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'balancer-v2-vault')).toHaveLength(24);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'aave-v3')).toHaveLength(expected.capabilities.filter((fn) => fn.protocol === 'aave-v3').length);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-iii')).toHaveLength(expected.capabilities.filter((fn) => fn.protocol === 'compound-iii').length);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-v2')).toHaveLength(22);
    const curve = sourceFunctions.filter((fn) => fn.protocol === 'curve-3pool-stableswap');
    const pancakeswap = sourceFunctions.filter((fn) => fn.protocol === 'pancakeswap-v3-position-manager');
    const yearn = sourceFunctions.filter((fn) => fn.protocol === 'yearn-tokenized-strategy');
    expect(curve).toHaveLength(4);
    expect(curve.every((fn) => fn.chainId === 1 && fn.contract.toLowerCase() === '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7' && fn.abi.stateMutability === 'nonpayable' && fn.abi.outputs.length === 0)).toBe(true);
    expect(pancakeswap).toHaveLength(9);
    expect(pancakeswap.every((fn) => fn.chainId === 56 && fn.contract.toLowerCase() === '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364' && fn.abi.stateMutability === 'payable')).toBe(true);
    expect(yearn).toHaveLength(6);
    expect(yearn.every((fn) => fn.chainId === 1 && fn.contract.toLowerCase() === '0x074134a2784f4f66b6ced6f68849382990ff3215' && fn.abi.stateMutability === 'nonpayable')).toBe(true);
    for (const fn of yearn) expect(fn.capabilityId).toMatch(new RegExp(`:${toFunctionSelector(fn.signature).slice(2)}$`));
    expect(sourceFunctions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && !fn.capabilityId.startsWith('candidate:'))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager').every((fn) => fn.abi.stateMutability === 'payable')).toBe(true);
    expect(sourceFunctions.find((fn) => fn.protocol === 'compound-v2' && fn.contract.toLowerCase() === '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5' && fn.functionName === 'mint')?.abi.stateMutability).toBe('payable');
    expect(sourceFunctions.filter((fn) => fn.protocol === 'balancer-v2-vault' && fn.functionName === 'exitPool').every((fn) => fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(sourceFunctions.some((fn) => /^(?:approve|permit|setApprovalForAll|transferFrom|safeTransferFrom)$/.test(fn.functionName))).toBe(false);
    const npmWrappers = sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager' && fn.signature === 'multicall(bytes[])');
    expect(npmWrappers).toHaveLength(7);
    expect(npmWrappers.every((fn) => fn.executionScope?.kind === 'same-target-multicall-v1' && fn.executionScope.allowedChildren.length === 8)).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager').every((fn) => fn.warnings?.some((warning) => warning.includes('NFT permits')))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'balancer-v2-vault').every((fn) => fn.warnings?.some((warning) => warning.includes('pool IDs and userData')))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-v2').every((fn) => fn.warnings?.some((warning) => warning.includes('uint error-code')))).toBe(true);
    expect(sourceFunctions.filter((fn) => fn.protocol === 'compound-v2' && fn.abi.stateMutability === 'payable').every((fn) => fn.warnings?.some((warning) => warning.includes('Native CEther')))).toBe(true);
    const newNpmFunctions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'uniswap-v3-position-manager' && ['multicall', 'refundETH', 'unwrapWETH9', 'sweepToken'].includes(fn.functionName));
    const newMorphoFunctions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'morpho-blue');
    expect(newNpmFunctions).toHaveLength(28);
    expect(newMorphoFunctions).toHaveLength(6);
    expect([...newNpmFunctions, ...newMorphoFunctions]).toHaveLength(34);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.executionScope)).toHaveLength(expected.scopes);
    expect(newMorphoFunctions.every((fn) => fn.executionScope?.kind === 'empty-callback-data-v1')).toBe(true);
    const pancakeWrapper = pancakeswap.find((fn) => fn.signature === 'multicall(bytes[])')!;
    expect(pancakeWrapper.executionScope?.kind).toBe('same-target-multicall-v1');
    if (pancakeWrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Expected Pancake bounded multicall scope');
    expect(pancakeWrapper.executionScope.allowedChildren).toHaveLength(8);
    expect(pancakeWrapper.executionScope.allowedChildren.every((child) => pancakeswap.some((fn) => fn.capabilityId === child.capabilityId && fn.signature === child.signature))).toBe(true);
    const frozenV3 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v3/catalog.json'), 'utf8')));
    const oldCapabilities = buildReviewedManifest([frozenV3]).capabilities;
    expect(oldCapabilities).toHaveLength(349);
    for (const oldFn of oldCapabilities) expect(PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === oldFn.capabilityId)).toEqual(oldFn);
    const frozenV5 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v5/catalog.json'), 'utf8')));
    const v5Capabilities = buildReviewedManifest([frozenV5]).capabilities;
    expect(v5Capabilities).toHaveLength(506);
    for (const oldFn of v5Capabilities) expect(PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === oldFn.capabilityId)).toEqual(oldFn);
    const v6Capabilities = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => V6_SOURCE_IDENTITIES.some((identity) => identity.capabilityId === fn.capabilityId));
    expect(v6Capabilities).toHaveLength(134);
    expect(v6Capabilities.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(v6Capabilities.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(0);
    const v7Catalog = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v7/catalog.json'), 'utf8')));
    const v7Manifest = buildReviewedManifest([v7Catalog]);
    expect(v7Manifest.capabilities).toHaveLength(668);
    expect(v7Manifest.capabilities.filter((fn) => fn.executionScope)).toHaveLength(15);
    for (const fn of v7Manifest.capabilities) expect(PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === fn.capabilityId)).toEqual(fn);
    const ensoRoot = PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId)!;
    expect(ensoRoot).toMatchObject({
      status: 'active', chainId: 1, contract: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract,
      functionName: 'routeSingle', signature: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.signature,
      abiHash: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.abiHash,
    });
    expect(toFunctionSelector(ensoRoot.signature)).toBe(ENSO_STATIC_WEIROLL_ROOT_IDENTITY.selector);
    expect(ensoRoot.executionScope && executionScopeHash(ensoRoot.executionScope)).toBe('0xf55170b87634460f24a5f4ced30d21b134bf950327078b5f31e0bfe2074959e5');
    if (ensoRoot.executionScope?.kind !== 'enso-static-weiroll-v1') throw new Error('Production Enso root must have its exact mandatory scope');
    expect(ensoRoot.executionScope.allowedChildren).toEqual(ENSO_STATIC_WEIROLL_CHILD_IDENTITIES);
    for (const child of ENSO_STATIC_WEIROLL_CHILD_IDENTITIES) {
      const resolved = PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === child.capabilityId);
      expect(resolved?.status).toBe('active');
      expect(resolved?.signature).toBe(child.signature);
      expect(resolved?.contract.toLowerCase()).toBe(child.contract.toLowerCase());
      expect(resolved && functionAbiHash(resolved)).toBe(child.abiHash);
      expect(resolved?.executionScope).toBeUndefined();
    }
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

  it('authorizes each of the 19 v4 source additions only under its exact grant and fixed ABI/scope', async () => {
    const v3 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v3/catalog.json'), 'utf8')));
    const v4 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v4/catalog.json'), 'utf8')));
    const priorIds = new Set(buildReviewedManifest([v3]).capabilities.map((fn) => fn.capabilityId));
    const v4Ids = new Set(buildReviewedManifest([v4]).capabilities.map((fn) => fn.capabilityId));
    const additions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => v4Ids.has(fn.capabilityId) && !priorIds.has(fn.capabilityId));
    expect(additions).toHaveLength(19);
    const curve = additions.filter((fn) => fn.protocol === 'curve-3pool-stableswap');
    const pancake = additions.filter((fn) => fn.protocol === 'pancakeswap-v3-position-manager');
    const yearn = additions.filter((fn) => fn.protocol === 'yearn-tokenized-strategy');
    expect([curve.length, pancake.length, yearn.length]).toEqual([4, 9, 6]);

    type AbiParameter = { type: string; name?: string; components?: readonly AbiParameter[] };
    const address = '0x0000000000000000000000000000000000000001';
    const argValue = (parameter: AbiParameter): unknown => {
      const array = parameter.type.match(/^(.*)\[(\d*)\]$/);
      if (array) return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () => argValue({ ...parameter, type: array[1] } as AbiParameter));
      if (parameter.type === 'tuple') return Object.fromEntries((parameter.components ?? []).map((component, index) => [component.name || String(index), argValue(component)]));
      if (parameter.type === 'address') return address;
      if (parameter.type === 'bool') return true;
      if (parameter.type === 'bytes' || parameter.type.startsWith('bytes')) return '0x';
      if (parameter.type.startsWith('int')) return -1n;
      if (parameter.type.startsWith('uint')) return 17n;
      throw new Error(`Unsupported source ABI test parameter ${parameter.type}`);
    };
    const encode = (fn: (typeof additions)[number], overrides?: readonly unknown[]) => encodeFunctionData({
      abi: [fn.abi], functionName: fn.functionName, args: (overrides ?? (fn.abi.inputs as readonly AbiParameter[]).map(argValue)) as never,
    });
    const scopedWrapper = pancake.find((fn) => fn.signature === 'multicall(bytes[])')!;
    if (scopedWrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Pancake wrapper lacks its finite scope');
    const scope = scopedWrapper.executionScope;
    const firstScopedChild = pancake.find((fn) => fn.capabilityId === scope.allowedChildren[0].capabilityId)!;
    const wrapperRootData = encode(scopedWrapper, [[encode(firstScopedChild)]]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const context = (chainId: number, allowedCapabilityIds: string[]) => ({
      userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId,
      executionMode: 'session_key' as const, executionOwner: address, allowedCapabilityIds,
    });

    for (const fn of additions) {
      const isWrapper = fn === scopedWrapper;
      const data = isWrapper ? wrapperRootData : encode(fn);
      const value = fn.abi.stateMutability === 'payable' ? '17' : undefined;
      const grants = isWrapper ? [fn.capabilityId, firstScopedChild.capabilityId] : [fn.capabilityId];
      const exact = await policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, grants)).catch((error: unknown) => {
        throw new Error(`${fn.protocol} ${fn.signature} exact grant denied: ${JSON.stringify((error as { audit?: unknown }).audit)}`);
      });
      expect(exact.matches).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityId: fn.capabilityId })]));
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId === 1 ? 56 : 1, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: address, data, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00`, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (fn.abi.stateMutability !== 'payable') {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, [fn.capabilityId])))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }

    const curveExchange = curve.find((fn) => fn.functionName === 'exchange')!;
    const curveArgs = [0n, -1n, 0n, 0n] as const;
    await expect(policy.authorizeContractCalls([{ to: curveExchange.contract, data: encode(curveExchange, curveArgs) }], context(1, [curveExchange.capabilityId])))
      .resolves.toMatchObject({ matches: [{ capabilityId: curveExchange.capabilityId }] });
    const curveAdd = curve.find((fn) => fn.functionName === 'add_liquidity')!;
    const malformedFixedArray = `${encode(curveAdd).slice(0, 10)}${encode(curveAdd).slice(10, -64)}`;
    await expect(policy.authorizeContractCalls([{ to: curveAdd.contract, data: malformedFixedArray }], context(1, [curveAdd.capabilityId])))
      .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });

    const withdraw3 = yearn.find((fn) => fn.signature === 'withdraw(uint256,address,address)')!;
    const withdraw4 = yearn.find((fn) => fn.signature === 'withdraw(uint256,address,address,uint256)')!;
    const redeem3 = yearn.find((fn) => fn.signature === 'redeem(uint256,address,address)')!;
    const redeem4 = yearn.find((fn) => fn.signature === 'redeem(uint256,address,address,uint256)')!;
    for (const [threeArg, fourArg] of [[withdraw3, withdraw4], [redeem3, redeem4]]) {
      expect(toFunctionSelector(threeArg.signature)).not.toBe(toFunctionSelector(fourArg.signature));
      await expect(policy.authorizeContractCalls([{ to: fourArg.contract, data: encode(fourArg) }], context(1, [threeArg.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const maxLossArg = fourArg.abi.inputs.at(-1)!;
      const fourArgs = (fourArg.abi.inputs as readonly AbiParameter[]).map(argValue);
      fourArgs[fourArgs.length - 1] = (1n << 256n) - 1n;
      expect(maxLossArg.type).toBe('uint256');
      await expect(policy.authorizeContractCalls([{ to: fourArg.contract, data: encode(fourArg, fourArgs) }], context(1, [fourArg.capabilityId])))
        .resolves.toMatchObject({ matches: [{ capabilityId: fourArg.capabilityId }] });
    }
    const mint = yearn.find((fn) => fn.functionName === 'mint')!;
    const mintArgs = [ (1n << 256n) - 1n, '0x0000000000000000000000000000000000000002' ] as const;
    await expect(policy.authorizeContractCalls([{ to: mint.contract, data: encode(mint, mintArgs) }], context(1, [mint.capabilityId])))
      .resolves.toMatchObject({ matches: [{ capabilityId: mint.capabilityId }] });

    const wrapper = pancake.find((fn) => fn.signature === 'multicall(bytes[])')!;
    if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Pancake wrapper lacks its finite scope');
    expect(wrapper.executionScope.allowedChildren).toHaveLength(8);
    const childFns = wrapper.executionScope.allowedChildren.map((binding) => {
      const child = pancake.find((fn) => fn.capabilityId === binding.capabilityId && fn.signature === binding.signature);
      if (!child) throw new Error(`Pancake child binding missing: ${binding.capabilityId}`);
      return child;
    });
    const childData = childFns.map((fn) => encode(fn));
    const wrapperData = encode(wrapper, [childData]);
    const allIds = [wrapper.capabilityId, ...childFns.map((fn) => fn.capabilityId)];
    const fullContext = context(56, allIds);
    const approved = await policy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], fullContext);
    expect(approved.matches.map((match) => match.capabilityId)).toEqual([wrapper.capabilityId]);
    expect(approved.executionPlan.map((node) => node.path)).toEqual([[0], ...childFns.map((_, index) => [0, index])]);
    expect(approved.executionPlan.slice(1).map((node) => node.match.capabilityId)).toEqual(childFns.map((fn) => fn.capabilityId));
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], context(56, [wrapper.capabilityId])))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], context(56, allIds.filter((id) => id !== childFns[3].capabilityId))))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const elevenChildData = encode(wrapper, [Array.from({ length: 11 }, (_, index) => encode(childFns[index % childFns.length]))]);
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: elevenChildData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const pausedPrisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [`capability:${childFns[0].capabilityId}`] }) } };
    const pausedPolicy = new DefiPolicyService(pausedPrisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, pausedPrisma as never, PRODUCTION_DEFI_MANIFEST));
    await expect(pausedPolicy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    const recursiveData = encode(wrapper, [[wrapperData]]);
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: recursiveData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    const otherNpm = PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.protocol === 'uniswap-v3-position-manager' && fn.chainId === 56 && fn.signature === wrapper.signature)!;
    await expect(policy.authorizeContractCalls([{ to: otherNpm.contract, data: wrapperData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('authorizes all 138 exact v5 additions through the assembled catalog and policy', async () => {
    const v4 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v4/catalog.json'), 'utf8')));
    const v5 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v5/catalog.json'), 'utf8')));
    const v4Ids = new Set(buildReviewedManifest([v4]).capabilities.map((fn) => fn.capabilityId));
    const additions = buildReviewedManifest([v5]).capabilities.filter((fn) => !v4Ids.has(fn.capabilityId));
    expect(additions).toHaveLength(138);
    expect(additions.some((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toBe(false);
    expect(PRODUCTION_DEFI_APPROVALS).toHaveLength(loadCurrentProductionExpectations(process.cwd()).approvals);

    type Param = { type: string; name?: string; components?: readonly Param[] };
    const address = '0x1111111111111111111111111111111111111111';
    const secondAddress = '0x2222222222222222222222222222222222222222';
    const argument = (param: Param): unknown => {
      const array = param.type.match(/^(.*)\[(\d*)\]$/);
      if (array) return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () => argument({ ...param, type: array[1] }));
      if (param.type === 'tuple') return Object.fromEntries((param.components ?? []).map((part, index) => [part.name || String(index), argument(part)]));
      if (param.type === 'address') return address;
      if (param.type === 'bool') return true;
      if (param.type === 'bytes') return '0x';
      if (param.type === 'string') return '';
      if (param.type.startsWith('bytes')) return `0x${'00'.repeat(Number(param.type.slice(5)))}`;
      if (param.type.startsWith('int')) return -1n;
      if (param.type.startsWith('uint')) {
        const bits = Number(param.type.slice(4)) || 256;
        return (1n << BigInt(bits)) - 1n;
      }
      throw new Error(`Unsupported v5 test ABI type ${param.type}`);
    };
    const encode = (fn: (typeof additions)[number]) => encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map(argument) as never });
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST));
    const context = (chainId: number, grants: string[]) => ({ userId: 'v5-policy-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key' as const, executionOwner: address, allowedCapabilityIds: grants });
    const ambient = additions.find((fn) => fn.protocol === 'ambient')!;
    const ambientTypes = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'uint128' }, { type: 'uint16' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }] as const;
    const ambientPayload = encodeAbiParameters(ambientTypes, [address, secondAddress, maxUint256, true, false, (1n << 128n) - 1n, 65535, (1n << 128n) - 1n, 0n, 255]);
    const validAmbientData = encodeFunctionData({ abi: [ambient.abi], functionName: ambient.functionName, args: [1, ambientPayload] });
    const callData = (fn: (typeof additions)[number]) => fn === ambient ? validAmbientData : encode(fn);

    for (const fn of additions) {
      const data = callData(fn);
      const value = fn.abi.stateMutability === 'payable' ? '17' : undefined;
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId === 1 ? 10 : 1, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: address, data, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `0xdeadbeef${data.slice(10)}`, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00`, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (fn.abi.stateMutability !== 'payable') {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, [fn.capabilityId])))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
      const otherSameTarget = additions.find((other) => other.contract.toLowerCase() === fn.contract.toLowerCase() && other.capabilityId !== fn.capabilityId);
      if (otherSameTarget) await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [otherSameTarget.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }

    const lpTypes = [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }, { type: 'address' }] as const;
    const lpCodes = [1, 2, 3, 4, 11, 12, 21, 22, 31, 32, 41, 42];
    for (const code of lpCodes) {
      const payload = encodeAbiParameters(lpTypes, [code, address, secondAddress, maxUint256, -8388608, 8388607, (1n << 128n) - 1n, 0n, (1n << 128n) - 1n, 255, secondAddress]);
      const data = encodeFunctionData({ abi: [ambient.abi], functionName: ambient.functionName, args: [2, payload] });
      await expect(policy.authorizeContractCalls([{ to: ambient.contract, data }], context(1, [ambient.capabilityId]))).resolves.toBeDefined();
    }
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
