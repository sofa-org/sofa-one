import { IsString, IsNumber, IsOptional, IsEnum, IsBoolean, IsArray } from 'class-validator';

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
  scope: string; // 'project' | 'account' | 'transaction'

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  priority?: number;

  @IsOptional()
  @IsArray()
  rules?: any[];
}

export class UpdatePolicyDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  priority?: number;

  @IsOptional()
  @IsArray()
  rules?: any[];
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
