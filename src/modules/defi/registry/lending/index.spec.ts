import { buildLendingRegistry, LENDING_CAPABILITIES } from './index';

describe('lending function catalog', () => {
  it('contains 28 Aave and 6 Comet active source-verified definitions', () => {
    const fragment = buildLendingRegistry();
    expect(fragment.chains).toHaveLength(7);
    expect(LENDING_CAPABILITIES).toHaveLength(34);
    expect(LENDING_CAPABILITIES.filter((fn) => fn.protocol === 'Aave V3')).toHaveLength(28);
    expect(LENDING_CAPABILITIES.filter((fn) => fn.protocol === 'Compound III')).toHaveLength(6);
    expect(LENDING_CAPABILITIES.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
  });

  it('uses the canonical Aave and Comet signatures, fixed ABIs, and unchanged IDs', () => {
    const supply = LENDING_CAPABILITIES.find((fn) => fn.chainId === 1 && fn.protocol === 'Aave V3' && fn.functionName === 'supply')!;
    expect(supply.capabilityId).toBe('aave-v3:1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:supply');
    expect(supply.signature).toBe('supply(address,uint256,address,uint16)');
    expect(supply.abi.outputs).toEqual([]);
    const borrow = LENDING_CAPABILITIES.find((fn) => fn.protocol === 'Aave V3' && fn.functionName === 'borrow')!;
    expect(borrow.signature).toBe('borrow(address,uint256,uint256,uint16,address)');
    expect(borrow.abi.outputs).toEqual([]);
    const cometWithdraw = LENDING_CAPABILITIES.find((fn) => fn.protocol === 'Compound III' && fn.functionName === 'withdraw')!;
    expect(cometWithdraw.signature).toBe('withdraw(address,uint256)');
    expect(cometWithdraw.warnings?.join(' ')).toMatch(/may create debt/i);
  });

  it('keeps all action arguments user-controlled without embedded financial validators', () => {
    expect(LENDING_CAPABILITIES.every((fn) => !('validate' in fn) && !('describe' in fn))).toBe(true);
  });
});
