const _viteApiUrl: string | undefined = import.meta.env.VITE_API_URL;
if (!_viteApiUrl && import.meta.env.PROD) {
  throw new Error(
    'VITE_API_URL must be set in production builds to the deployed SOFA ONE API base URL, for example https://api.example.com.',
  );
}
const API_BASE = _viteApiUrl ?? '/api';
export const DEFAULT_CHAIN_ID = 84532;

export function getApiBaseUrlForDisplay(origin = window.location.origin) {
  const normalizedBase = API_BASE.replace(/\/$/, '');
  if (/^https?:\/\//i.test(normalizedBase)) return normalizedBase;

  const path = normalizedBase.startsWith('/') ? normalizedBase : `/${normalizedBase}`;
  return `${origin}${path}`;
}

export function getApiBaseUrlModeLabel() {
  return _viteApiUrl ? 'Configured API URL' : 'Vite proxy';
}

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: string[];
  requestId?: string;
  path?: string;
}

export interface WalletInfo {
  walletAddress: string | null;
  status: string;
  agentWalletAddress?: string | null;
  agentKeyHash?: string | null;
  chainAuthorizations: Array<{
    chainId: number;
    status: string;
    registrationTxHash: string | null;
    expiresAt: string | null;
  }>;
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
  formatted: string | null;
  error?: string;
}

export interface BalanceChain {
  chainId: number;
  chainName?: string;
  balances: BalanceEntry[];
}

export interface BalancesResponse {
  chains: BalanceChain[];
}

export interface WithdrawResponse {
  transactionId: string;
  transactionHash: string | null;
  status: string;
}

export interface WithdrawalAddressRecord {
  id: string;
  address: string;
  label: string | null;
  availableAt: string;
  createdAt: string;
  isAvailable: boolean;
}

export interface ListWithdrawalAddressesResponse {
  policy: {
    requireAddressAllowlist: boolean;
    newAddressCooldownHours: number;
  };
  addresses: WithdrawalAddressRecord[];
}

export interface SignMessageRequest {
  chainId: number;
  type: 'message';
  message: string;
}

export interface SignTypedDataRequest {
  chainId?: number;
  type: 'typed_data';
  typedData: Record<string, unknown>;
}

export type SignRequest = SignMessageRequest | SignTypedDataRequest;

export interface SignResponse {
  signature: string;
  walletAddress: string;
  type: SignRequest['type'];
}

export interface AuthorizeEmbeddedWalletRequest {
  embeddedWalletAddress: string;
  embeddedOpenfortAccountId?: string;
  chainId?: number;
  agentExpiresAt?: string;
}

export type AuthorizeEmbeddedWalletResponse = AuthSessionResponse;

export interface AgentRegistrationResultRequest {
  chainId: number;
  txHash: string;
  status: 'registered' | 'registration_failed';
}

export interface AgentRegistrationTransactionRequest {
  chainId: number;
  txHash: string;
}

export interface TransactionInteraction {
  to: string;
  data: string;
  value?: string;
}

export interface SendTransactionRequest {
  chainId: number;
  executionMode?: 'session_key' | 'eoa';
  sponsorship?: 'required' | 'none';
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
  displayPrefix: string;
  name: string | null;
  revoked: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  lastUsedUserAgent: string | null;
  permissions: ApiKeyPermissions;
  allowedContracts: string[];
  allowedFunctionSelectors: string[];
  dailySpendLimit: string | null;
  monthlySpendLimit: string | null;
}

export interface ApiKeyPermissions {
  canSign: boolean;
  canSendTransaction: boolean;
  canReadTransactionStatus: boolean;
  canUseEoaExecution: boolean;
}

export interface CreateApiKeyResponse {
  rawKey: string;
  id: string;
  displayPrefix: string;
  name: string;
  expiresAt: string;
  createdAt: string;
  permissions: ApiKeyPermissions;
}

export interface ApiKeySpendLimits {
  daily?: string;
  monthly?: string;
}

export interface CreateApiKeyRequest {
  name: string;
  allowedIps?: string[];
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
  spendLimits?: ApiKeySpendLimits;
  permissions?: Partial<ApiKeyPermissions>;
}

