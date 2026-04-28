const API_BASE = import.meta.env.VITE_API_URL || '/api';
export const DEFAULT_CHAIN_ID = 84532;

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: string[];
  path?: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: string[];
  readonly path?: string;

  constructor(response: Response, body: ApiErrorBody) {
    super(formatApiErrorMessage(response.status, body));
    this.name = 'ApiError';
    this.statusCode = body.statusCode ?? response.status;
    this.code = body.code ?? `HTTP_${response.status}`;
    this.details = body.details ?? [];
    this.path = body.path;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function hasApiErrorCode(error: unknown, ...codes: string[]) {
  return isApiError(error) && codes.includes(error.code);
}

export function getApiErrorMessage(error: unknown) {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatApiErrorMessage(status: number, body: ApiErrorBody) {
  const code = body.code;
  const fallback = body.message || `Request failed: ${status}`;
  const details = body.details?.filter(Boolean) ?? [];

  const message = code ? friendlyErrorMessage(code, fallback) : fallback;
  if (!details.length) return message;
  return `${message} ${details.join(' ')}`;
}

function friendlyErrorMessage(code: string, fallback: string) {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Please check the request fields.';
    case 'INVALID_API_KEY':
      return 'The API key is invalid or no longer active.';
    case 'API_KEY_REQUIRED':
    case 'AUTHENTICATION_REQUIRED':
      return 'Authentication is required. Sign in again or provide a valid API key.';
    case 'CHAIN_NOT_ALLOWED':
      return 'This key is not allowed to use the selected chain.';
    case 'CHAIN_NOT_SUPPORTED':
      return 'The selected chain is not supported.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'This idempotency key was already used with a different request.';
    case 'WALLET_NOT_FOUND':
      return 'Wallet not found. Sign in again to finish wallet setup.';
    case 'TRANSACTION_NOT_FOUND':
      return 'Transaction not found, or this key does not have access to it.';
    case 'POLICY_NOT_FOUND':
      return 'Policy not found.';
    case 'WALLET_NOT_ACTIVE':
      return 'Wallet is not active yet. Try again shortly.';
    case 'IP_NOT_ALLOWED':
      return 'This request is blocked by the API key IP allowlist.';
    default:
      return fallback;
  }
}

async function throwApiError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  throw new ApiError(response, body);
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
    await throwApiError(res);
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
    await throwApiError(res);
  }
  return res.json();
}

// --- Auth ---

export async function socialLogin(getToken: () => Promise<string | null>) {
  return authFetch('/auth/social', getToken, { method: 'POST' });
}

export async function getMe(getToken: () => Promise<string | null>) {
  return authFetch('/auth/me', getToken);
}

export async function refreshApiKey(getToken: () => Promise<string | null>) {
  return authFetch('/auth/refresh-api-key', getToken, { method: 'POST' });
}

// --- Wallets ---

export async function getDepositInfo(apiKey: string, chainId = DEFAULT_CHAIN_ID) {
  return apiFetch('/v1/wallets/deposit-info', apiKey, {
    method: 'POST',
    body: JSON.stringify({ chainId }),
  });
}

export async function withdraw(apiKey: string, to: string, amount: string, token: string, chainId = DEFAULT_CHAIN_ID) {
  return apiFetch('/v1/wallets/withdraw', apiKey, {
    method: 'POST',
    body: JSON.stringify({ chainId, to, amount, token, idempotencyKey: crypto.randomUUID() }),
  });
}

// --- API Keys ---

export async function listApiKeys(apiKey: string) {
  return apiFetch('/v1/api-keys', apiKey);
}

export async function createApiKey(apiKey: string, name: string) {
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

export async function createApiKeyAuth(getToken: () => Promise<string | null>, name: string, allowedChains?: number[]) {
  return authFetch('/v1/api-keys', getToken, {
    method: 'POST',
    body: JSON.stringify({ name, allowedChains }),
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
  chainId = DEFAULT_CHAIN_ID,
) {
  return authFetch('/v1/wallets/withdraw', getToken, {
    method: 'POST',
    body: JSON.stringify({ chainId, to, amount, token, idempotencyKey: crypto.randomUUID() }),
  });
}

export async function getBalancesAuth(getToken: () => Promise<string | null>, chainId = DEFAULT_CHAIN_ID) {
  return authFetch(`/v1/wallets/balances?chainId=${chainId}`, getToken);
}

// --- Policies ---
export async function listPoliciesAuth(getToken: () => Promise<string | null>) {
  return authFetch('/v1/policies', getToken);
}
export async function createPolicyAuth(getToken: () => Promise<string | null>, body: { scope: string; description?: string; enabled?: boolean; rules?: any[] }) {
  return authFetch('/v1/policies', getToken, { method: 'POST', body: JSON.stringify(body) });
}
export async function deletePolicyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch(`/v1/policies/${id}`, getToken, { method: 'DELETE' });
}
export async function enablePolicyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch(`/v1/policies/${id}/enable`, getToken, { method: 'POST' });
}
export async function disablePolicyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch(`/v1/policies/${id}/disable`, getToken, { method: 'POST' });
}
export async function listPolicyRulesAuth(getToken: () => Promise<string | null>, policyId: string) {
  return authFetch(`/v1/policies/${policyId}/rules`, getToken);
}
export async function createPolicyRuleAuth(
  getToken: () => Promise<string | null>,
  policyId: string,
  body: { action: 'accept' | 'reject'; operation: string; criteria?: Record<string, unknown>[] },
) {
  return authFetch(`/v1/policies/${policyId}/rules`, getToken, { method: 'POST', body: JSON.stringify(body) });
}
export async function deletePolicyRuleAuth(getToken: () => Promise<string | null>, policyId: string, ruleIndex: number) {
  return authFetch(`/v1/policies/${policyId}/rules/${ruleIndex}`, getToken, { method: 'DELETE' });
}
