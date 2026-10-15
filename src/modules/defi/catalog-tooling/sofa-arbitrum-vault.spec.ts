import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';
import { GENERATED_DEFI_REGISTRY } from '../registry/generated/production-catalog';
import { functionAbiHash } from '../registry/defi-manifest';

const PROXIES = [
  {
    name: 'SmartBull ETH/USDT',
    address: '0x00aeca021d0f06c7dee54d58ee6af47b5645ab19',
    family: 'smarttrend-vault',
  },
  {
    name: 'SmartBull BTC/USDT',
    address: '0x989897f1d976ee0b59bf0a3172c170d8f3cb84e3',
    family: 'smarttrend-vault',
  },
  {
    name: 'SmartBear ETH/USDT',
    address: '0x6e72c8726c71a4cbc6e31ff7d47b399fa983c7b8',
    family: 'smarttrend-vault',
  },
  {
    name: 'SmartBear BTC/USDT',
    address: '0x106825b71cce77a70b69f57a0acf9c4a6acf292a',
    family: 'smarttrend-vault',
  },
  {
    name: 'AAVESmartBull ETH/USDT',
    address: '0x9c5d3c3abd633b8ea68c5a51325f8630dc620ad9',
    family: 'aave-smarttrend-vault',
  },
  {
    name: 'AAVESmartBull BTC/USDT',
    address: '0x2f1c60ba96ec6925fa9bbbfc9eb7908bd35bc224',
    family: 'aave-smarttrend-vault',
  },
  {
    name: 'AAVESmartBear ETH/USDT',
    address: '0x72e0906558e4ee528974cd7803bff12d9f2869c3',
    family: 'aave-smarttrend-vault',
  },
  {
    name: 'AAVESmartBear BTC/USDT',
    address: '0x9377f17abde96887943e5fcc92db034c76820529',
    family: 'aave-smarttrend-vault',
  },
  {
    name: 'DNTVault ETH/USDT',
    address: '0x7ecd1b5255543f4c2d7d8e475afcd01699dbe2b0',
    family: 'dnt-vault',
  },
  {
    name: 'DNTVault BTC/USDT',
    address: '0xdfeb3460771148799b2d4344c369e2b2d6c26c42',
    family: 'dnt-vault',
  },
  {
    name: 'AAVEDNTVault ETH/USDT',
    address: '0x3a253838121b9ad9736fafc030cf4971615d68b2',
    family: 'aave-dnt-vault',
  },
  {
    name: 'AAVEDNTVault BTC/USDT',
    address: '0xd9cff1bc89f705eab2579fa2dc86e9a6f971370a',
    family: 'aave-dnt-vault',
  },
  {
    name: 'AAVEDNTVaultV1.1 ETH/USDT',
    address: '0xa5492baf06692c0051d69d31458d536bacc08651',
    family: 'aave-dnt-vault-v1-1',
  },
  {
    name: 'AAVEDNTVaultV1.1 BTC/USDT',
    address: '0x75809d59a9a69226972dbb84cb2d1851c5cd0cbf',
    family: 'aave-dnt-vault-v1-1',
  },
  {
    name: 'LeverageDNTVault ETH/USDT',
    address: '0x6f4dbcfc81dd22ae3edec5f9724e43cba8c92e50',
    family: 'leverage-dnt-vault',
  },
  {
    name: 'LeverageDNTVault BTC/USDT',
    address: '0xa8fcc1ba1d4893a4894206986b65f652d5fe04ab',
    family: 'leverage-dnt-vault',
  },
] as const;

