import type { AbiFunction } from 'viem';

/** Official deployment inventory; not a live bytecode or execution attestation. */
export const UNISWAP_DEPLOYMENTS: Readonly<Record<number, Readonly<{
  router: `0x${string}`;
  positionManager: `0x${string}`;
  wrappedNative: `0x${string}`;
}>>> = Object.freeze({
  1: { router: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85', positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  10: { router: '0xc09255d86db563cbc11c2fcf4a0c512e160111b4', positionManager: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017', wrappedNative: '0x4200000000000000000000000000000000000006' },
  56: { router: '0xdc264714f68d84cf29bc605589405e78bdbe7c9f', positionManager: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b', wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  137: { router: '0xdc264714f68d84cf29bc605589405e78bdbe7c9f', positionManager: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9', wrappedNative: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
  143: { router: '0xa6ce4f10d83dbddac17e68e1837ca9ce6a1b596e', positionManager: '0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016', wrappedNative: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a' },
  8453: { router: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', wrappedNative: '0x4200000000000000000000000000000000000006' },
  42161: { router: '0x2d01411773c8c24805306e89a41f7855c3c4fe65', positionManager: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', wrappedNative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
});
export const UNISWAP_POOL_MANAGERS: Readonly<Record<number, `0x${string}`>> = Object.freeze({
  1: '0x000000000004444c5dc75cb358380d2e3de08a90',
  10: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  56: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
  137: '0x67366782805870060151383f4bbff9dab53e5cd6',
  143: '0x188d586ddcf52439676ca21a244753fa19f9ea8e',
  8453: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  42161: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
});
export const UNISWAP_PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;
export const UNISWAP_ROUTER_ABI: AbiFunction = {
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [],
};
export const UNISWAP_V4_POSITION_ABI: AbiFunction = {
  type: 'function', name: 'modifyLiquidities', stateMutability: 'payable',
  inputs: [{ name: 'unlockData', type: 'bytes' }, { name: 'deadline', type: 'uint256' }], outputs: [],
};
export type UniswapExecutionContext = Readonly<{ chainId: number; executionOwner: string; nativeValue: bigint; callerAddress?: string }>;
export type UniswapExecutionResult = Readonly<{
  operationCount: number;
  touchedContracts: readonly string[];
  /** Forwarded router balances are runtime-dependent; absent value is not a zero-value attestation. */
  children: readonly Readonly<{ to: string; data: `0x${string}`; value?: string }>[];
}>;
