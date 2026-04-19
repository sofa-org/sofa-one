const API_BASE = '/api';

/** Get stored API key from localStorage. */
export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('agent_wallet_api_key');
}

/** Store API key in localStorage. */
export function setApiKey(key: string): void {
  localStorage.setItem('agent_wallet_api_key', key);
}

/** Clear stored API key. */
export function clearApiKey(): void {
  localStorage.removeItem('agent_wallet_api_key');
}

/**
 * Call an auth endpoint (uses Clerk JWT from getToken).
 */
export async function authFetch(
  path: string,
  getToken: () => Promise<string | null>,
  options?: RequestInit,
) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Call a v1 endpoint (uses stored API key).
 */
export async function apiFetch(path: string, options?: RequestInit) {
  const apiKey = getApiKey();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { 'X-API-Key': apiKey }),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

// --- Auth ---

export async function socialLogin(getToken: () => Promise<string | null>) {
  return authFetch('/auth/social', getToken, { method: 'POST' });
}

export async function refreshApiKey(getToken: () => Promise<string | null>) {
  return authFetch('/auth/refresh-api-key', getToken, { method: 'POST' });
}

// --- Wallets ---

export async function getDepositInfo() {
  return apiFetch('/v1/wallets/deposit-info', { method: 'POST' });
}

export async function withdraw(to: string, amount: string, token: string) {
  return apiFetch('/v1/wallets/withdraw', {
    method: 'POST',
    body: JSON.stringify({ to, amount, token }),
  });
}

// --- API Keys ---

export async function listApiKeys() {
  return apiFetch('/v1/api-keys');
}

export async function createApiKey(name?: string) {
  return apiFetch('/v1/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKey(id: string) {
  return apiFetch(`/v1/api-keys/${id}`, { method: 'DELETE' });
}

// --- Transactions ---

export async function getTransactionHistory(limit = 50, offset = 0) {
  return apiFetch(`/v1/transactions/history?limit=${limit}&offset=${offset}`);
}

export async function createTransactionIntent(params: {
  chainId: number;
  policyId?: string;
  interactions: Array<{
    contract: string;
    functionName: string;
    functionArgs?: string[];
  }>;
}) {
  return apiFetch('/v1/transactions/intent', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