const EXPECTED_ABI = {
  'smarttrend-vault': {
    burn: [
      'burn(uint256,uint256[2],uint256)',
      '0xfea3ece2bf717d6d734a0ce48c345d1b1567c914043533b0692ac25a4a386d77',
    ],
    burnBatch: [
      'burnBatch((uint256,uint256[2],uint256)[])',
      '0x99e3f5520e0d37e50f4b089d170d52c7ad29afc16742d14c77d143c2e5589e8f',
    ],
  },
  'aave-smarttrend-vault': {
    burn: [
      'burn(uint256,uint256[2],uint256,uint256)',
      '0x5b197e5e08ba4b67ca6818d3c063da5975f13d10445d96bd9274628a68ad13aa',
    ],
    burnBatch: [
      'burnBatch((uint256,uint256[2],uint256,uint256)[])',
      '0x6bd500e78c9a34fb6d540d481bc3cdccd93241baf762c3163a2edc04cbadf60b',
    ],
  },
  'dnt-vault': {
    burn: [
      'burn(uint256,uint256,uint256[2],uint256)',
      '0xcced1cc41c5b3cc042c9f86e19466fe49606f4d47fb98c2f870db26aad22dc1c',
    ],
    burnBatch: [
      'burnBatch((uint256,uint256,uint256[2],uint256)[])',
      '0x6cf1829575762f9fd8813339f672faf7725492000999a07b9242f29f02564190',
    ],
  },
  'aave-dnt-vault': {
    burn: [
      'burn(uint256,uint256,uint256[2],uint256,uint256)',
      '0x68dbef54586d2094cc57d839bbd3438c0051439ac1370889e8773b755c35a1b3',
    ],
    burnBatch: [
      'burnBatch((uint256,uint256,uint256[2],uint256,uint256)[])',
      '0x6e557563ed4523e3eefe4242e07becd7166f5a89093eae414748e9d733719d25',
    ],
  },
  'aave-dnt-vault-v1-1': {
    burn: [
      'burn(uint256,uint256,uint256[2],uint256,uint256)',
      '0x68dbef54586d2094cc57d839bbd3438c0051439ac1370889e8773b755c35a1b3',
    ],
    burnBatch: [
      'burnBatch((uint256,uint256,uint256[2],uint256,uint256)[])',
      '0x6e557563ed4523e3eefe4242e07becd7166f5a89093eae414748e9d733719d25',
    ],
  },
  'leverage-dnt-vault': {
    burn: [
      'burn(uint256,uint256,uint256[2],uint256,uint256)',
      '0x68dbef54586d2094cc57d839bbd3438c0051439ac1370889e8773b755c35a1b3',
    ],
    burnBatch: [
      'burnBatch((uint256,uint256,uint256[2],uint256,uint256)[])',
      '0x0f664eeabc197cb8f9067d0d966e65a7bb5d8d1649cb0134684f4ec893c98c6f',
    ],
  },
} as const;

const OWNER = '0x0000000000000000000000000000000000000001';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sample(parameter: any): any {
  if (parameter.type.startsWith('tuple')) {
    const tuple = (parameter.components ?? []).map((component: any) => sample(component));
    return parameter.type.endsWith('[]') ? [tuple] : tuple;
  }
  const array = parameter.type.match(/^(.*)\[(\d*)\]$/);
  if (array)
    return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () =>
      sample({ type: array[1] }),
    );
  if (parameter.type === 'address') return OWNER;
  if (parameter.type === 'bytes') return '0x';
  if (parameter.type === 'bool') return false;
  if (parameter.type.startsWith('bytes'))
    return `0x${'00'.repeat(Number(parameter.type.slice(5)) || 32)}`;
  if (/^(u?int)/.test(parameter.type)) return 1n;
  throw new Error(`Unsupported test ABI type ${parameter.type}`);
}

function calldata(fn: DefiFunctionPolicy): `0x${string}` {
  return (encodeFunctionData as any)({
    abi: [fn.abi],
    functionName: fn.functionName,
    args: fn.abi.inputs.map((input) => sample(input as never)),
  });
}

function makePolicy(): DefiPolicyService {
  const prisma = {
    defiPolicyState: {
      findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }),
    },
  };
  const catalog = new DefiCatalogService(
    PRODUCTION_DEFI_CATALOG,
    prisma as never,
    PRODUCTION_DEFI_MANIFEST,
  );
  return new DefiPolicyService(prisma as never, {} as never, catalog);
}

