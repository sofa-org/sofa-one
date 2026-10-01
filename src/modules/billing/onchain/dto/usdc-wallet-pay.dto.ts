import { IsUUID } from 'class-validator';

/**
 * Dashboard wallet-payment request. Client may only identify the existing
 * USDC quote attempt — never amount, chain, token, treasury, payer, calldata,
 * or idempotency overrides (forbidNonWhitelisted rejects extras).
 */
export class UsdcWalletPayDto {
  @IsUUID()
  paymentAttemptId!: string;
}
