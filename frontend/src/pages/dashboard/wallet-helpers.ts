import type { Address } from 'viem';
import { SUPPORTED_CHAINS } from '@/lib/chains';

export type OpenfortGasPriceResponse = {
  result?: {
    fast?: { maxFeePerGas?: string | number; maxPriorityFeePerGas?: string | number };
    standard?: { maxFeePerGas?: string | number; maxPriorityFeePerGas?: string | number };
    maxFeePerGas?: string | number;
    maxPriorityFeePerGas?: string | number;
  };
  error?: { message?: string };
};

export type WithdrawSuccess = {
  message: string;
  transactionHash: string | null;
  chainId: number;
};

export const AUTHORIZE_EMBEDDED_WALLET_RETRIES = 5;
export const AUTHORIZE_EMBEDDED_WALLET_RETRY_DELAY_MS = 1_000;
export const AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS = 60_000;
export const AGENT_REGISTRATION_RESULT_RETRY_DELAY_MS = 3_000;
export const AGENT_REGISTRATION_AUTO_CHECK_MS = 120_000;
export const AGENT_REGISTRATION_MANUAL_CHECK_MS = 60_000;
export const AGENT_AUTHORIZATION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RAW_KEY_NOTICE_TTL_MS = 2 * 60 * 1000;
export const BALANCE_CHAIN_STORAGE_KEY = 'sofa-one.wallet.balanceChainId';
export const AGENT_CHAIN_STORAGE_KEY = 'sofa-one.wallet.agentChainId';

export function parseStablecoinAmount(input: string, token: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) {
    throw new Error(`Enter a valid ${token} amount (e.g. 1.50)`);
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const frac = fracPart.padEnd(6, '0');
  const baseUnits = BigInt(intPart) * 1_000_000n + BigInt(frac);
  return baseUnits.toString();
}

export function parseNativeAmount(input: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(trimmed)) {
    throw new Error('Enter a valid native token amount (e.g. 0.01)');
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const frac = fracPart.padEnd(18, '0');
  const baseUnits = BigInt(intPart) * 1_000_000_000_000_000_000n + BigInt(frac);
  return baseUnits.toString();
}

export function parseWithdrawalAmount(input: string, token: string): string {
  return token === 'NATIVE' ? parseNativeAmount(input) : parseStablecoinAmount(input, token);
}

export function parseRpcBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return BigInt(text);
  if (/^\d+$/.test(text)) return BigInt(text);
  return null;
}

export async function getOpenfortUserOperationGasPrice(openfortRpcUrl: string, publishableKey: string) {
  const response = await fetch(openfortRpcUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${publishableKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'openfort_getUserOperationGasPrice',
      params: [],
    }),
  });
  if (!response.ok) {
    throw new Error('Unable to estimate UserOperation fee parameters from Openfort RPC.');
  }

  const payload = (await response.json()) as OpenfortGasPriceResponse;
  if (payload.error) {
    throw new Error(
      payload.error.message ?? 'Unable to estimate UserOperation fee parameters from Openfort RPC.',
    );
  }

  const candidate = payload.result?.fast ?? payload.result?.standard ?? payload.result;
  const maxFeePerGas = parseRpcBigInt(candidate?.maxFeePerGas);
  const maxPriorityFeePerGas = parseRpcBigInt(candidate?.maxPriorityFeePerGas);
  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    throw new Error('Unable to estimate UserOperation fee parameters from Openfort RPC.');
  }

  return { maxFeePerGas, maxPriorityFeePerGas };
}

