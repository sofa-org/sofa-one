import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOperation, isAuthorizationReady, readOperation, saveOperation, type WithdrawalIntent } from './wallet-recovery';

const intent: WithdrawalIntent = {
  userId: 'user-a', walletId: 'wallet-a', walletAddress: `0x${'1'.repeat(40)}`,
  chainId: 84532, to: `0x${'2'.repeat(40)}`, token: 'USDC', amount: '1500000',
  displayAmount: '1.50', idempotencyKey: 'stable-withdrawal', status: 'unknown',
};

describe('wallet operation recovery journal', () => {
  beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

  it('retains the complete bound intent and isolates user, wallet and address identities', () => {
    saveOperation('withdrawal', intent);
    expect(readOperation('withdrawal', intent.userId, intent.walletId, intent.walletAddress)).toEqual(intent);
    expect(readOperation('withdrawal', 'user-b', intent.walletId, intent.walletAddress)).toBeNull();
    expect(readOperation('withdrawal', intent.userId, 'wallet-b', intent.walletAddress)).toBeNull();
    expect(() => readOperation('withdrawal', intent.userId, intent.walletId, intent.to)).toThrow(/identity does not match/);
    clearOperation('withdrawal', intent);
    expect(readOperation('withdrawal', intent.userId, intent.walletId, intent.walletAddress)).toBeNull();
  });

  it('does not interpret unavailable or corrupt storage as permission to create another intent', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    try {
      expect(() => readOperation('withdrawal', intent.userId, intent.walletId, intent.walletAddress)).toThrow('storage unavailable');
    } finally { getItem.mockRestore(); }
    window.localStorage.setItem('sofa-one.wallet.withdrawal.user-a.wallet-a', '{');
    expect(() => readOperation('withdrawal', intent.userId, intent.walletId, intent.walletAddress)).toThrow();
  });

  it('fails preflight when operation recovery data cannot be persisted and read back', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    try { expect(() => saveOperation('withdrawal', intent)).toThrow(/Could not retain/); }
    finally { setItem.mockRestore(); }
  });

  it('reserves a registration before send and replaces the reservation with the userOp identity', () => {
    const operation = { userId: intent.userId, walletId: intent.walletId, walletAddress: intent.walletAddress, chainId: 84532, userOpHash: null };
    saveOperation('registration', operation);
    expect(readOperation('registration', intent.userId, intent.walletId, intent.walletAddress)).toEqual(operation);
    const submitted = { ...operation, userOpHash: `0x${'a'.repeat(64)}` };
    saveOperation('registration', submitted);
    expect(readOperation('registration', intent.userId, intent.walletId, intent.walletAddress)).toEqual(submitted);
    expect(JSON.stringify(submitted)).not.toMatch(/password|proof|secret/i);
  });

  it('keeps a returned userOp hash recoverable after reload when durable storage fails after reservation', () => {
    const operation = { userId: intent.userId, walletId: intent.walletId, walletAddress: intent.walletAddress, chainId: 84532, userOpHash: null };
    saveOperation('registration', operation);
    const submitted = { ...operation, userOpHash: `0x${'b'.repeat(64)}` };
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (this === window.localStorage) throw new Error('durable storage full');
      originalSetItem.call(this, name, value);
    });
    try { expect(() => saveOperation('registration', submitted)).toThrow('durable storage full'); }
    finally { setItem.mockRestore(); }
    expect(readOperation('registration', intent.userId, intent.walletId, intent.walletAddress)).toEqual(submitted);
    clearOperation('registration', submitted);
    expect(readOperation('registration', intent.userId, intent.walletId, intent.walletAddress)).toBeNull();
  });

  it('requires registered status and a valid, future expiry', () => {
    const now = Date.now();
    const authorization = { chainId: 84532, status: 'registered', registrationTxHash: null, expiresAt: new Date(now + 1).toISOString() };
    expect(isAuthorizationReady(authorization, now)).toBe(true);
    expect(isAuthorizationReady(authorization, now + 1)).toBe(false);
    expect(isAuthorizationReady({ ...authorization, expiresAt: null }, now)).toBe(false);
    expect(isAuthorizationReady({ ...authorization, expiresAt: 'invalid' }, now)).toBe(false);
    expect(isAuthorizationReady({ ...authorization, status: 'pending_registration' }, now)).toBe(false);
  });
});
