import { buildLendingRegistry, LENDING_CAPABILITIES } from './index';

describe('lending registry', () => {
  it('exports seven Aave pools and three Compound markets, all inactive', () => {
    const fragment = buildLendingRegistry();
    expect(fragment.markets).toHaveLength(10);
    expect(fragment.chains.flatMap(c => c.contracts).flatMap(c => c.functions)).toHaveLength(34);
    expect(fragment.chains.every(c => c.status === 'inactive')).toBe(true);
    expect(LENDING_CAPABILITIES.every(c => c.status === 'inactive')).toBe(true);
  });

  it('accepts only owner-bound Aave supply and rejects wrong asset, recipient, referral and sentinel', () => {
    const fn = LENDING_CAPABILITIES.find(c => c.chainId === 1 && c.functionName === 'supply')!;
    const context = { userId:'u',apiKeyId:'k',walletId:'w',chainId:1,executionMode:'user_operation',executionOwner:'0x1111111111111111111111111111111111111111',allowedCapabilityIds:[] };
    expect(fn.validate(['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',1_000_000n,context.executionOwner,0n],context)).toBe(true);
    expect(fn.validate(['0x0000000000000000000000000000000000000001',1n,context.executionOwner,0n],context)).toBe(false);
    expect(fn.validate(['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',1n,'0x2222222222222222222222222222222222222222',0n],context)).toBe(false);
    expect(fn.validate(['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',1n,context.executionOwner,1n],context)).toBe(false);
    expect(fn.validate(['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',(1n<<256n)-1n,context.executionOwner,0n],context)).toBe(false);
  });

  it('does not describe borrowing or Compound debt-capable withdraw', () => {
    const borrow=LENDING_CAPABILITIES.find(c=>c.functionName==='borrow')!;
    expect(borrow.validate([],{} as never)).toBe(false);
    expect(()=>borrow.describe([],{} as never,0)).toThrow(/unsupported/i);
    const withdraw=LENDING_CAPABILITIES.find(c=>c.protocol==='Compound III'&&c.functionName==='withdraw')!;
    expect(withdraw.status).toBe('inactive');
    expect(withdraw.inactiveReason).toMatch(/may create debt/i);
  });
});
