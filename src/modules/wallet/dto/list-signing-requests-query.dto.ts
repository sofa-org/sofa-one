import { IsOptional, IsString, IsIn, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ListSigningRequestsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['message', 'typed_data'])
  type?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  chainId?: number;

  @IsOptional()
  @IsString()
  @IsIn(['submitting', 'signed', 'failed'])
  status?: string;

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
