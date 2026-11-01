import { encodeFunctionData, parseAbiItem, type AbiFunction } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext } from '../defi.types';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './production-registry';

const OWNER = '0x0000000000000000000000000000000000000001';
const OLD_IDLE = '0x493c57c4763932315a328269e1adad09653b9081';
const IDLE = '0x3fe7940616e5bc47b0775a0dccf6237893353bb4';
const SYMBIOTIC = '0x007e0b8e99c6134e81a1eaae754460e3202cb671';
const OLD_IDLE_GRANT = `idle:v3-1:1:${OLD_IDLE}:mint-idle-token`;
const OLD_SYMBIOTIC_GRANT = `symbiotic:v1:1:${SYMBIOTIC}:deposit`;

function fixture() {
  const prisma = {
    defiPolicyState: {
      findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }),
    },
  };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
  return new DefiPolicyService(prisma as never, {} as never, catalog);
}

function context(id: string): DefiExecutionContext {
  return {
    userId: 'user', apiKeyId: 'key', walletId: 'wallet', chainId: 1,
    executionMode: 'session_key', executionOwner: OWNER,
    capabilityMode: 'custom', allowedCapabilityIds: [id],
  };
}

function encoded(signature: string, args: readonly unknown[]): `0x${string}` {
  const abi = parseAbiItem(`function ${signature}`) as AbiFunction;
  return encodeFunctionData({ abi: [abi], functionName: abi.name, args: args as never });
}

describe('deployment interface cutover', () => {
  it('rejects misattributed and obsolete selectors even with their former explicit grants', async () => {
    const policy = fixture();
    const obsolete = [
      { to: OLD_IDLE, id: OLD_IDLE_GRANT, signature: 'mintIdleToken(uint256,bool,address)', args: [1n, false, OWNER] },
      { to: OLD_IDLE, id: `idle:v3-1:1:${OLD_IDLE}:redeem-idle-token`, signature: 'redeemIdleToken(uint256)', args: [1n] },
      ...[
        ['deposit', 'deposit(address,uint256)'],
        ['withdraw', 'withdraw(address,uint256)'],
        ['redeem', 'redeem(address,uint256)'],
        ['claim', 'claim(address,uint256)'],
        ['claim-batch', 'claimBatch(address,uint256[])'],
      ].map(([operation, signature]) => ({
        to: SYMBIOTIC, id: `symbiotic:v1:1:${SYMBIOTIC}:${operation}`, signature,
        args: operation === 'claim-batch' ? [OWNER, [0n]] : [OWNER, 1n],
      })),
    ];
    for (const entry of obsolete) {
      await expect(policy.authorizeContractCalls([
        { to: entry.to, data: encoded(entry.signature, entry.args) },
      ], context(entry.id))).rejects.toMatchObject({
        audit: {
          code: entry.to === OLD_IDLE ? 'DEFI_CONTRACT_NOT_ALLOWED' : 'DEFI_FUNCTION_NOT_ALLOWED',
        },
      });
    }
  });

  it('does not migrate saved custom grants to replacement deployment or ABI identities', async () => {
    const policy = fixture();
    for (const [address, signature, oldGrant, args] of [
      [IDLE, 'mintIdleToken(uint256,bool,address)', OLD_IDLE_GRANT, [1n, false, OWNER]],
      [SYMBIOTIC, 'deposit(uint256,address)', OLD_SYMBIOTIC_GRANT, [1n, OWNER]],
    ] as const) {
      const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) =>
        candidate.contract.toLowerCase() === address && candidate.signature === signature,
      );
      if (!fn) throw new Error(`Missing reviewed replacement ${address} ${signature}`);
      const call = { to: address, data: encoded(signature, args) };
      await expect(policy.authorizeContractCalls([call], context(oldGrant))).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
      });
      await expect(policy.authorizeContractCalls([call], context(fn.capabilityId))).resolves.toMatchObject({
        matches: [expect.objectContaining({ capabilityId: fn.capabilityId })],
      });
    }
  });
});
