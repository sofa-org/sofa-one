import { HttpStatus } from '@nestjs/common';

import { API_ERROR_CODES, resolveApiErrorCode } from './api-error-codes';

describe('resolveApiErrorCode', () => {
  it('maps validation message arrays to validation errors', () => {
    expect(
      resolveApiErrorCode(HttpStatus.BAD_REQUEST, [
        'chainId must be an integer',
        'message must be a string',
      ]),
    ).toBe(API_ERROR_CODES.VALIDATION_ERROR);
  });

  it.each([
    ['Invalid API key', API_ERROR_CODES.INVALID_API_KEY],
    ['API key is required', API_ERROR_CODES.API_KEY_REQUIRED],
    ['Missing authentication credentials', API_ERROR_CODES.AUTHENTICATION_REQUIRED],
    ['IP address not allowed', API_ERROR_CODES.IP_NOT_ALLOWED],
    ['Wallet not found', API_ERROR_CODES.WALLET_NOT_FOUND],
    ['Transaction not found', API_ERROR_CODES.TRANSACTION_NOT_FOUND],
    ['Chain 1 is not supported', API_ERROR_CODES.CHAIN_NOT_SUPPORTED],
    ['USDC billing is not supported on chain 1', API_ERROR_CODES.CHAIN_NOT_SUPPORTED],
    ['USDC is not supported on chain 1', API_ERROR_CODES.CHAIN_NOT_SUPPORTED],
    ['USDC is not supported on Base', API_ERROR_CODES.CHAIN_NOT_SUPPORTED],
    ['USDT is not supported on Arbitrum', API_ERROR_CODES.CHAIN_NOT_SUPPORTED],
    ['Idempotency key conflicts with prior request', API_ERROR_CODES.IDEMPOTENCY_CONFLICT],
    ['Hash signing is not allowed', API_ERROR_CODES.RAW_HASH_SIGNING_DISABLED],
    ['Type must be message', API_ERROR_CODES.RAW_HASH_SIGNING_DISABLED],
    ['Wallet is not active', API_ERROR_CODES.WALLET_NOT_ACTIVE],
    [
      'Agent registration is still pending',
      API_ERROR_CODES.AGENT_REGISTRATION_PENDING,
    ],
    [
      'No matching project-scoped policy found',
      API_ERROR_CODES.PAYMASTER_POLICY_NOT_CONFIGURED,
    ],
    ['Paymaster policy is not configured', API_ERROR_CODES.PAYMASTER_POLICY_NOT_CONFIGURED],
    [
      'UserOperation gas price is unavailable',
      API_ERROR_CODES.USER_OPERATION_GAS_PRICE_UNAVAILABLE,
    ],
    ['UserOperation fee estimate failed', API_ERROR_CODES.USER_OPERATION_GAS_PRICE_UNAVAILABLE],
    ['UserOperation rejected by bundler', API_ERROR_CODES.USER_OPERATION_REJECTED],
    ['Backend EOA transaction failed', API_ERROR_CODES.BACKEND_TRANSACTION_FAILED],
    ['Wallet service unavailable', API_ERROR_CODES.WALLET_SERVICE_UNAVAILABLE],
    [
      'Unproven asset outflow is not allowed while destination protection is enabled. Use a dedicated withdraw/payment path, or send only direct ERC-20 transfers to allowlisted destinations.',
      API_ERROR_CODES.UNPROVEN_ASSET_OUTFLOW_BLOCKED,
    ],
    [
      'Transaction send blocked: unproven asset outflow under destination protection',
      API_ERROR_CODES.UNPROVEN_ASSET_OUTFLOW_BLOCKED,
    ],
    [
      'API-key signing is not allowed while destination protection is enabled',
      API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
    ],
    [
      'Signing blocked by destination protection',
      API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
    ],
  ])('maps "%s" to %s', (message, expectedCode) => {
    expect(resolveApiErrorCode(HttpStatus.BAD_REQUEST, message)).toBe(expectedCode);
  });

  it.each([
    ['Plan code is not supported: legacy-plan', HttpStatus.CONFLICT],
    ['Plan code is not supported: enterprise', HttpStatus.CONFLICT],
    ['Agent key hook is not supported', HttpStatus.BAD_REQUEST],
  ])(
    'does not map non-chain unsupported message "%s" to CHAIN_NOT_SUPPORTED; falls back to BAD_REQUEST',
    (message, statusCode) => {
      expect(resolveApiErrorCode(statusCode, message)).toBe(API_ERROR_CODES.BAD_REQUEST);
    },
  );

  it.each([
    [HttpStatus.UNAUTHORIZED, API_ERROR_CODES.UNAUTHORIZED],
    [HttpStatus.NOT_FOUND, API_ERROR_CODES.NOT_FOUND],
    [HttpStatus.INTERNAL_SERVER_ERROR, API_ERROR_CODES.INTERNAL_ERROR],
    [HttpStatus.BAD_GATEWAY, API_ERROR_CODES.INTERNAL_ERROR],
    [HttpStatus.BAD_REQUEST, API_ERROR_CODES.BAD_REQUEST],
  ])('falls back from status %s to %s', (statusCode, expectedCode) => {
    expect(resolveApiErrorCode(statusCode, 'Unmapped error')).toBe(expectedCode);
  });
});
