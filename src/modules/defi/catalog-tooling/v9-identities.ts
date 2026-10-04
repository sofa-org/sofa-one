export const V9_ASSEMBLY_PLAN_PATH = 'data/defi-catalog/v9/assembly-plan.json' as const;
export const V9_SOURCE_PATHS = Object.freeze(['data/defi-catalog/v9/sources/sdai-savings.json'] as const);
export const V9_BASELINE_PATH = 'data/defi-catalog/v8/catalog.json' as const;
export const V9_BASELINE_RAW_SHA256 = '638f6c4f3cd813dd843a8d4848d6822c7e603d353f5a963cbb23dd8f677a9575' as const;
export const V9_BASELINE_MANIFEST_HASH = '0xb9ae883df83aac2ed6bb2224ec6818f1623ec0de0987ade69e25dc54a7798aac' as const;
export const V9_SOURCE_CANONICAL_SHA256 = 'c1ca1ed92e19a6958b7b5824cf340d82f127605ce0e9e2d531c43dd61258c862' as const;
export const V9_SOURCE_RAW_SHA256 = '80fc52e66e837cf460fa354b7d1c355e9620ca82435d41b8a4e7757c9dedb588' as const;

export const V9_SDAI_BINDINGS = Object.freeze([
  { functionName: 'deposit', signature: 'deposit(uint256,address)', selector: '0x6e553f65', capabilityId: 'sdai-savings:no-referral-v1:1:0x83f20f44975d03b1b09e64809b757c47f942beea:deposit', abiHash: '0xd9aa3738e0f53bd8105b8c7e2517c7338d49553e906e80abf32af4c3a38f5997' },
  { functionName: 'mint', signature: 'mint(uint256,address)', selector: '0x94bf804d', capabilityId: 'sdai-savings:no-referral-v1:1:0x83f20f44975d03b1b09e64809b757c47f942beea:mint', abiHash: '0xb8f77e58b52fad3ac88bf14cb752b27c8e41983c8c149319e73db4c84f21e352' },
  { functionName: 'withdraw', signature: 'withdraw(uint256,address,address)', selector: '0xb460af94', capabilityId: 'sdai-savings:no-referral-v1:1:0x83f20f44975d03b1b09e64809b757c47f942beea:withdraw', abiHash: '0x59b31bf3102e98ba6650eb9794b53143fd4c1b90166242569843084f9d8df901' },
  { functionName: 'redeem', signature: 'redeem(uint256,address,address)', selector: '0xba087652', capabilityId: 'sdai-savings:no-referral-v1:1:0x83f20f44975d03b1b09e64809b757c47f942beea:redeem', abiHash: '0x8926ac0e897fc0dab6e7c43a4888021fd1b5270b6fb7e3046f6023c3c637444e' },
] as const);

export const V9_SDAI_SOURCE_REFS = Object.freeze([
  'maker-sdai-mainnet-role-2023-11-02',
  'maker-sdai-no-referral-implementation-66587976',
  'maker-sdai-interface-66587976',
] as const);
