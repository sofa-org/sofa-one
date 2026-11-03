import type { EnsoStaticWeirollChildBinding, EnsoStaticWeirollExecutionScope } from '../defi.types';

export const ENSO_STATIC_WEIROLL_ROOT_IDENTITY = Object.freeze({
  chainId: 1,
  contract: '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf',
  capabilityId: 'enso:router-static-weiroll-v1:1:0xf75584ef6673ad213a685a1b58cc0330b8ea22cf:route-single',
  functionName: 'routeSingle',
  signature: 'routeSingle((uint8,bytes),bytes)',
  selector: '0xb94c3609',
  abiHash: '0xe3045106c2f667460faa9d5d67104b5f7f70c24186421cf1dbc7a2f03624c5c9' as const,
  stateMutability: 'payable',
});

export const ENSO_STATIC_WEIROLL_CHILD_IDENTITIES: readonly EnsoStaticWeirollChildBinding[] = Object.freeze([
  Object.freeze({
    chainId: 1,
    contract: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    capabilityId: 'uniswap-v3-router02:v3:1:0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45:exact-input-single',
    signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
    abiHash: '0x5886210033f9bf1cfe530b0c389c52f6e207f5c00b28ea751f5e3d17e4f560bc',
  }),
  Object.freeze({
    chainId: 1,
    contract: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
    capabilityId: 'aave-v3:1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:supply',
    signature: 'supply(address,uint256,address,uint16)',
    abiHash: '0x159a872123875ab2798008c8eeacb7efe889e33be9f9373138472dc9fa39e783',
  }),
  Object.freeze({
    chainId: 1,
    contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    capabilityId: 'erc20:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:approve',
    signature: 'approve(address,uint256)',
    abiHash: '0x490c886ad5215051b719391097d15dd8f2fdfe72ded3158a8de693237aea96bc',
  }),
]);

export function createEnsoStaticWeirollScope(): EnsoStaticWeirollExecutionScope {
  return { kind: 'enso-static-weiroll-v1', allowedChildren: ENSO_STATIC_WEIROLL_CHILD_IDENTITIES };
}
