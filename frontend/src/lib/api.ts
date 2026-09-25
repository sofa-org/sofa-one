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

export type WithdrawalToken = 'USDC' | 'USDT' | 'NATIVE';

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
  /** ISO timestamp when the key was frozen; null when not frozen. */
  frozenAt: string | null;
  /** Server-provided freeze reason (safe metadata only); null when not frozen. */
  frozenReason: string | null;
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

/** Lifecycle status for dashboard display. Priority: revoked > frozen > expired > active. */
export type ApiKeyLifecycleStatus = 'revoked' | 'frozen' | 'expired' | 'active';

export type ApiKeyLifecycleFields = Pick<ApiKeyRecord, 'revoked' | 'frozenAt' | 'expiresAt'>;

/**
 * Single source of truth for API key lifecycle status.
 * Priority is revoked > frozen > expired > active (calibrated to revoked/frozenAt/expiresAt).
 */
export function getApiKeyLifecycleStatus(
  key: ApiKeyLifecycleFields,
  nowMs: number = Date.now(),
): ApiKeyLifecycleStatus {
  if (key.revoked) return 'revoked';
  if (key.frozenAt) return 'frozen';
  if (key.expiresAt) {
    const expiryTime = new Date(key.expiresAt).getTime();
    if (!Number.isNaN(expiryTime) && expiryTime <= nowMs) return 'expired';
  }
  return 'active';
}

export function isApiKeyLifecycleActive(
  key: ApiKeyLifecycleFields,
  nowMs: number = Date.now(),
): boolean {
  return getApiKeyLifecycleStatus(key, nowMs) === 'active';
}

export function matchesApiKeyLifecycleFilter(
  key: ApiKeyLifecycleFields,
  filter: 'all' | ApiKeyLifecycleStatus,
  nowMs: number = Date.now(),
): boolean {
  if (filter === 'all') return true;
  return getApiKeyLifecycleStatus(key, nowMs) === filter;
}

/** Rank for list sorting: usable first, then attention states, revoked last. */
export function getApiKeyLifecycleSortRank(status: ApiKeyLifecycleStatus): number {
  switch (status) {
    case 'active':
      return 0;
    case 'frozen':
      return 1;
    case 'expired':
      return 2;
    case 'revoked':
      return 3;
  }
}

export function getApiKeyLifecycleLabel(status: ApiKeyLifecycleStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'frozen':
      return 'Frozen';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
  }
}

export function getApiKeyLifecycleBadgeClass(status: ApiKeyLifecycleStatus): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-700';
    case 'frozen':
      return 'bg-amber-100 text-amber-800';
    case 'expired':
      return 'bg-orange-100 text-orange-800';
    case 'revoked':
      return 'bg-red-100 text-red-700';
  }
}

