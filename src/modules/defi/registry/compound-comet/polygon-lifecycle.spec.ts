import { encodeFunctionData, parseAbi } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../production-registry';

const OWNER = '0x0000000000000000000000000000000000000001';
const ABI = parseAbi(['function supply(address asset, uint256 amount)']);
const prisma = {
  defiPolicyState: {
    findUnique: async () => ({ id: 'global', pausedScopeKeys: [] }),
  },
};
const policy = new DefiPolicyService(
  prisma as never,
  {} as never,
  new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST),
);

describe('deprecated Compound Polygon markets', () => {
  it.each([
    '0xaeb318360f27748acb200ce616e389a6c9409a07',
    '0xf25212e676d1f7f89cd72ffee66158f541246445',
  ] as const)('cannot restore %s through all mode or a saved exact grant', async (address) => {
    const oldGrant = `compound-iii:v3-comet:137:${address}:supply`;
    const interaction = {
      to: address,
      data: encodeFunctionData({ abi: ABI, functionName: 'supply', args: [OWNER, 1n] }),
    };
    for (const capabilityMode of ['all', 'custom'] as const) {
      await expect(policy.authorizeContractCalls([interaction], {
        userId: 'user',
        apiKeyId: '00000000-0000-4000-8000-000000000001',
        walletId: 'wallet',
        chainId: 137,
        executionMode: 'session_key',
        executionOwner: OWNER,
        capabilityMode,
        allowedCapabilityIds: capabilityMode === 'custom' ? [oldGrant] : [],
      })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    }
  });
});
