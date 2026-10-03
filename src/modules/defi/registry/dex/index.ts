import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment } from '../defi-manifest.types';

const sourceRef = 'docs/defi-research/simple-catalog-provenance.md (official deployment and fixed-interface references; snapshot 2026-10-02)';
const lower = (value: string) => value.toLowerCase();
type Router = { chainId: number; protocol: string; address: string; tuple: readonly { name: string; type: string }[] };
const deadlineTuple = [
  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
  { name: 'deadline', type: 'uint256' }, { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
] as const;
const router02Tuple = [
  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' },
] as const;
const routers: readonly Router[] = [
  ...[1, 10, 137, 42161].map((chainId) => ({ chainId, protocol: 'uniswap-v3', address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', tuple: deadlineTuple })),
  ...[
    [1, '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'],
    [8453, '0x2626664c2603336E57B271c5C0b26F421741e481'],
    [42161, '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'],
    [10, '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'],
    [137, '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'],
    [56, '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2'],
    [143, '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900'],
  ].map(([chainId, address]) => ({ chainId: chainId as number, protocol: 'uniswap-v3-router02', address: address as string, tuple: router02Tuple })),
  { chainId: 56, protocol: 'pancakeswap-v3', address: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', tuple: deadlineTuple },
];

function routerFunction(router: Router): DefiFunctionPolicy {
  const abi: AbiFunction = {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [...router.tuple] }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  };
  const signature = `exactInputSingle((${router.tuple.map((part) => part.type).join(',')}))`;
  const capabilityId = `${router.protocol}:v3:${router.chainId}:${lower(router.address)}:exact-input-single`;
  return {
    capabilityId, type: 'contract_call', chainId: router.chainId, contract: router.address,
    functionName: 'exactInputSingle', signature, abi, status: 'active',
    provenance: { sourceRef, verifiedAt: '2026-10-02', status: 'verified' },
    protocol: router.protocol, operation: 'exact-input-single',
    label: `${router.protocol} exactInputSingle`,
    warnings: ['Caller controls all tuple arguments, including assets, recipient, amount, minimum output, price limit, and any deadline field.'],
  };
}

const policies = routers.map(routerFunction);
const chains: DefiChainPolicy[] = [...new Set(policies.map((fn) => fn.chainId))].sort((a, b) => a - b).map((chainId) => {
  const family = policies.filter((fn) => fn.chainId === chainId);
  return {
    chainId, status: 'active',
    contracts: [...new Set(family.map((fn) => fn.contract.toLowerCase()))].map((address) => {
      const functions = family.filter((fn) => fn.contract.toLowerCase() === address);
      return { address: functions[0].contract, status: 'active' as const, functions };
    }),
  };
});

export function buildDexRegistry(): DefiRegistryFragment { return { chains }; }
