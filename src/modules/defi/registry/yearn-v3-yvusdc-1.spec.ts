import { encodeFunctionData } from 'viem';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';

const target = '0xbe53a109b494e5c9f97b9cd39fe969be68bf6204';
const signatures = [
  'deposit(uint256,address)',
  'mint(uint256,address)',
  'withdraw(uint256,address,address)',
  'redeem(uint256,address,address)',
] as const;

describe('Yearn V3 yvUSDC-1 Ethereum catalog admission', () => {
  it('reuses production policy authorization to require an exact grant for these manifest calls', async () => {
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const owner = '0x1111111111111111111111111111111111111111';
    const context = (allowedCapabilityIds: string[], chainId = 1) => ({ userId: 'yearn-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId, executionMode: 'session_key' as const, executionOwner: owner, allowedCapabilityIds });
    for (const signature of signatures) {
      const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.protocol === 'yearn-v3-vault' && item.chainId === 1 && item.contract.toLowerCase() === target && item.signature === signature)!;
      const args = fn.abi.inputs.length === 2 ? [1n, owner] : [1n, owner, owner];
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([fn.capabilityId])).then((result) => result.matches[0].capabilityId)).resolves.toBe(fn.capabilityId);
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const otherGrant = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.contract.toLowerCase() === target && item.signature !== signature)!;
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([otherGrant.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([fn.capabilityId], 10))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: owner, data }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: target, data: `${data}00` }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ to: target, data, value: '1' }], context([fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});
