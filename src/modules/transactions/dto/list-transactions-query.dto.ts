import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SUPPORTED_CHAIN_IDS } from '../../../common/chains/supported-chains';

const VALID_STATUSES = ['submitting', 'pending', 'confirmed', 'failed', 'unknown'] as const;

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(VALID_STATUSES)
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @IsIn(SUPPORTED_CHAIN_IDS, { message: 'chainId $value is not supported' })
  @Type(() => Number)
  chainId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;
}
