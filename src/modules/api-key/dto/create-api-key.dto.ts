import { Transform } from 'class-transformer';
import {
  IsArray,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  allowedChains?: number[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[1-2][0-9]|3[0-2]))?$/, {
    each: true,
    message: 'Each entry must be a valid IPv4 address or CIDR range (e.g. 1.2.3.4 or 10.0.0.0/24)',
  })
  allowedIps?: string[];
}
