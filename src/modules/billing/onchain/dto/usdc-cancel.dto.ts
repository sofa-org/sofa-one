import { IsUUID } from 'class-validator';

/**
 * Minimal USDC cancel body (BILL-003). Only `paymentAttemptId` is accepted;
 * the global ValidationPipe (whitelist + forbidNonWhitelisted) rejects any
 * other field. Cancel never accepts hashes, receipts, chain selectors, or
 * provider facts — the server loads the owned attempt and fails closed unless
 * it is a clean evidence-free pending USDC quote.
 */
export class UsdcCancelDto {
  @IsUUID()
  paymentAttemptId: string;
}
