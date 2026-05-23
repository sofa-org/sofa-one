import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidateNested,
} from 'class-validator';
import { isIpOrCidr } from '../../../common/utils/ip-cidr';

@ValidatorConstraint({ name: 'isIpOrCidr', async: false })
class IsIpOrCidrConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isIpOrCidr(value);
  }

  defaultMessage(): string {
    return 'Each entry must be a valid IPv4/IPv6 address or CIDR range (e.g. 1.2.3.4, 10.0.0.0/24, 2001:db8::1, or 2001:db8::/64)';
  }
}

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
  @Validate(IsIpOrCidrConstraint, { each: true })
  allowedIps?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ApiKeyPermissionsDto)
  permissions?: ApiKeyPermissionsDto;
}
