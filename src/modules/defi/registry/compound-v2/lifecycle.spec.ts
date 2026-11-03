import { encodeFunctionData, parseAbi } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../production-registry';

const OWNER = '0x1111111111111111111111111111111111111111';
const CETH = '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5';
const CASES = [
  {
    label: 'cETH repayment', address: CETH, grantSuffix: 'repay-borrow', value: '1',
    data: encodeFunctionData({ abi: parseAbi(['function repayBorrow() payable']), functionName: 'repayBorrow' }),
  },
  {
    label: 'cDAI redemption', address: '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643', grantSuffix: 'redeem',
    data: encodeFunctionData({ abi: parseAbi(['function redeem(uint256 redeemTokens) returns (uint256)']), functionName: 'redeem', args: [1n] }),
  },
  {
    label: 'cUSDC behalf repayment', address: '0x39aa39c021dfbae8fac545936693ac917d5e7563', grantSuffix: 'repay-borrow-behalf',
    data: encodeFunctionData({ abi: parseAbi(['function repayBorrowBehalf(address borrower,uint256 repayAmount) returns (uint256)']), functionName: 'repayBorrowBehalf', args: [OWNER, 1n] }),
  },
  {
    label: 'cUSDT liquidation', address: '0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9', grantSuffix: 'liquidate-borrow',
    data: encodeFunctionData({ abi: parseAbi(['function liquidateBorrow(address borrower,uint256 repayAmount,address cTokenCollateral) returns (uint256)']), functionName: 'liquidateBorrow', args: [OWNER, 1n, CETH] }),
  },
  {
    label: 'Comptroller reward claim', address: '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b', grantSuffix: 'claim-comp:0xe9af0292',
    data: encodeFunctionData({ abi: parseAbi(['function claimComp(address holder)']), functionName: 'claimComp', args: [OWNER] }),
  },
] as const;
const oldGrant = (entry: typeof CASES[number]) => `compound-v2:v2-compound:1:${entry.address}:${entry.grantSuffix}`;
const prisma = { defiPolicyState: { findUnique: async () => ({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(prisma as never, {} as never, catalog);

describe('retired Compound V2 deployments', () => {
  it.each(CASES)('cannot restore $label through all mode or a saved exact grant, including exits', async (entry) => {
    const interaction = { to: entry.address, data: entry.data, ...('value' in entry ? { value: entry.value } : {}) };
    for (const capabilityMode of ['all', 'custom'] as const) {
      await expect(policy.authorizeContractCalls([interaction], {
        userId: 'user',
        apiKeyId: '00000000-0000-4000-8000-000000000001',
        walletId: 'wallet',
        chainId: 1,
        executionMode: 'session_key',
        executionOwner: OWNER,
        capabilityMode,
        allowedCapabilityIds: capabilityMode === 'custom' ? [oldGrant(entry)] : [],
      })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    }
  });

  it('reports saved retired selections as unknown rather than active or paused metadata', async () => {
    const ids = CASES.map(oldGrant);
    expect(await catalog.listMetadataByIds(ids)).toEqual({ capabilities: [], unknownIds: ids });
  });
});
