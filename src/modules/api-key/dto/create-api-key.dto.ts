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

const ETHEREUM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const FUNCTION_SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
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

@ValidatorConstraint({ name: 'isEthereumAddress', async: false })
class IsEthereumAddressConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && ETHEREUM_ADDRESS_RE.test(value);
  }

  defaultMessage(): string {
    return 'Each entry must be a valid Ethereum address (0x-prefixed, 40 hex chars)';
  }
}

@ValidatorConstraint({ name: 'isFunctionSelector', async: false })
class IsFunctionSelectorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && FUNCTION_SELECTOR_RE.test(value);
  }

  defaultMessage(): string {
    return 'Each entry must be a valid 4-byte function selector (0x-prefixed, 8 hex chars, e.g. 0xa9059cbb)';
  }
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

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsEthereumAddressConstraint, { each: true })
  allowedContracts?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsFunctionSelectorConstraint, { each: true })
  allowedFunctionSelectors?: string[];

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
