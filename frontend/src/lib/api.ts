const _viteApiUrl: string | undefined = import.meta.env.VITE_API_URL;
if (!_viteApiUrl && import.meta.env.PROD) {
  throw new Error('VITE_API_URL must be set in production builds');
}
const API_BASE = _viteApiUrl ?? '/api';
export const DEFAULT_CHAIN_ID = 84532;

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: string[];
  path?: string;
}

export interface WalletInfo {
  walletAddress: string | null;
  embeddedWalletAddress?: string | null;
  chainId: number;
  status: string;
  supportedTokens: string[];
  agentWalletAddress?: string | null;
  agentStatus?: string | null;
  agentKeyHash?: string | null;
  agentRegistrationTxHash?: string | null;
  agentExpiresAt?: string | null;
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
  transactionHash: string | null;
  status: string;
}

export interface SignMessageRequest {
  chainId: number;
  type: 'message';
  message: string;
}

export interface SignTypedDataRequest {
  chainId: number;
  type: 'typed_data';
  typedData: Record<string, unknown>;
}

export type SignRequest = SignMessageRequest | SignTypedDataRequest;

export interface SignResponse {
  signature: string;
  walletAddress: string;
  signerAddress?: string;
  type: SignRequest['type'];
}

export interface AuthorizeEmbeddedWalletRequest {
  openfortAccessToken: string;
  embeddedWalletAddress: string;
  embeddedOpenfortAccountId?: string;
  chainId?: number;
}

export interface AuthorizeEmbeddedWalletResponse extends AuthSessionResponse {
  agentRegistration: {
    agentAddress: string;
    keyHash: string;
    expiresAt: string;
  };
}

export interface AgentRegistrationResultRequest {
  txHash: string;
  status: 'registered' | 'registration_failed';
}

export interface AgentRegistrationTransactionRequest {
  txHash: string;
}

export interface TransactionInteraction {
  to: string;
  data: string;
  value?: string;
}

export interface SendTransactionRequest {
  chainId: number;
  interactions: TransactionInteraction[];
  idempotencyKey?: string;
}

export interface SendTransactionResponse {
  transactionId: string;
  transactionHash: string | null;
  status: string;
}

export interface TransactionStatusResponse extends SendTransactionResponse {
  chainId: number;
  walletAddress: string;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
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

/**
 * Call an auth endpoint (uses Openfort IAM access token from getToken).
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

export async function syncSession(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
) {
  return authFetch<AuthSessionResponse>('/auth/session', getToken, { method: 'POST', signal });
}

/** @deprecated Use syncSession. */
export const socialLogin = syncSession;

export async function getMe(getToken: () => Promise<string | null>, signal?: AbortSignal) {
  return authFetch<AuthSessionResponse>('/auth/me', getToken, { signal });
}

export async function refreshApiKey(getToken: () => Promise<string | null>) {
  return authFetch<RefreshApiKeyResponse>('/auth/refresh-api-key', getToken, { method: 'POST' });
}

export async function authorizeEmbeddedWallet(
  getToken: () => Promise<string | null>,
  body: AuthorizeEmbeddedWalletRequest,
) {
  return authFetch<AuthorizeEmbeddedWalletResponse>('/auth/embedded-wallet/authorize', getToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function markAgentRegistrationResult(
  getToken: () => Promise<string | null>,
  body: AgentRegistrationResultRequest,
) {
  return authFetch<AuthSessionResponse>('/auth/embedded-wallet/registration-result', getToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function markAgentRegistrationTransaction(
  getToken: () => Promise<string | null>,
  body: AgentRegistrationTransactionRequest,
) {
  return authFetch<AuthSessionResponse>('/auth/embedded-wallet/registration-transaction', getToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// --- Public API-key endpoints ---

export async function signWithApiKey(apiKey: string, body: SignRequest) {
  return apiFetch<SignResponse>('/v1/wallets/sign', apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function sendTransactionWithApiKey(apiKey: string, body: SendTransactionRequest) {
  return apiFetch<SendTransactionResponse>('/v1/transactions/send', apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getTransactionStatusWithApiKey(apiKey: string, transactionId: string) {
  return apiFetch<TransactionStatusResponse>(`/v1/transactions/${transactionId}`, apiKey);
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

export async function getBalancesAuth(
  getToken: () => Promise<string | null>,
  chainId = DEFAULT_CHAIN_ID,
  signal?: AbortSignal,
) {
  return authFetch<BalancesResponse>(`/v1/wallets/balances?chainId=${chainId}`, getToken, {
    signal,
  });
}
