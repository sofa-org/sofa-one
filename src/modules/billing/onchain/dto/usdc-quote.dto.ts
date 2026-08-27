import { IsInt, IsOptional } from 'class-validator';

/**
 * USDC quote request. `chainId` is an optional verified selector only: the
 * server validates it against the USDC billing chain allowlist and per-chain
 * configuration before use. Token, treasury, RPC, decimals, amount, and payer
 * are always derived server-side — never trusted from the client. The global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects any other field.
 */
export class UsdcQuoteDto {
  @IsOptional()
  @IsInt()
  chainId?: number;
}
