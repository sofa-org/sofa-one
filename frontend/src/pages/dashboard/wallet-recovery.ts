import type { WalletInfo, WithdrawalToken } from '@/lib/api';

export type WithdrawalIntent = {
  userId: string;
  walletId: string;
  walletAddress: string;
  chainId: number;
  to: string;
  token: WithdrawalToken;
  amount: string;
  displayAmount: string;
  idempotencyKey: string;
  transactionId?: string;
  transactionHash?: string | null;
  status: string;
};

export type RegistrationOperation = {
  userId: string;
  walletId: string;
  walletAddress: string;
  chainId: number;
  userOpHash: string | null;
  txHash?: string;
};

type Operation = WithdrawalIntent | RegistrationOperation;
type Kind = 'withdrawal' | 'registration';
const key = (kind: Kind, userId: string, walletId: string) =>
  `sofa-one.wallet.${kind}.${encodeURIComponent(userId)}.${encodeURIComponent(walletId)}`;

// Fail closed: an unreadable journal must not be treated as an empty journal.
export function readOperation<T extends Operation>(kind: Kind, userId: string, walletId: string, walletAddress: string): T | null {
  const storageKey = key(kind, userId, walletId);
  let value: string | null = null;
  let storageFailure: unknown;
  try { value = window.localStorage.getItem(storageKey); }
  catch (error) { storageFailure = error; }
  if (kind === 'registration') {
    try { value = window.sessionStorage.getItem(storageKey) ?? value; }
    catch (error) { if (!value) storageFailure = error; }
  }
  if (!value) {
    if (storageFailure) throw storageFailure;
    return null;
  }
  const operation = JSON.parse(value) as T;
  if (operation.userId !== userId || operation.walletId !== walletId ||
      operation.walletAddress.toLowerCase() !== walletAddress.toLowerCase() || !Number.isInteger(operation.chainId)) {
    throw new Error('Saved wallet operation identity does not match. Contact support before submitting again.');
  }
  if (kind === 'withdrawal') {
    const withdrawal = operation as WithdrawalIntent;
    if (!withdrawal.idempotencyKey || !/^0x[0-9a-fA-F]{40}$/.test(withdrawal.to) ||
        !/^[0-9]+$/.test(withdrawal.amount) || !['USDC', 'USDT', 'NATIVE'].includes(withdrawal.token) ||
        typeof withdrawal.status !== 'string') {
      throw new Error('Saved withdrawal recovery data is invalid. Contact support before submitting again.');
    }
  } else if (!('userOpHash' in operation) || (operation.userOpHash !== null && typeof operation.userOpHash !== 'string')) {
    throw new Error('Saved registration recovery data is invalid. Contact support before authorizing again.');
  }
  return operation;
}

export function saveOperation(kind: Kind, operation: Operation) {
  const storageKey = key(kind, operation.userId, operation.walletId);
  const serialized = JSON.stringify(operation);
  // A pre-send reservation must survive closing the tab. A same-tab backup is
  // useful only after a returned hash cannot be saved to the durable journal.
  if (kind === 'registration' && 'userOpHash' in operation && operation.userOpHash === null) {
    window.sessionStorage.removeItem(storageKey);
  }
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) {
      throw new Error('Could not retain wallet operation recovery data. Do not submit another operation.');
    }
    if (kind === 'registration') {
      try { window.sessionStorage.removeItem(storageKey); } catch { /* Primary journal is durable. */ }
    }
  } catch (error) {
    if (kind === 'registration' && 'userOpHash' in operation && operation.userOpHash) {
      try { window.sessionStorage.setItem(storageKey, serialized); } catch { /* Caller retains and displays the hash. */ }
    }
    throw error;
  }
}

export function clearOperation(kind: Kind, operation: Operation) {
  const storageKey = key(kind, operation.userId, operation.walletId);
  window.localStorage.removeItem(storageKey);
  if (kind === 'registration') window.sessionStorage.removeItem(storageKey);
}

export function isAuthorizationReady(authorization: WalletInfo['chainAuthorizations'][number] | null | undefined, now = Date.now()) {
  return authorization?.status === 'registered' && typeof authorization.expiresAt === 'string' &&
    new Date(authorization.expiresAt).getTime() > now;
}

export function isWithdrawalTerminal(status: string) {
  return status === 'confirmed' || status === 'failed';
}
