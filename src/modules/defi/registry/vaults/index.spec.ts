import { buildVaultRegistry, VAULT_CAPABILITIES } from './index';

describe('vault registry', () => {
  it('contains only two inactive Morpho Vault V2 candidates', () => {
    const fragment=buildVaultRegistry();
    expect(fragment.markets).toHaveLength(2);
    expect(VAULT_CAPABILITIES).toHaveLength(6);
    expect(fragment.chains.every(c=>c.status==='inactive')).toBe(true);
    expect(fragment.deployments.every(d=>d.status==='candidate'&&!d.runtimeCodeHash&&!d.abiHash)).toBe(true);
  });

  it('bounds USDC deposits and requires owner receiver/beneficiary for vault actions', () => {
    const fn=VAULT_CAPABILITIES.find(c=>c.functionName==='deposit')!;
    const ctx={userId:'u',apiKeyId:'k',walletId:'w',chainId:1,executionMode:'user_operation',executionOwner:'0x1111111111111111111111111111111111111111',allowedCapabilityIds:[]};
    expect(fn.validate([1_000_000n,ctx.executionOwner],ctx)).toBe(true);
    expect(fn.validate([1_000_000_001n,ctx.executionOwner],ctx)).toBe(false);
    const withdraw=VAULT_CAPABILITIES.find(c=>c.functionName==='withdraw')!;
    expect(withdraw.validate([1n,'0x2222222222222222222222222222222222222222',ctx.executionOwner],ctx)).toBe(false);
  });

  it('keeps redeem descriptions unavailable without configured share bounds', () => {
    const redeem=VAULT_CAPABILITIES.find(c=>c.functionName==='redeem')!;
    expect(()=>redeem.describe([1n,'0x1111111111111111111111111111111111111111','0x1111111111111111111111111111111111111111'],{} as never,0)).toThrow(/share ceiling/i);
  });
});
