import { encodeFunctionData, parseAbi } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../production-registry';

const OWNER = '0x0000000000000000000000000000000000000001';
const RETIRED_POOL = '0x0aa97c284e98396202b6a04024f5e2c65026f3c0';
const ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
]);
const prisma = { defiPolicyState: { findUnique: async () => ({ id: 'global', pausedScopeKeys: [] }) } };
const policy = new DefiPolicyService(
  prisma as never,
  {} as never,
  new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST),
);

describe('legacy Aave EtherFi instance', () => {
  it.each([
    ['supply', [OWNER, 1n, OWNER, 0]],
    ['withdraw', [OWNER, 1n, OWNER]],
  ] as const)('does not admit %s, including an exit-only exception', async (operation, args) => {
    const interaction = {
      to: RETIRED_POOL,
      data: encodeFunctionData({ abi: ABI, functionName: operation, args } as never),
    };
    for (const capabilityMode of ['all', 'custom'] as const) {
      await expect(policy.authorizeContractCalls([interaction], {
        userId: 'user',
        apiKeyId: '00000000-0000-4000-8000-000000000001',
        walletId: 'wallet',
        chainId: 1,
        executionMode: 'session_key',
        executionOwner: OWNER,
        capabilityMode,
        allowedCapabilityIds: capabilityMode === 'custom'
          ? [`aave-v3:v3-aave:1:${RETIRED_POOL}:${operation}`]
          : [],
      })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    }
  });
});