describe('SOFA Arbitrum vault redemption catalog admission', () => {
  const source = JSON.parse(
    readFileSync('data/defi-catalog/sources/sofa-arbitrum-vault-redeem.json', 'utf8'),
  );
  const catalogContracts = GENERATED_DEFI_REGISTRY.chains.find(
    (chain) => chain.chainId === 42161,
  )!.contracts;
  const byAddress = new Map(catalogContracts.map((contract) => [contract.address, contract]));

  it('binds exactly 16 documented Arbitrum proxies and 32 family-specific redemption capabilities', () => {
    const observed = source.proxies.map(
      (proxy: { officialName: string; address: string; implementationFamilyId: string }) => ({
        name: proxy.officialName,
        address: proxy.address,
        family: proxy.implementationFamilyId,
      }),
    );
    expect(
      observed.sort((a: { address: string }, b: { address: string }) =>
        a.address.localeCompare(b.address),
      ),
    ).toEqual([...PROXIES].sort((a, b) => a.address.localeCompare(b.address)));
    expect(source.proxies).toHaveLength(16);
    expect(source.implementations).toHaveLength(6);

    const entries = PROXIES.map((proxy) => {
      const contract = byAddress.get(proxy.address);
      expect(contract).toBeDefined();
      expect(contract!.functions).toHaveLength(2);
      expect(contract!.functions.map((fn) => fn.functionName).sort()).toEqual([
        'burn',
        'burnBatch',
      ]);
      for (const fn of contract!.functions) {
        const expected = EXPECTED_ABI[proxy.family][fn.functionName as 'burn' | 'burnBatch'];
        expect(fn).toMatchObject({
          capabilityId: `sofa:${proxy.family}:42161:${proxy.address}:${fn.functionName}`,
          chainId: 42161,
          contract: proxy.address,
          functionName: fn.functionName,
          signature: expected[0],
          abiHash: expected[1],
          operation: 'redeem',
          protocol: 'sofa',
          status: 'active',
          abi: { stateMutability: 'nonpayable' },
        });
        expect(functionAbiHash(fn)).toBe(expected[1]);
      }
      return contract!.functions;
    }).flat();
    expect(entries).toHaveLength(32);
    expect(new Set(entries.map((fn) => fn.capabilityId)).size).toBe(32);
  });

  it('validates each exact-match implementation snapshot, source excerpt digest, proxy pointer, and ABI binding', () => {
    expect(source.deploymentReference).toBe('https://docs.sofa.org/en/developer/contracts.html');
    expect(source.pointerObservation).toMatchObject({
      blockTag: 'latest',
      slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    });
    for (const implementation of source.implementations) {
      expect(implementation).toMatchObject({
        exactMatch: true,
        match: 'exact_match',
        runtimeMatch: 'exact_match',
        compiler: '0.8.10+commit.fc410830',
        language: 'Solidity',
      });
      expect(implementation.abiSnapshotSha256).toBe(
        `sha256:${createHash('sha256').update(canonical(implementation.abiSnapshot)).digest('hex')}`,
      );
      expect(implementation.sourceExcerptSha256).toBe(
        `sha256:${createHash('sha256').update(canonical(implementation.sourceExcerpt)).digest('hex')}`,
      );
      expect(implementation.sourceExcerpt.burn).toContain('function burn(');
      expect(implementation.sourceExcerpt._burn).toContain('balanceOf(_msgSender()');
      expect(implementation.sourceExcerpt._burn).toContain('not settled');
      expect(implementation.sourceExcerpt.burnBatch).toContain('function burnBatch(');
      expect(implementation.sourceExcerpt._burnBatch).toContain('balanceOf(_msgSender()');
      const proxies = source.proxies.filter(
        (proxy: { implementation: string }) =>
          proxy.implementation === implementation.implementation,
      );
      expect(proxies.length).toBeGreaterThan(0);
      for (const proxy of proxies) {
        expect(proxy.storageValue).toBe(
          `0x${'0'.repeat(24)}${implementation.implementation.slice(2)}`,
        );
        expect(byAddress.get(proxy.address)).toBeDefined();
        for (const fn of byAddress.get(proxy.address)!.functions) {
          const snapshotAbi = implementation.abiSnapshot[fn.functionName as 'burn' | 'burnBatch'];
          expect(fn.abi).toEqual(snapshotAbi);
          expect(fn.provenance).toMatchObject({
            sourceRef: implementation.sourceRef,
            status: 'verified',
            verifiedAt: implementation.verifiedAt.slice(0, 10),
          });
        }
      }
    }
  });

  it('round-trips canonical calldata for every implementation ABI family and both redemption functions', () => {
    for (const implementation of source.implementations) {
      for (const functionName of ['burn', 'burnBatch'] as const) {
        const fn = implementation.abiSnapshot[functionName] as DefiFunctionPolicy['abi'];
        const call = { ...fn, functionName } as DefiFunctionPolicy['abi'] & {
          functionName: string;
        };
        const args = call.inputs.map((input) => sample(input));
        const data = (encodeFunctionData as any)({ abi: [call], functionName, args });
        const decoded = (decodeFunctionData as any)({ abi: [call], data });
        expect(decoded.functionName).toBe(functionName);
        expect((encodeFunctionData as any)({ abi: [call], functionName, args: decoded.args })).toBe(
          data,
        );
      }
    }
  });

  it('requires the exact custom capability, Arbitrum chain, and zero native value', async () => {
    const policy = makePolicy();
    const entries = PROXIES.flatMap((proxy) => byAddress.get(proxy.address)!.functions);
    for (const fn of entries) {
      const context: DefiExecutionContext = {
        userId: 'user',
        apiKeyId: 'key',
        walletId: 'wallet',
        chainId: 42161,
        executionMode: 'eoa',
        executionOwner: OWNER,
        allowedCapabilityIds: [fn.capabilityId],
      };
      const interaction = { to: fn.contract, data: calldata(fn) };
      await expect(policy.authorizeContractCalls([interaction], context)).resolves.toMatchObject({
        matches: [expect.objectContaining({ capabilityId: fn.capabilityId })],
      });
      await expect(
        policy.authorizeContractCalls([interaction], {
          ...context,
          allowedCapabilityIds: ['sofa:wrong-capability'],
        }),
      ).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(
        policy.authorizeContractCalls([interaction], { ...context, chainId: 1 }),
      ).rejects.toBeDefined();
      await expect(
        policy.authorizeContractCalls([{ ...interaction, value: 1n }], context),
      ).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });
});
