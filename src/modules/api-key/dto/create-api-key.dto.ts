import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ApiKeyPermissionsDto {
  @IsOptional()
  @IsBoolean()
  canSign?: boolean;

  @IsOptional()
  @IsBoolean()
  canSendTransaction?: boolean;

  @IsOptional()
  @IsBoolean()
  canReadTransactionStatus?: boolean;

  @IsOptional()
  @IsBoolean()
  canUseEoaExecution?: boolean;
}

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
  @IsString({ each: true })
  @Matches(/^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[1-2][0-9]|3[0-2]))?$/, {
    each: true,
    message: 'Each entry must be a valid IPv4 address or CIDR range (e.g. 1.2.3.4 or 10.0.0.0/24)',
  })
  allowedIps?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ApiKeyPermissionsDto)
  permissions?: ApiKeyPermissionsDto;
}