export interface StepUpChallengeResponse {
  challengeId: string;
  code?: string;
}

export interface StepUpVerifyResponse {
  proofToken: string;
  expiresAt: string;
}

export interface SecurityNotificationRecord {
  id: string;
  type: string;
  title: string;
  body: string;
  riskLevel: string;
  readAt: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: string[];
  readonly requestId?: string;
  readonly path?: string;

  constructor(response: Response, body: ApiErrorBody) {
    super(formatApiErrorMessage(response.status, body));
    this.name = 'ApiError';
    this.statusCode = body.statusCode ?? response.status;
    this.code = body.code ?? `HTTP_${response.status}`;
    this.details = body.details ?? [];
    this.requestId = body.requestId;
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
  if (isApiError(error)) {
    return error.requestId ? `${error.message} Request ID: ${error.requestId}` : error.message;
  }
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
    case 'AGENT_REGISTRATION_PENDING':
      return 'Agent registration is still syncing on-chain. Try again shortly.';
    case 'IP_NOT_ALLOWED':
      return 'This request is blocked by the API key IP allowlist.';
    default:
      return fallback;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

async function throwApiError(response: Response): Promise<never> {
  const body = await readApiErrorBody(response);
  throw new ApiError(response, body);
}

async function readApiErrorBody(response: Response): Promise<ApiErrorBody> {
  const text = await response.text();
  if (!text.trim()) {
    return { message: response.statusText || `Request failed: ${response.status}` };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ApiErrorBody;
    }
  } catch {
    // Fall through to plain-text error handling.
  }

  return { message: text };
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
  if (!token) {
    throw new Error('Openfort session is not ready. Refresh and sign in again.');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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

export async function createStepUpChallengeAuth(getToken: () => Promise<string | null>) {
  return authFetch<StepUpChallengeResponse>('/v1/auth/step-up/challenge', getToken, {
    method: 'POST',
    body: JSON.stringify({ type: 'email_otp' }),
  });
}

export async function verifyStepUpChallengeAuth(
  getToken: () => Promise<string | null>,
  challengeId: string,
  code: string,
) {
  return authFetch<StepUpVerifyResponse>('/v1/auth/step-up/verify', getToken, {
    method: 'POST',
    body: JSON.stringify({ challengeId, code }),
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
  request: CreateApiKeyRequest,
  stepUpToken?: string,
) {
  return authFetch<CreateApiKeyResponse>('/v1/api-keys', getToken, {
    method: 'POST',
    headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
    body: JSON.stringify(request),
  });
}

export async function revokeApiKeyAuth(
  getToken: () => Promise<string | null>,
  id: string,
  stepUpToken?: string,
) {
  return authFetch<void>(`/v1/api-keys/${id}`, getToken, {
    method: 'DELETE',
    headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
  });
}

export async function revokeAllApiKeysAuth(
  getToken: () => Promise<string | null>,
  stepUpToken?: string,
) {
  return authFetch<{ success: boolean; revokedCount: number }>('/v1/api-keys', getToken, {
    method: 'DELETE',
    headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
  });
}

export async function listSecurityNotificationsAuth(
  getToken: () => Promise<string | null>,
  params?: { unreadOnly?: boolean; limit?: number },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (params?.unreadOnly) query.set('unreadOnly', 'true');
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return authFetch<SecurityNotificationRecord[]>(
    `/v1/security-notifications${qs ? `?${qs}` : ''}`,
    getToken,
    { signal },
  );
}

export async function markSecurityNotificationReadAuth(
  getToken: () => Promise<string | null>,
  notificationId: string,
) {
  return authFetch<{ success: boolean; updatedCount: number }>(
    `/v1/security-notifications/${notificationId}/read`,
    getToken,
    { method: 'POST' },
  );
}

export async function markAllSecurityNotificationsReadAuth(getToken: () => Promise<string | null>) {
  return authFetch<{ success: boolean; updatedCount: number }>(
    '/v1/security-notifications/read-all',
    getToken,
    { method: 'POST' },
  );
}

export async function withdrawAuth(
  getToken: () => Promise<string | null>,
  to: string,
  amount: string,
  token: string,
  chainId = DEFAULT_CHAIN_ID,
  stepUpToken?: string,
) {
  return authFetch<WithdrawResponse>('/v1/wallets/withdraw', getToken, {
    method: 'POST',
    headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
    body: JSON.stringify({ chainId, to, amount, token, idempotencyKey: crypto.randomUUID() }),
  });
}

export async function listWithdrawalAddressesAuth(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
) {
  return authFetch<ListWithdrawalAddressesResponse>('/v1/wallets/withdrawal-addresses', getToken, {
    signal,
  });
}

export async function addWithdrawalAddressAuth(
  getToken: () => Promise<string | null>,
  body: { address: string; label?: string },
  stepUpToken?: string,
) {
  return authFetch<WithdrawalAddressRecord>('/v1/wallets/withdrawal-addresses', getToken, {
    method: 'POST',
    headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
    body: JSON.stringify(body),
  });
}

export async function removeWithdrawalAddressAuth(
  getToken: () => Promise<string | null>,
  id: string,
  stepUpToken?: string,
) {
  return authFetch<{ success: boolean }>(`/v1/wallets/withdrawal-addresses/${id}`, getToken, {
    method: 'DELETE',
    headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
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

// --- Transaction & Signing Request History (dashboard-only) ---

export interface TransactionListItem {
  id: string;
  status: string;
  txHash: string | null;
  chainId: number;
  walletAddress: string;
  operationType: string;
  apiKeyPrefix: string | null;
  apiKeyName: string | null;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

export interface ListTransactionsResponse {
  items: TransactionListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ListTransactionsParams {
  status?: string;
  chainId?: number;
  page?: number;
  limit?: number;
}

export async function listTransactionsAuth(
  getToken: () => Promise<string | null>,
  params?: ListTransactionsParams,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.chainId) query.set('chainId', String(params.chainId));
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return authFetch<ListTransactionsResponse>(`/v1/transactions${qs ? `?${qs}` : ''}`, getToken, { signal });
}

export interface SigningRequestListItem {
  id: string;
  type: string;
  chainId: number | null;
  walletAddress: string;
  status: string;
  apiKeyPrefix: string | null;
  apiKeyName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ListSigningRequestsResponse {
  items: SigningRequestListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ListSigningRequestsParams {
  type?: string;
  status?: string;
  chainId?: number;
  page?: number;
  limit?: number;
}

export async function listSigningRequestsAuth(
  getToken: () => Promise<string | null>,
  params?: ListSigningRequestsParams,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (params?.type) query.set('type', params.type);
  if (params?.status) query.set('status', params.status);
  if (params?.chainId) query.set('chainId', String(params.chainId));
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return authFetch<ListSigningRequestsResponse>(`/v1/wallets/signing-requests${qs ? `?${qs}` : ''}`, getToken, { signal });
}

// --- Transaction & Signing Request Detail (dashboard-only) ---

export interface TransactionDetail {
  id: string;
  status: string;
  txHash: string | null;
  chainId: number;
  walletAddress: string;
  operationType: string;
  authMethod: string;
  apiKeyPrefix: string | null;
  apiKeyName: string | null;
  idempotencyKey: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  withdrawal: { to: string | null; amount: string | null; token: string | null } | null;
}

export async function getTransactionDetailAuth(
  getToken: () => Promise<string | null>,
  transactionId: string,
  signal?: AbortSignal,
) {
  return authFetch<TransactionDetail>(`/v1/transactions/${transactionId}/detail`, getToken, { signal });
}

export interface SigningRequestDetail {
  id: string;
  type: string;
  chainId: number | null;
  walletAddress: string;
  status: string;
  authMethod: string;
  apiKeyPrefix: string | null;
  apiKeyName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function getSigningRequestDetailAuth(
  getToken: () => Promise<string | null>,
  signingRequestId: string,
  signal?: AbortSignal,
) {
  return authFetch<SigningRequestDetail>(`/v1/wallets/signing-requests/${signingRequestId}`, getToken, { signal });
}
