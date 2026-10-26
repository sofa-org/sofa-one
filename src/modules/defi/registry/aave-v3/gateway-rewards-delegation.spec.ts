import { encodeFunctionData, parseAbi } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import { PRODUCTION_DEFI_MANIFEST } from '../production-registry';

const owner = '0x0000000000000000000000000000000000000001';
const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const gateway = '0xd01607c3c5ecaba394d8be377a08590149325722';
const distributor = '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae';
const debt = '0x0c84331e39d6658cd6e6b9ba04736cc4c4734351';
const gatewayAbi = parseAbi([
  'function depositETH(address,address,uint16) payable',
  'function borrowETH(address,uint256,uint16)',
  'function withdrawETH(address,uint256,address)',
  'function repayETH(address,uint256,address) payable',
  'function borrowETH(address,uint256,uint256,uint16)',
]);

function capability(chainId: number, address: string, name: string) {
  const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.chainId === chainId
    && candidate.contract.toLowerCase() === address && candidate.functionName === name);
  if (!fn) throw new Error(`Missing ${chainId}:${address}:${name}`);
  return fn.capabilityId;
}

function fixture(chainId: number, grants: string[]) {
  let pausedScopeKeys: string[] = [];
  const db = { defiPolicyState: { findUnique: async () => ({ id: 'global', pausedScopeKeys }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
  const policy = new DefiPolicyService(db as never, {} as never, catalog);
  const context = {
    userId: 'aave-workflow', apiKeyId: '00000000-0000-4000-8000-000000000001',
    walletId: 'wallet', chainId, executionMode: 'session_key' as const, executionOwner: owner,
    capabilityMode: 'custom' as const, allowedCapabilityIds: grants,
  };
  return { policy, context, pause: (keys: string[]) => { pausedScopeKeys = keys; } };
}

const denied = (code: string) => ({ audit: { code } });

describe('Aave native gateway, credit delegation and rewards boundaries', () => {
  it('accepts payable three-argument deposits/repayments but denies native value on borrowing/withdrawal and legacy overloads', async () => {
    const ids = ['depositETH', 'repayETH', 'borrowETH', 'withdrawETH'].map((name) => capability(1, gateway, name));
    const { policy, context } = fixture(1, ids);
    const deposit = { to: gateway, data: encodeFunctionData({ abi: gatewayAbi, functionName: 'depositETH', args: [pool, owner, 0] }), value: '7' };
    const repay = { to: gateway, data: encodeFunctionData({ abi: gatewayAbi, functionName: 'repayETH', args: [pool, 7n, owner] }), value: '7' };
    for (const interaction of [deposit, repay]) {
      const result = await policy.authorizeContractCalls([interaction], context);
      expect(result.matches[0].capabilityId).toBe(ids[interaction === deposit ? 0 : 1]);
    }
    for (const data of [
      encodeFunctionData({ abi: gatewayAbi, functionName: 'borrowETH', args: [pool, 7n, 0] }),
      encodeFunctionData({ abi: gatewayAbi, functionName: 'withdrawETH', args: [pool, 7n, owner] }),
    ]) {
      await expect(policy.authorizeContractCalls([{ to: gateway, data, value: '1' }], context))
        .rejects.toMatchObject(denied('DEFI_INVALID_PARAMETERS'));
    }
    const legacy = encodeFunctionData({ abi: gatewayAbi, functionName: 'borrowETH', args: [pool, 7n, 2n, 0] });
    await expect(policy.authorizeContractCalls([{ to: gateway, data: legacy }], context))
      .rejects.toMatchObject(denied('DEFI_FUNCTION_NOT_ALLOWED'));
  });

  it.each([
    [56, '0x0c2c95b24529664fe55d4437d7a31175cfe6c4f7'],
    [137, '0xbc302053db3aa514a3c86b9221082f162b91ad63'],
    [8453, '0xa0d9c1e9e48ca30c8d8c3b5d69ff5dc1f6dffc24'],
  ])('does not admit unlisted repayETH on chain %s', async (chainId, address) => {
    const id = capability(chainId, address, 'depositETH');
    const { policy, context } = fixture(chainId, [id]);
    const data = encodeFunctionData({ abi: gatewayAbi, functionName: 'repayETH', args: [pool, 7n, owner] });
    await expect(policy.authorizeContractCalls([{ to: address, data, value: '7' }], { ...context, capabilityMode: 'all', allowedCapabilityIds: [] }))
      .rejects.toMatchObject(denied('DEFI_FUNCTION_NOT_ALLOWED'));
  });

  it('requires debt-token delegation grants independently of aToken approvals, even at the same address on another chain', async () => {
    const id = capability(10, debt, 'approveDelegation');
    const otherChainId = capability(42161, debt, 'approveDelegation');
    const approvalId = capability(10, '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8', 'approve');
    const { policy, context, pause } = fixture(10, [id]);
    const data = encodeFunctionData({ abi: parseAbi(['function approveDelegation(address,uint256)']), functionName: 'approveDelegation', args: [gateway, (1n << 256n) - 1n] });
    const call = { to: debt, data };
    expect((await policy.authorizeContractCalls([call], context)).matches[0].capabilityId).toBe(id);
    for (const allowedCapabilityIds of [[approvalId], [otherChainId], []]) {
      await expect(policy.authorizeContractCalls([call], { ...context, allowedCapabilityIds }))
        .rejects.toMatchObject(denied('DEFI_CAPABILITY_NOT_GRANTED'));
    }
    pause([`capability:${id}`]);
    await expect(policy.authorizeContractCalls([call], { ...context, capabilityMode: 'all', allowedCapabilityIds: [] }))
      .rejects.toMatchObject(denied('DEFI_CAPABILITY_PAUSED'));
  });

  it('decodes canonical nested reward proofs and rejects trailing bytes, value and cross-chain grants', async () => {
    const id = capability(8453, distributor, 'claim');
    const otherChainId = capability(10, distributor, 'claim');
    const { policy, context } = fixture(8453, [id]);
    const data = encodeFunctionData({
      abi: parseAbi(['function claim(address[],address[],uint256[],bytes32[][])']), functionName: 'claim',
      args: [[owner, owner], [owner, owner], [1n, 2n], [[], [`0x${'ab'.repeat(32)}`]]],
    });
    const call = { to: distributor, data };
    expect((await policy.authorizeContractCalls([call], context)).matches[0].capabilityId).toBe(id);
    for (const malformed of [`${data}00`, data.slice(0, -2)]) {
      await expect(policy.authorizeContractCalls([{ ...call, data: malformed }], context))
        .rejects.toMatchObject(denied('DEFI_INVALID_PARAMETERS'));
    }
    await expect(policy.authorizeContractCalls([{ ...call, value: '1' }], context))
      .rejects.toMatchObject(denied('DEFI_INVALID_PARAMETERS'));
    await expect(policy.authorizeContractCalls([call], { ...context, allowedCapabilityIds: [otherChainId] }))
      .rejects.toMatchObject(denied('DEFI_CAPABILITY_NOT_GRANTED'));
  });
});
