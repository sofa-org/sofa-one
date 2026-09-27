import { HttpStatus } from '@nestjs/common';

export const API_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_API_KEY: 'INVALID_API_KEY',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  API_KEY_REQUIRED: 'API_KEY_REQUIRED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_SELECTION_REQUIRED: 'WALLET_SELECTION_REQUIRED',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  CHAIN_NOT_SUPPORTED: 'CHAIN_NOT_SUPPORTED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RAW_HASH_SIGNING_DISABLED: 'RAW_HASH_SIGNING_DISABLED',
  WALLET_NOT_ACTIVE: 'WALLET_NOT_ACTIVE',
  USDC_INVOICE_NOT_PAYABLE: 'USDC_INVOICE_NOT_PAYABLE',
  USDC_PAYMENT_IN_PROGRESS: 'USDC_PAYMENT_IN_PROGRESS',
  USDC_INVALID_ATTEMPT: 'USDC_INVALID_ATTEMPT',
  USDC_WALLET_NOT_ACTIVE: 'USDC_WALLET_NOT_ACTIVE',
  /** Quote expires too soon to safely start wallet-payment provider dispatch. */
  USDC_QUOTE_EXPIRY_TOO_SOON: 'USDC_QUOTE_EXPIRY_TOO_SOON',
  /** Usage debt is present; only usage_period invoices may be paid from wallet. */
  USDC_WALLET_USAGE_DEBT_ONLY: 'USDC_WALLET_USAGE_DEBT_ONLY',
  /** Wallet-payment reservation already bound; cannot release/replace. */
  USDC_WALLET_PAYMENT_RESERVED: 'USDC_WALLET_PAYMENT_RESERVED',
  /**
   * BILL-003: user cancel refused — attempt is not a clean evidence-free
   * pending USDC quote (confirming, reserved, evidence-bearing, or already
   * terminal non-cancelled). Fail closed; never rewrite evidence.
   */
  USDC_CANCEL_NOT_ALLOWED: 'USDC_CANCEL_NOT_ALLOWED',
  BILLING_OUTBOUND_BLOCKED: 'BILLING_OUTBOUND_BLOCKED',
  BILLING_ASSET_FLOW_UNVERIFIABLE: 'BILLING_ASSET_FLOW_UNVERIFIABLE',
  BILLING_DEBT_CHECK_UNAVAILABLE: 'BILLING_DEBT_CHECK_UNAVAILABLE',
  BILLING_PAYMENT_REQUIRED: 'BILLING_PAYMENT_REQUIRED',
  /** API key has not acknowledged destination-policy binding for direct egress. */
  API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED: 'API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED',
  WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED: 'WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED',
  WITHDRAWAL_ADDRESS_IN_COOLDOWN: 'WITHDRAWAL_ADDRESS_IN_COOLDOWN',
  WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE: 'WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE',
  /** Destination protection on; batch is not fully proven direct egress. */
  UNPROVEN_ASSET_OUTFLOW_BLOCKED: 'UNPROVEN_ASSET_OUTFLOW_BLOCKED',
  /**
   * Destination protection on (`requireAddressAllowlist === true`);
   * API-key message/typed_data signing is fail-closed for all execution modes.
   */
  SIGNING_BLOCKED_BY_DESTINATION_PROTECTION: 'SIGNING_BLOCKED_BY_DESTINATION_PROTECTION',
  AGENT_REGISTRATION_PENDING: 'AGENT_REGISTRATION_PENDING',
  PAYMASTER_POLICY_NOT_CONFIGURED: 'PAYMASTER_POLICY_NOT_CONFIGURED',
  USER_OPERATION_GAS_PRICE_UNAVAILABLE: 'USER_OPERATION_GAS_PRICE_UNAVAILABLE',
  USER_OPERATION_REJECTED: 'USER_OPERATION_REJECTED',
  BACKEND_TRANSACTION_FAILED: 'BACKEND_TRANSACTION_FAILED',
  WALLET_SERVICE_UNAVAILABLE: 'WALLET_SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export function resolveApiErrorCode(statusCode: number, message: string | string[]): ApiErrorCode {
  if (Array.isArray(message)) return API_ERROR_CODES.VALIDATION_ERROR;

  const normalized = message.toLowerCase();

  if (normalized.includes('invalid api key')) return API_ERROR_CODES.INVALID_API_KEY;
  if (normalized.includes('api key is required')) return API_ERROR_CODES.API_KEY_REQUIRED;
  if (normalized.includes('missing authentication')) return API_ERROR_CODES.AUTHENTICATION_REQUIRED;
  if (normalized.includes('ip address not allowed')) return API_ERROR_CODES.IP_NOT_ALLOWED;
  if (normalized.includes('wallet not found')) return API_ERROR_CODES.WALLET_NOT_FOUND;
  if (normalized.includes('walletid is required when multiple')) {
    return API_ERROR_CODES.WALLET_SELECTION_REQUIRED;
  }
  if (normalized.includes('transaction not found')) return API_ERROR_CODES.TRANSACTION_NOT_FOUND;
  if (
    normalized.includes('is not supported') &&
    (normalized.includes('chain') ||
      normalized.includes('usdc is not supported') ||
      normalized.includes('usdt is not supported'))
  ) {
    return API_ERROR_CODES.CHAIN_NOT_SUPPORTED;
  }
  if (normalized.includes('idempotency key')) return API_ERROR_CODES.IDEMPOTENCY_CONFLICT;
  if (
    normalized.includes('hash signing is not allowed') ||
    normalized.includes('type must be message')
  ) {
    return API_ERROR_CODES.RAW_HASH_SIGNING_DISABLED;
  }
  if (normalized.includes('wallet is not active')) return API_ERROR_CODES.WALLET_NOT_ACTIVE;
  if (normalized.includes('agent registration is still pending')) {
    return API_ERROR_CODES.AGENT_REGISTRATION_PENDING;
  }
  if (
    normalized.includes('no matching project-scoped policy found') ||
    normalized.includes('paymaster policy')
  ) {
    return API_ERROR_CODES.PAYMASTER_POLICY_NOT_CONFIGURED;
  }
  if (normalized.includes('useroperation gas price') || normalized.includes('useroperation fee')) {
    return API_ERROR_CODES.USER_OPERATION_GAS_PRICE_UNAVAILABLE;
  }
  if (normalized.includes('useroperation rejected')) return API_ERROR_CODES.USER_OPERATION_REJECTED;
  if (normalized.includes('backend eoa transaction failed')) {
    return API_ERROR_CODES.BACKEND_TRANSACTION_FAILED;
  }
  if (normalized.includes('wallet service unavailable')) {
    return API_ERROR_CODES.WALLET_SERVICE_UNAVAILABLE;
  }
  if (normalized.includes('direct egress') && normalized.includes('reauth')) {
    return API_ERROR_CODES.API_KEY_DIRECT_EGRESS_REAUTH_REQUIRED;
  }
  if (normalized.includes('not allowlisted')) {
    return API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED;
  }
  if (normalized.includes('still in cooldown')) {
    return API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN;
  }
  if (normalized.includes('destination policy is temporarily unavailable')) {
    return API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE;
  }
  if (normalized.includes('unproven asset outflow')) {
    return API_ERROR_CODES.UNPROVEN_ASSET_OUTFLOW_BLOCKED;
  }
  if (
    normalized.includes('signing is not allowed while destination protection') ||
    normalized.includes('blocked by destination protection')
  ) {
    return API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION;
  }
  if (statusCode === HttpStatus.UNAUTHORIZED) return API_ERROR_CODES.UNAUTHORIZED;
  if (statusCode === HttpStatus.NOT_FOUND) return API_ERROR_CODES.NOT_FOUND;
  if (statusCode >= 500) return API_ERROR_CODES.INTERNAL_ERROR;
  return API_ERROR_CODES.BAD_REQUEST;
}
