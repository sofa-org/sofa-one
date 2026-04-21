const API_BASE = import.meta.env.VITE_API_URL || '/api';

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
 * Call a v1 endpoint (uses explicit API key — never stored in browser storage).
 */
export async function apiFetch(path: string, apiKey: string, options?: RequestInit) {
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

export async function getDepositInfo(apiKey: string) {
  return apiFetch('/v1/wallets/deposit-info', apiKey, { method: 'POST' });
}

export async function withdraw(apiKey: string, to: string, amount: string, token: string) {
  return apiFetch('/v1/wallets/withdraw', apiKey, {
    method: 'POST',
    body: JSON.stringify({ to, amount, token }),
  });
}

// --- API Keys ---

export async function listApiKeys(apiKey: string) {
  return apiFetch('/v1/api-keys', apiKey);
}

export async function createApiKey(apiKey: string, name?: string) {
  return apiFetch('/v1/api-keys', apiKey, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKey(apiKey: string, id: string) {
  return apiFetch(`/v1/api-keys/${id}`, apiKey, { method: 'DELETE' });
}

// --- Dashboard API (JWT-authenticated) ---

export async function listApiKeysAuth(getToken: () => Promise<string | null>) {
  return authFetch('/v1/api-keys', getToken);
}

export async function createApiKeyAuth(getToken: () => Promise<string | null>, name?: string) {
  return authFetch('/v1/api-keys', getToken, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKeyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch(`/v1/api-keys/${id}`, getToken, { method: 'DELETE' });
}

export async function withdrawAuth(
  getToken: () => Promise<string | null>,
  to: string,
  amount: string,
  token: string,
) {
  return authFetch('/v1/wallets/withdraw', getToken, {
    method: 'POST',
    body: JSON.stringify({ to, amount, token }),
  });
}
