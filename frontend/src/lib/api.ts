const API_BASE = import.meta.env.VITE_API_URL || '/api';
export const DEFAULT_CHAIN_ID = 84532;

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: string[];
  path?: string;
}

export interface WalletInfo {
  walletAddress: string;
  chainId: number;
  status: string;
  supportedTokens: string[];
}

export interface AuthSessionResponse {
  userId: string;
  wallet: WalletInfo;
  apiKey?: string;
}

export interface RefreshApiKeyResponse {
  apiKey: string;
}

export interface BalanceEntry {
  token: string;
  raw: string | null;
  formatted: string | null;
  contractAddress?: string;
  error?: string;
}

export interface BalanceChain {
  chainId: number;
  chainName?: string;
  balances: BalanceEntry[];
}

export interface BalancesResponse {
  walletAddress: string;
  chains: BalanceChain[];
}

export interface WithdrawResponse {
  transactionId: string;
  intentId: string | null;
  status: string;
}

export interface ApiKeyRecord {
  id: string;
  keyPrefix: string;
  name: string | null;
  revoked: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  allowedChains: number[];
}

export interface CreateApiKeyResponse {
  rawKey: string;
}

export type PolicyRuleAction = 'accept' | 'reject';
export type PolicyRuleOperation =
  | 'signEvmTransaction'
  | 'sendEvmTransaction'
  | 'signEvmMessage'
  | 'signEvmTypedData'
  | 'signEvmHash'
  | 'sponsorEvmTransaction';

export type CriterionType =
  | 'ethValue'
  | 'evmAddress'
  | 'evmNetwork'
  | 'evmData'
  | 'evmMessage'
  | 'evmTypedDataVerifyingContract'
  | 'evmTypedDataField';

export type CriterionInput = Record<string, unknown> & { type: CriterionType };

export interface PolicyRuleInput {
  action: PolicyRuleAction;
  operation: PolicyRuleOperation;
  criteria?: CriterionInput[];
}

export interface PolicyRule extends PolicyRuleInput {}

export interface Policy {
  id: string;
  scope: 'account' | string;
  description?: string;
  enabled: boolean;
  deleted: boolean;
  rules?: PolicyRule[];
  createdAt: number;
}

export interface CreatePolicyRequest {
  scope: 'account';
  description?: string;
  enabled?: boolean;
  rules?: PolicyRuleInput[];
}

export interface CreatePolicyResponse extends Policy {
  id: string;
}

type DataEnvelope<T> = { data: T };
type MaybeDataEnvelope<T> = T | DataEnvelope<T>;

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

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function throwApiError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  throw new ApiError(response, body);
}

function unwrapData<T>(response: MaybeDataEnvelope<T>): T {
  if (response && typeof response === 'object' && 'data' in response) {
    return (response as DataEnvelope<T>).data;
  }
  return response as T;
}

/**
 * Call an auth endpoint (uses Clerk JWT from getToken).
 */
export async function authFetch<T>(
  path: string,
  getToken: () => Promise<string | null>,
  options?: RequestInit,
): Promise<T> {
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
  return readJson<T>(res);
}

/**
 * Call a v1 endpoint (uses explicit API key — never stored in browser storage).
 */
export async function apiFetch<T>(path: string, apiKey: string, options?: RequestInit): Promise<T> {
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
  return readJson<T>(res);
}

// --- Auth ---

export async function socialLogin(getToken: () => Promise<string | null>) {
  return authFetch<AuthSessionResponse>('/auth/social', getToken, { method: 'POST' });
}

export async function getMe(getToken: () => Promise<string | null>) {
  return authFetch<AuthSessionResponse>('/auth/me', getToken);
}

export async function refreshApiKey(getToken: () => Promise<string | null>) {
  return authFetch<RefreshApiKeyResponse>('/auth/refresh-api-key', getToken, { method: 'POST' });
}

// --- Wallets ---

