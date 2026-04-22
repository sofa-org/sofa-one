import { IsString, IsNumber, IsOptional, IsEnum, IsBoolean } from 'class-validator';

export enum SponsorSchemaEnum {
  PAY_FOR_USER = 'pay_for_user',
  CHARGE_CUSTOM_TOKENS = 'charge_custom_tokens',
  FIXED_RATE = 'fixed_rate',
}

export enum PolicyRuleTypeEnum {
  CONTRACT_FUNCTIONS = 'contract_functions',
  ACCOUNT_FUNCTIONS = 'account_functions',
  RATE_LIMIT = 'rate_limit',
}

export enum TimeIntervalTypeEnum {
  MINUTE = 'minute',
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export class CreatePolicyDto {
  @IsString()
  name: string;

  @IsNumber()
  chainId: number;

  @IsEnum(SponsorSchemaEnum)
  sponsorSchema: SponsorSchemaEnum;

  @IsOptional()
  @IsString()
  tokenContract?: string;

  @IsOptional()
  @IsString()
  tokenContractAmount?: string;
}

export class UpdatePolicyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  chainId?: number;

  @IsOptional()
  @IsEnum(SponsorSchemaEnum)
  sponsorSchema?: SponsorSchemaEnum;
}

export class CreatePolicyRuleDto {
  @IsEnum(PolicyRuleTypeEnum)
  type: PolicyRuleTypeEnum;

  @IsOptional()
  @IsString()
  contract?: string;

  @IsOptional()
  @IsString()
  functionName?: string;

  @IsOptional()
  @IsBoolean()
  wildcard?: boolean;

  @IsOptional()
  @IsString()
  gasLimit?: string;

  @IsOptional()
  @IsNumber()
  countLimit?: number;

  @IsOptional()
  @IsEnum(TimeIntervalTypeEnum)
  timeIntervalType?: TimeIntervalTypeEnum;

  @IsOptional()
  @IsNumber()
  timeIntervalValue?: number;
}
