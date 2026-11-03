import { buildVaultRegistry, VAULT_CAPABILITIES } from './index';

describe('Morpho Vault V2 function catalog', () => {
  it('contains six active definitions for the two exact source-attributed vault addresses', () => {
    const fragment = buildVaultRegistry();
    expect(fragment.chains).toHaveLength(2);
    expect(VAULT_CAPABILITIES).toHaveLength(6);
    expect(VAULT_CAPABILITIES.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(VAULT_CAPABILITIES.map((fn) => fn.functionName).sort()).toEqual(['deposit', 'deposit', 'redeem', 'redeem', 'withdraw', 'withdraw']);
  });

  it('uses exact documented Vault V2 fixed ABI signatures and preserves IDs', () => {
    const byName = (name: string) => VAULT_CAPABILITIES.find((fn) => fn.functionName === name)!;
    expect(byName('deposit').capabilityId).toBe('morpho-vault-v2:1:0x04422053addbc9bb2759b248b574e3fca76bc145:deposit');
    expect(byName('deposit').signature).toBe('deposit(uint256,address)');
    expect(byName('withdraw').signature).toBe('withdraw(uint256,address,address)');
    expect(byName('redeem').signature).toBe('redeem(uint256,address,address)');
    expect(VAULT_CAPABILITIES.every((fn) => fn.abi.stateMutability === 'nonpayable')).toBe(true);
    expect(VAULT_CAPABILITIES.every((fn) => !('validate' in fn) && !('describe' in fn))).toBe(true);
  });
});
