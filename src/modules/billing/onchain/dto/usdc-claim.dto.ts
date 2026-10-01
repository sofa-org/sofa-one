import { IsUUID, Matches } from 'class-validator';

/** A transaction hash is exactly 32 bytes (64 hex chars) after the 0x prefix. */
const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Minimal USDC claim body. Only `paymentAttemptId` and `txHash` are accepted;
 * the global ValidationPipe (whitelist + forbidNonWhitelisted) rejects any
 * other field. All payment facts (token, treasury, amount, payer, chain,
 * decimals, confirmations) are read from the attempt's server-side quote
 * snapshot — never from the client.
 */
export class UsdcClaimDto {
  @IsUUID()
  paymentAttemptId: string;

  @Matches(TX_HASH_REGEX, { message: 'txHash must be a 32-byte hex transaction hash' })
  txHash: string;
}
