import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { functionAbiHash } from './defi-manifest';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';

const target = '0xbe53a109b494e5c9f97b9cd39fe969be68bf6204';
const sourceRef = 'https://etherscan.io/address/0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204#code';
const expected = [
  { signature: 'deposit(uint256,address)', selector: '0x6e553f65', inputs: [['assets', 'uint256'], ['receiver', 'address']] },
  { signature: 'mint(uint256,address)', selector: '0x94bf804d', inputs: [['shares', 'uint256'], ['receiver', 'address']] },
  { signature: 'withdraw(uint256,address,address)', selector: '0xb460af94', inputs: [['assets', 'uint256'], ['receiver', 'address'], ['owner', 'address']] },
  { signature: 'redeem(uint256,address,address)', selector: '0xba087652', inputs: [['shares', 'uint256'], ['receiver', 'address'], ['owner', 'address']] },
] as const;

describe('Yearn V3 yvUSDC-1 Ethereum catalog admission', () => {
  it('binds the production manifest to exactly the four Etherscan ABI fragments and fixed identities', () => {
    const source = JSON.parse(readFileSync('data/defi-catalog/sources/yearn-v3-yvusdc-1.json', 'utf8'));
    expect(source.contracts).toHaveLength(1);
    expect(source.contracts[0]).toMatchObject({ chainId: 1, address: '0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204', implementation: '0x1ab62413e0cf2eBEb73da7D40C70E7202ae14467' });
    expect(source.sources).toEqual([expect.objectContaining({ sourceId: 'yearn-yvusdc-1-etherscan-deployment', url: sourceRef, retrievedAtUtc: '2026-10-16' })]);
    expect(source.abiSnapshot).toHaveLength(4);
    expect(source.unresolved.join(' ')).toMatch(/administrative, strategy-management/i);
    expect(source.unresolved.join(' ')).toMatch(/max_loss or strategies overloads/i);

    const functions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'yearn-v3-vault' && fn.contract.toLowerCase() === target);
    expect(functions).toHaveLength(4);
    expect(functions.map((fn) => fn.signature)).toEqual(expected.map((fn) => fn.signature));
    for (const [index, fn] of functions.entries()) {
      const item = expected[index];
      expect(fn).toMatchObject({ chainId: 1, contract: target, status: 'active', type: 'contract_call', protocol: 'yearn-v3-vault', signature: item.signature, functionName: item.signature.slice(0, item.signature.indexOf('(')), provenance: { sourceRef, status: 'verified', verifiedAt: '2026-10-16' } });
      expect(fn.abiHash).toBe(functionAbiHash(fn));
      expect(toFunctionSelector(fn.signature)).toBe(item.selector);
      expect(fn.abi.stateMutability).toBe('nonpayable');
      expect(fn.abi.inputs.map(({ name, type }) => [name, type])).toEqual(item.inputs);
      expect(fn.abi.outputs).toEqual([{ name: '', type: 'uint256' }]);
      const sourceFn = source.contracts[0].abiFunctions[index];
      expect(sourceFn).toMatchObject({ ...fn.abi, inputs: fn.abi.inputs.map((input) => ({ ...input, internalType: input.type })), outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] });
    }
    expect(functions.map((fn) => fn.abiHash)).toEqual([
      '0x4ae58cbdd8dcbadadd34601ee93eed2b3ef126689b839b5f8bc83a911c070b06',
      '0xb74304ceeee9215ec57a8d6f60739caafb06f13e1b804a3cc243e9ecf3bada14',
      '0x4ae9a3614c5883bb22ca624c1a9ae0629999c67de7d257e8b882e69d950273fa',
      '0xd60414f7ba04a5c9e9903a18e4a0d3269b33a47cf86f13a55a7f141e3125aaa4',
    ]);
  });

  it('canonically encodes and decodes the four calls and excludes administration and overloads', () => {
    const functions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'yearn-v3-vault' && fn.contract.toLowerCase() === target);
    const address = '0x1111111111111111111111111111111111111111';
    for (const fn of functions) {
      const args = fn.abi.inputs.length === 2 ? [123n, address] : [123n, address, address];
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
      const decoded = decodeFunctionData({ abi: [fn.abi], data });
      expect(decoded.functionName).toBe(fn.functionName);
      expect(decoded.args).toEqual(args);
      expect(encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: decoded.args as never })).toBe(data);
    }
    expect(functions.map((fn) => fn.signature)).not.toContain('withdraw(uint256,address,address,uint256)');
    expect(functions.map((fn) => fn.signature)).not.toContain('redeem(uint256,address,address,uint256)');
    expect(functions.some((fn) => /^(?:set|update|shutdown|accept|transfer|approve)/i.test(fn.functionName))).toBe(false);
    expect(functions).toHaveLength(4);
  });

  it('reuses production policy authorization to require an exact grant for these manifest calls', async () => {
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const owner = '0x1111111111111111111111111111111111111111';
    const context = (allowedCapabilityIds: string[]) => ({ userId: 'yearn-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: 1, executionMode: 'session_key' as const, executionOwner: owner, allowedCapabilityIds });
    for (const fn of PRODUCTION_DEFI_MANIFEST.capabilities.filter((item) => item.protocol === 'yearn-v3-vault' && item.contract.toLowerCase() === target)) {
      const args = fn.abi.inputs.length === 2 ? [1n, owner] : [1n, owner, owner];
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([fn.capabilityId])).then((result) => result.matches[0].capabilityId)).resolves.toBe(fn.capabilityId);
      await expect(policy.authorizeContractCalls([{ to: target, data }], context([]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });
});