/** Map server freeze reasons to short, user-safe copy (never exposes raw secrets). */
export function formatApiKeyFrozenReason(reason: string | null | undefined): string {
  if (!reason || !reason.trim()) {
    return 'This key was frozen for security review.';
  }

  const normalized = reason.trim();
  const lower = normalized.toLowerCase();

  if (lower.includes('suspicious') || lower === 'api_key_frozen') {
    return 'Frozen after suspicious API key usage was detected.';
  }
  if (lower.includes('context_changed') || lower.includes('repeated_context')) {
    return 'Frozen after unexpected IP or client changes on a high-risk key.';
  }
  if (lower.includes('critical risk') || lower.includes('high_risk')) {
    return 'Frozen due to a critical risk signal. Rotate keys before reuse.';
  }
  if (lower.includes('account_takeover')) {
    return 'Frozen as part of an account-takeover response.';
  }

  // Keep server text when already human-readable; strip overly technical codes only lightly.
  if (/^[a-z0-9_.:-]+$/i.test(normalized) && normalized.includes('_')) {
    return `Frozen: ${normalized.replace(/_/g, ' ')}.`;
  }

  return normalized;
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

export interface MfaStatusResponse {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpSetupResponse {
  otpauthUrl: string;
  secret: string;
}

export interface TotpEnableResponse {
  recoveryCodes: string[];
}

export interface TotpVerifyResponse {
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

// --- Billing ---

export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  basePrice: string;
  currency: string;
  billingPeriod: string;
  features: string[];
}

export interface BillingPlanResponse {
  currentPlanId: string;
  plans: BillingPlan[];
  renewal?: BillingRenewalDto;
  /** Future plan scheduled to take effect at the next UTC month. */
  scheduledPlan?: {
    planCode: string;
    planName: string;
    effectivePeriod: string;
  };
}

export type BillingRenewalStatus = 'enabled' | 'pending' | 'disabled' | 'needs_attention';
export type BillingSubscriptionStatus =
  | 'active' | 'pending' | 'incomplete' | 'past_due' | 'unpaid'
  | 'canceled' | 'none' | 'unknown';
export type BillingPaymentMethod = 'card' | 'none' | 'unknown';
export interface BillingRenewalDto {
  status: BillingRenewalStatus;
  subscriptionStatus: BillingSubscriptionStatus;
  paymentMethod: BillingPaymentMethod;
  nextChargeAt: string | null;
  amount: string | null;
  currency: string | null;
}

export interface AssignBillingPlanRequest {
  planCode: string;
}

/**
 * POST /v1/billing/plan result. Server owns amount, effective dates, and kind.
 * - unchanged: already on the requested plan (idempotent)
 * - payment_required: upgrade charge created; pay before entitlements change
 * - scheduled: downgrade/lateral takes effect at the next UTC month boundary
 * - changed: legacy alias for a scheduled outcome (treat like scheduled)
 */
export type AssignBillingPlanResponse =
  | {
      planCode: string;
      planName: string;
      effectivePeriod: string;
      effectiveFrom: string;
      outcome: 'unchanged';
    }
  | {
      planCode: string;
      planName: string;
      effectivePeriod: string;
      effectiveFrom: string;
      outcome: 'payment_required';
      changeId: string;
      invoiceId: string;
      amount: string;
      currency: string;
      kind: 'upgrade';
    }
  | {
      planCode: string;
      planName: string;
      effectivePeriod: string;
      effectiveFrom: string;
      outcome: 'scheduled' | 'changed';
      changeId?: string;
      kind?: 'downgrade';
    };

export interface BillingTierBreakdown {
  tier: string;
  from: string;
  to: string;
  quantity: string;
  rate: string;
  cost: string;
}

export interface BillingSummary {
  period: string;
  planId: string;
  planName: string;
  outboundVolume: string;
  outboundFreeAllowance: string;
  outboundOverage: string;
  apiCalls: string;
  apiCallsFreeAllowance: string;
  activeWallets: string;
  activeWalletsFreeAllowance: string;
  estimatedBaseCost: string;
  estimatedOverageCost: string;
  estimatedTotal: string;
  currency: string;
  overageRate: string;
  overageUnit: string;
  tierBreakdown: BillingTierBreakdown[];
}

export interface BillingInvoice {
  id: string;
  period: string;
  status: string;
  amount: string;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  pdfUrl: string | null;
  /** Set by the server when the invoice was generated from a plan version. */
  planVersionId?: string | null;
}

export interface BillingInvoicesResponse {
  items: BillingInvoice[];
  total: number;
  page: number;
  limit: number;
}

export interface BillingCheckoutResponse {
  invoiceId: string;
  sessionId: string;
  checkoutUrl: string;
}

export interface UsdcQuoteResponse {
  invoiceId: string;
  paymentAttemptId: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  treasuryAddress: string;
  expectedPayerAddress: string;
  amountBaseUnits: string;
  amountUsd: string;
  currency: string;
  quoteExpiresAt: string;
  requiredConfirmations: number;
}

export interface UsdcClaimRequest {
  paymentAttemptId: string;
  txHash: string;
}

export type UsdcClaimStatus =
  | 'pending' // receipt not found yet — retryable
  | 'rpc_error' // transient RPC error — retryable
  | 'confirming' // valid transfer detected, below the confirmation threshold
  | 'succeeded' // settled (invoice paid by this attempt)
  | 'expired' // quote expired — re-quote to retry
  | 'needs_review' // mismatch/manual review — never auto-settled
  | 'failed'; // reverted receipt — re-quote to retry

export interface UsdcClaimResponse {
  invoiceId: string;
  paymentAttemptId: string;
  status: UsdcClaimStatus;
  paid: boolean;
  txHash: string | null;
  chainId: number | null;
  confirmations: number | null;
  requiredConfirmations: number | null;
  blockNumber: string | null;
  blockHash: string | null;
  blockTimestamp: string | null;
  reviewReason: string | null;
  retryable: boolean;
}

/**
 * Quote-bound wallet-payment response (POST pay-from-wallet / GET payment-status).
 * `paid` is authoritative for invoice settlement — never treat accepted/reserved/
 * transactionHash alone as paid.
 */
export type UsdcWalletPayPhase = 'paid' | 'submitting' | 'unknown' | 'status' | 'accepted';

export interface UsdcWalletPayResult {
  invoiceId: string;
  paymentAttemptId: string;
  status: string;
  paid: boolean;
  accepted: boolean;
  reserved: boolean;
  isExecutor: boolean;
  phase: UsdcWalletPayPhase;
  chainId: number | null;
  /** Chain tx hash when known — never provider/UserOp ids. */
  transactionHash: string | null;
  reviewReason: string | null;
}

/**
 * BILL-018: safe projection of a payment attempt for invoice-level recovery.
 * Never includes calldata, receipts, RPC/provider details, checkout URLs, or hashes.
 */
export interface InvoicePaymentAttemptStatus {
  paymentAttemptId: string;
  method: string;
  status: string;
  reviewReason: string | null;
  createdAt: string;
  walletPaymentReserved: boolean;
  chainId: number | null;
  quoteExpiresAt: string | null;
}

/**
 * GET /v1/billing/invoices/:id/payment-status — read-only dashboard recovery.
 * Surfaces active pending/confirming, wallet reservation, and every unresolved
 * needs_review/reorged attempt so a newer quote cannot hide earlier review.
 */
export interface InvoicePaymentStatus {
  invoiceId: string;
  invoiceStatus: string;
  paid: boolean;
  paidAt: string | null;
  activeAttempt: InvoicePaymentAttemptStatus | null;
  walletReservation: InvoicePaymentAttemptStatus | null;
  unresolvedReviewAttempts: InvoicePaymentAttemptStatus[];
  hasUnresolvedReview: boolean;
  blockingReasons: string[];
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
    case 'BILLING_OUTBOUND_BLOCKED':
      return 'Withdrawals are blocked until you settle your unpaid invoice. Open Billing to pay the finalized invoice, then try again.';
    case 'USDC_INVOICE_NOT_PAYABLE':
      return 'This invoice is no longer payable. It may already be paid, finalized, or fully covered.';
    case 'USDC_PAYMENT_IN_PROGRESS':
      return 'A USDC payment is already in progress for this invoice. Wait for it to complete, then refresh the quote.';
    case 'USDC_INVALID_ATTEMPT':
      return 'This payment attempt or quote is no longer valid. Request a new quote to continue.';
    case 'USDC_WALLET_NOT_ACTIVE':
      return 'Your wallet is not active yet. Finish wallet setup and try again.';
    case 'USDC_QUOTE_EXPIRY_TOO_SOON':
      return 'This quote expires too soon to start a wallet payment safely. Request a fresh quote and try again.';
    case 'USDC_WALLET_USAGE_DEBT_ONLY':
      return 'Usage debt is open. Only usage-period invoices can be paid from your wallet until that debt is settled.';
    case 'USDC_WALLET_PAYMENT_RESERVED':
      return 'A wallet payment is already reserved for this quote. Check status instead of starting another payment.';
    case 'USDC_CANCEL_NOT_ALLOWED':
      return 'This USDC quote can no longer be cancelled. It may already be confirming, reserved, under review, or settled. Refresh payment status before trying anything else.';
    case 'WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED':
      return 'The payment destination is not on your withdrawal allowlist. Add it on the Wallet page and wait out the cooldown if needed.';
    case 'WITHDRAWAL_ADDRESS_IN_COOLDOWN':
      return 'The payment destination is still in cooldown. Wait until the cooldown ends, then try again.';
    case 'WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE':
      return 'Destination policy checks are temporarily unavailable. Try again shortly.';
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

export async function syncSession(getToken: () => Promise<string | null>, signal?: AbortSignal) {
  return authFetch<AuthSessionResponse>('/auth/session', getToken, { method: 'POST', signal });
}

/** @deprecated Use syncSession. */
export const socialLogin = syncSession;

export async function getMe(getToken: () => Promise<string | null>, signal?: AbortSignal) {
  return authFetch<AuthSessionResponse>('/auth/me', getToken, { signal });
}

export async function refreshApiKey(getToken: () => Promise<string | null>, stepUpToken: string) {
  return authFetch<RefreshApiKeyResponse>('/auth/refresh-api-key', getToken, {
    method: 'POST',
    headers: { 'X-Step-Up-Token': stepUpToken },
  });
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
  return authFetch<AuthSessionResponse>(
    '/auth/embedded-wallet/registration-transaction',
    getToken,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

// --- Dashboard MFA (TOTP) ---

export async function getMfaStatusAuth(getToken: () => Promise<string | null>) {
  return authFetch<MfaStatusResponse>('/v1/auth/mfa/status', getToken);
}

export async function setupTotpAuth(getToken: () => Promise<string | null>) {
  return authFetch<TotpSetupResponse>('/v1/auth/mfa/totp/setup', getToken, {
    method: 'POST',
  });
}

export async function enableTotpAuth(getToken: () => Promise<string | null>, code: string) {
  return authFetch<TotpEnableResponse>('/v1/auth/mfa/totp/enable', getToken, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function verifyTotpAuth(getToken: () => Promise<string | null>, code: string) {
  return authFetch<TotpVerifyResponse>('/v1/auth/mfa/totp/verify', getToken, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function disableTotpAuth(getToken: () => Promise<string | null>, code: string) {
  return authFetch<void>('/v1/auth/mfa/totp/disable', getToken, {
    method: 'POST',
    body: JSON.stringify({ code }),
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
  token: WithdrawalToken,
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
  return authFetch<ListTransactionsResponse>(`/v1/transactions${qs ? `?${qs}` : ''}`, getToken, {
    signal,
  });
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
  return authFetch<ListSigningRequestsResponse>(
    `/v1/wallets/signing-requests${qs ? `?${qs}` : ''}`,
    getToken,
    { signal },
  );
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
  return authFetch<TransactionDetail>(`/v1/transactions/${transactionId}/detail`, getToken, {
    signal,
  });
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
  return authFetch<SigningRequestDetail>(
    `/v1/wallets/signing-requests/${signingRequestId}`,
    getToken,
    { signal },
  );
}

export async function getBillingPlansAuth(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
) {
  return authFetch<BillingPlanResponse>('/v1/billing/plans', getToken, { signal });
}

export async function assignBillingPlanAuth(
  getToken: () => Promise<string | null>,
  planCode: string,
) {
  return authFetch<AssignBillingPlanResponse>('/v1/billing/plan', getToken, {
    method: 'POST',
    body: JSON.stringify({ planCode } satisfies AssignBillingPlanRequest),
  });
}

/**
 * POST /v1/billing/plan/cancel result. Cancels a pending scheduled plan change
 * (typically a downgrade) for the next UTC month. Optional fields are present
 * when the server still reports plan identity after cancel/no-op.
 * - canceled: a scheduled change was removed
 * - unchanged: nothing was scheduled (idempotent)
 */
export type CancelBillingPlanResponse = {
  outcome: 'canceled' | 'unchanged';
  effectivePeriod?: string;
  planCode?: string;
  planName?: string;
};

export async function cancelBillingPlanAuth(getToken: () => Promise<string | null>) {
  return authFetch<CancelBillingPlanResponse>('/v1/billing/plan/cancel', getToken, {
    method: 'POST',
  });
}

/**
 * POST /v1/billing/plan/upgrade/cancel result. Cancels a pending unpaid plan
 * upgrade charge. Optional fields may identify the plan the user remains on.
 * - canceled: pending upgrade was removed
 * - unchanged: nothing was pending (idempotent)
 */
export type CancelBillingPlanUpgradeResponse = {
  outcome: 'canceled' | 'unchanged';
  effectivePeriod?: string;
  planCode?: string;
  planName?: string;
};

export async function cancelBillingPlanUpgradeAuth(getToken: () => Promise<string | null>) {
  return authFetch<CancelBillingPlanUpgradeResponse>('/v1/billing/plan/upgrade/cancel', getToken, {
    method: 'POST',
  });
}

export async function getBillingSummaryAuth(
  getToken: () => Promise<string | null>,
  period: string,
  signal?: AbortSignal,
) {
  return authFetch<BillingSummary>(
    `/v1/billing/summary?period=${encodeURIComponent(period)}`,
    getToken,
    { signal },
  );
}

export interface ListBillingInvoicesParams {
  page?: number;
  limit?: number;
}

export async function listBillingInvoicesAuth(
  getToken: () => Promise<string | null>,
  params?: ListBillingInvoicesParams,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return authFetch<BillingInvoicesResponse>(`/v1/billing/invoices${qs ? `?${qs}` : ''}`, getToken, {
    signal,
  });
}

export async function getBillingInvoiceAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  signal?: AbortSignal,
) {
  return authFetch<BillingInvoice>(`/v1/billing/invoices/${invoiceId}`, getToken, { signal });
}

export async function getBillingInvoicePdfAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
): Promise<Blob> {
  const token = await getToken();
  if (!token) {
    throw new Error('Openfort session is not ready. Refresh and sign in again.');
  }

  const res = await fetch(`${API_BASE}/v1/billing/invoices/${invoiceId}/pdf`, {
    headers: {
      Accept: 'application/pdf',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `Could not download invoice PDF (${res.status})`;
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // Keep the generic status message for non-JSON bodies.
      }
    }
    throw new Error(message);
  }

  return res.blob();
}

export async function createBillingCheckoutSessionAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  signal?: AbortSignal,
) {
  return authFetch<BillingCheckoutResponse>(
    `/v1/billing/invoices/${invoiceId}/checkout`,
    getToken,
    {
      method: 'POST',
      signal,
    },
  );
}

export async function createUsdcQuoteAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  chainId?: number,
  signal?: AbortSignal,
) {
  const body: { chainId?: number } = {};
  if (chainId !== undefined) body.chainId = chainId;
  return authFetch<UsdcQuoteResponse>(`/v1/billing/invoices/${invoiceId}/usdc/quote`, getToken, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

export async function createUsdcClaimAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  paymentAttemptId: string,
  txHash: string,
  signal?: AbortSignal,
) {
  const body: UsdcClaimRequest = { paymentAttemptId, txHash };
  return authFetch<UsdcClaimResponse>(`/v1/billing/invoices/${invoiceId}/usdc/claim`, getToken, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * POST /v1/billing/invoices/:id/usdc/pay-from-wallet
 * Body is paymentAttemptId only (server-bound quote facts). Requires step-up.
 */
export async function payUsdcFromWalletAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  paymentAttemptId: string,
  stepUpToken?: string,
  signal?: AbortSignal,
) {
  return authFetch<UsdcWalletPayResult>(
    `/v1/billing/invoices/${invoiceId}/usdc/pay-from-wallet`,
    getToken,
    {
      method: 'POST',
      headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      body: JSON.stringify({ paymentAttemptId }),
      signal,
    },
  );
}

/**
 * GET /v1/billing/invoices/:id/usdc/payment-status?paymentAttemptId=
 * Poll reserved wallet-payment state without step-up. Safe fields only.
 */
export async function getUsdcPaymentStatusAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  paymentAttemptId: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ paymentAttemptId });
  return authFetch<UsdcWalletPayResult>(
    `/v1/billing/invoices/${invoiceId}/usdc/payment-status?${query.toString()}`,
    getToken,
    { signal },
  );
}

/**
 * BILL-003: safe result of cancelling a clean evidence-free pending USDC quote.
 * Never includes hashes, receipts, provider ids, or secrets.
 */
export interface UsdcCancelResult {
  invoiceId: string;
  paymentAttemptId: string;
  status: 'cancelled';
  cancelledAt: string;
  cancelReason: string | null;
}

/**
 * POST /v1/billing/invoices/:id/usdc/cancel
 * Body is paymentAttemptId only. Cancels only clean pending (unreserved,
 * evidence-free) USDC quotes. Confirming/reserved/evidence/review/terminal
 * return 409 USDC_CANCEL_NOT_ALLOWED (or related conflicts).
 */
export async function cancelUsdcQuoteAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  paymentAttemptId: string,
  signal?: AbortSignal,
) {
  return authFetch<UsdcCancelResult>(
    `/v1/billing/invoices/${invoiceId}/usdc/cancel`,
    getToken,
    {
      method: 'POST',
      body: JSON.stringify({ paymentAttemptId }),
      signal,
    },
  );
}

/**
 * GET /v1/billing/invoices/:id/payment-status
 * Invoice-level read-only payment recovery (BILL-018). Never creates quotes
 * or attempts. Safe fields only — no hashes, receipts, or provider details.
 */
export async function getInvoicePaymentStatusAuth(
  getToken: () => Promise<string | null>,
  invoiceId: string,
  signal?: AbortSignal,
) {
  return authFetch<InvoicePaymentStatus>(
    `/v1/billing/invoices/${invoiceId}/payment-status`,
    getToken,
    { signal },
  );
}