export async function getDepositInfo(apiKey: string, chainId = DEFAULT_CHAIN_ID) {
  return apiFetch<{ walletAddress: string; chainId: number }>('/v1/wallets/deposit-info', apiKey, {
    method: 'POST',
    body: JSON.stringify({ chainId }),
  });
}

export async function withdraw(
  apiKey: string,
  to: string,
  amount: string,
  token: string,
  chainId = DEFAULT_CHAIN_ID,
) {
  return apiFetch<WithdrawResponse>('/v1/wallets/withdraw', apiKey, {
    method: 'POST',
    body: JSON.stringify({ chainId, to, amount, token, idempotencyKey: crypto.randomUUID() }),
  });
}

// --- API Keys ---

export async function listApiKeys(apiKey: string) {
  return apiFetch<ApiKeyRecord[]>('/v1/api-keys', apiKey);
}

export async function createApiKey(apiKey: string, name: string) {
  return apiFetch<CreateApiKeyResponse>('/v1/api-keys', apiKey, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKey(apiKey: string, id: string) {
  return apiFetch<void>(`/v1/api-keys/${id}`, apiKey, { method: 'DELETE' });
}

// --- Dashboard API (JWT-authenticated) ---

export async function listApiKeysAuth(getToken: () => Promise<string | null>) {
  return authFetch<ApiKeyRecord[]>('/v1/api-keys', getToken);
}

export async function createApiKeyAuth(
  getToken: () => Promise<string | null>,
  name: string,
  allowedChains?: number[],
) {
  return authFetch<CreateApiKeyResponse>('/v1/api-keys', getToken, {
    method: 'POST',
    body: JSON.stringify({ name, allowedChains }),
  });
}

export async function revokeApiKeyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch<void>(`/v1/api-keys/${id}`, getToken, { method: 'DELETE' });
}

export async function withdrawAuth(
  getToken: () => Promise<string | null>,
  to: string,
  amount: string,
  token: string,
  chainId = DEFAULT_CHAIN_ID,
) {
  return authFetch<WithdrawResponse>('/v1/wallets/withdraw', getToken, {
    method: 'POST',
    body: JSON.stringify({ chainId, to, amount, token, idempotencyKey: crypto.randomUUID() }),
  });
}

export async function getBalancesAuth(getToken: () => Promise<string | null>, chainId = DEFAULT_CHAIN_ID) {
  return authFetch<BalancesResponse>(`/v1/wallets/balances?chainId=${chainId}`, getToken);
}

// --- Policies ---

export async function listPoliciesAuth(getToken: () => Promise<string | null>) {
  const response = await authFetch<MaybeDataEnvelope<Policy[]>>('/v1/policies', getToken);
  return unwrapData(response);
}

export async function createPolicyAuth(getToken: () => Promise<string | null>, body: CreatePolicyRequest) {
  return authFetch<CreatePolicyResponse>('/v1/policies', getToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deletePolicyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch<void>(`/v1/policies/${id}`, getToken, { method: 'DELETE' });
}

export async function enablePolicyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch<Policy>(`/v1/policies/${id}/enable`, getToken, { method: 'POST' });
}

export async function disablePolicyAuth(getToken: () => Promise<string | null>, id: string) {
  return authFetch<Policy>(`/v1/policies/${id}/disable`, getToken, { method: 'POST' });
}

export async function listPolicyRulesAuth(getToken: () => Promise<string | null>, policyId: string) {
  const response = await authFetch<MaybeDataEnvelope<PolicyRule[]>>(
    `/v1/policies/${policyId}/rules`,
    getToken,
  );
  return unwrapData(response);
}

export async function createPolicyRuleAuth(
  getToken: () => Promise<string | null>,
  policyId: string,
  body: PolicyRuleInput,
) {
  return authFetch<PolicyRule>(`/v1/policies/${policyId}/rules`, getToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deletePolicyRuleAuth(
  getToken: () => Promise<string | null>,
  policyId: string,
  ruleIndex: number,
) {
  return authFetch<void>(`/v1/policies/${policyId}/rules/${ruleIndex}`, getToken, {
    method: 'DELETE',
  });
}
