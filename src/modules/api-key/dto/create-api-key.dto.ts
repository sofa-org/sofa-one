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
  ValidateIf,
} from 'class-validator';
import { isIpOrCidr } from '../../../common/utils/ip-cidr';

const WEI_AMOUNT_RE = /^\d+$/;

@ValidatorConstraint({ name: 'isIpOrCidr', async: false })
class IsIpOrCidrConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isIpOrCidr(value);
  }

  defaultMessage(): string {
    return 'Each entry must be a valid IPv4/IPv6 address or CIDR range (e.g. 1.2.3.4, 10.0.0.0/24, 2001:db8::1, or 2001:db8::/64)';
  }
}

@ValidatorConstraint({ name: 'isCapabilityIdList', async: false })
class IsCapabilityIdListConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value) && value.length <= 100 && value.every((id) =>
      typeof id === 'string' && id.length > 0 && id.length <= 160 && id.trim() === id,
    ) && new Set(value).size === value.length;
  }
  defaultMessage(): string { return 'allowedCapabilityIds must contain at most 100 unique non-empty IDs of at most 160 characters'; }
}

@ValidatorConstraint({ name: 'isWeiAmount', async: false })
class IsWeiAmountConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && WEI_AMOUNT_RE.test(value);
  }

  defaultMessage(): string {
    return 'Spend limit must be a non-negative integer string (wei)';
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

export class ApiKeySpendLimitsDto {
  @IsOptional()
  @IsString()
  @Validate(IsWeiAmountConstraint)
  daily?: string;

  @IsOptional()
  @IsString()
  @Validate(IsWeiAmountConstraint)
  monthly?: string;
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

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @Validate(IsCapabilityIdListConstraint)
  allowedCapabilityIds?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ApiKeySpendLimitsDto)
  spendLimits?: ApiKeySpendLimitsDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ApiKeyPermissionsDto)
  permissions?: ApiKeyPermissionsDto;
}

export class PatchApiKeyCapabilitiesDto {
  @IsArray()
  @Validate(IsCapabilityIdListConstraint)
  allowedCapabilityIds!: string[];
}