export function resolveEmbeddedWallet(
  createdAccount: unknown,
  embeddedWallet: { address?: Address; activeWallet?: unknown; wallets?: unknown[] },
  refreshedAccounts?: unknown[],
): { address: Address; accountId?: string } {
  const created = createdAccount as
    | { id?: string; address?: Address; accounts?: Array<{ id?: string; address?: Address }> }
    | undefined;
  const active = embeddedWallet.activeWallet as
    | { id?: string; address?: Address; accountId?: string; accounts?: Array<{ id?: string }> }
    | undefined;
  const firstWallet = embeddedWallet.wallets?.[0] as
    | { id?: string; address?: Address; accountId?: string; accounts?: Array<{ id?: string }> }
    | undefined;
  const firstRefreshed = refreshedAccounts?.[0] as
    | { id?: string; address?: Address; accountId?: string; accounts?: Array<{ id?: string }> }
    | undefined;
  const address =
    created?.address ??
    embeddedWallet.address ??
    active?.address ??
    firstWallet?.address ??
    firstRefreshed?.address;

  if (!address) {
    throw new Error('EOA address was not returned by Openfort.');
  }

  return {
    address,
    accountId:
      active?.accountId ??
      active?.accounts?.[0]?.id ??
      created?.accounts?.[0]?.id ??
      created?.id ??
      firstWallet?.accountId ??
      firstWallet?.accounts?.[0]?.id ??
      firstWallet?.id ??
      firstRefreshed?.accountId ??
      firstRefreshed?.accounts?.[0]?.id ??
      firstRefreshed?.id,
  };
}

export function formatAgentStatus(status?: string | null) {
  if (status === 'registered') return 'success';
  if (status === 'registration_failed') return 'failed';
  if (status === 'registration_required') return 'action required';
  if (status === 'pending_registration') return 'checking';
  return status ?? 'not registered';
}

export function formatDateTimeLocal(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function getDefaultAgentExpiryLocal() {
  return formatDateTimeLocal(new Date(Date.now() + AGENT_AUTHORIZATION_MAX_TTL_MS));
}

export function getMaxAgentExpiryLocal() {
  return formatDateTimeLocal(new Date(Date.now() + AGENT_AUTHORIZATION_MAX_TTL_MS));
}

export function assertWebCryptoAvailable() {
  if (globalThis.crypto?.subtle) return;
  throw new Error(
    'Secure browser crypto is not available. Open this app over HTTPS or localhost before creating an EOA.',
  );
}

export function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isSupportedChainId(chainId: number) {
  return SUPPORTED_CHAINS.some((chain) => chain.id === chainId);
}

export function getChainDisplayName(chainId: number) {
  return SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.name ?? `Chain ${chainId}`;
}

export function getAuthorizationBadgeClasses(status: string) {
  if (status === 'registered') return 'border-green-200 bg-green-50 text-green-800';
  if (status === 'registration_failed') return 'border-red-200 bg-red-50 text-red-800';
  if (status === 'pending_registration') return 'border-blue-200 bg-blue-50 text-blue-800';
  return 'border-amber-200 bg-amber-50 text-amber-800';
}

export function getStoredChainId(storageKey: string, defaultChainId: number) {
  if (typeof window === 'undefined') return defaultChainId;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return defaultChainId;

    const chainId = Number(stored);
    return Number.isInteger(chainId) && isSupportedChainId(chainId) ? chainId : defaultChainId;
  } catch {
    return defaultChainId;
  }
}

export function persistChainId(storageKey: string, chainId: number) {
  try {
    window.localStorage.setItem(storageKey, String(chainId));
  } catch {
    // Ignore storage failures so private browsing or disabled storage does not block wallet use.
  }
}

export function formatAuthorizationExpiry(
  expiresAt: string | null | undefined,
): { absoluteLabel: string; relativeLabel: string; tone: 'red' | 'amber' | 'green' } | null {
  if (!expiresAt) return null;

  const expiry = new Date(expiresAt);
  const expiryTime = expiry.getTime();
  if (Number.isNaN(expiryTime)) return null;

  const timeRemainingMs = expiryTime - Date.now();
  const absoluteLabel = expiry.toLocaleString();
  if (timeRemainingMs <= 0) {
    return { absoluteLabel, relativeLabel: 'Expired', tone: 'red' };
  }

  const hoursRemaining = Math.ceil(timeRemainingMs / (60 * 60 * 1000));
  const relativeLabel =
    hoursRemaining < 48
      ? `${hoursRemaining}h remaining`
      : `${Math.ceil(hoursRemaining / 24)}d remaining`;

  const tone: 'amber' | 'green' = hoursRemaining <= 72 ? 'amber' : 'green';

  return {
    absoluteLabel,
    relativeLabel,
    tone,
  };
}
