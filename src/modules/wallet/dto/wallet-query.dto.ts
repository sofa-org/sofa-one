import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class WalletBalancesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId!: number;

  @IsOptional()
  @IsUUID()
  walletId?: string;
}

export class WalletDepositInfoDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId!: number;

  @IsOptional()
  @IsUUID()
  walletId?: string;
}
