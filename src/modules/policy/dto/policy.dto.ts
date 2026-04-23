import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsObject,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Criterion types ──────────────────────────────────────────────────────────

export class EthValueCriterionDto {
  @IsIn(['ethValue'])
  type: 'ethValue';

  @IsIn(['<=', '>=', '<', '>'])
  operator: '<=' | '>=' | '<' | '>';

  @IsString()
  ethValue: string;
}

export class EvmAddressCriterionDto {
  @IsIn(['evmAddress'])
  type: 'evmAddress';

  @IsIn(['in', 'not in'])
  operator: 'in' | 'not in';

  @IsArray()
  @IsString({ each: true })
  addresses: string[];
}

export class EvmNetworkCriterionDto {
  @IsIn(['evmNetwork'])
  type: 'evmNetwork';

  @IsIn(['in', 'not in'])
  operator: 'in' | 'not in';

  @IsArray()
  chainIds: number[];
}

export class EvmDataCriterionDto {
  @IsIn(['evmData'])
  type: 'evmData';

  @IsIn(['==', 'in', 'not in', '<', '<=', '>', '>=', 'match'])
  operator: '==' | 'in' | 'not in' | '<' | '<=' | '>' | '>=' | 'match';

  @IsString()
  abi: string;

  @IsString()
  functionName: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

export class EvmMessageCriterionDto {
  @IsIn(['evmMessage'])
  type: 'evmMessage';

  @IsIn(['match'])
  operator: 'match';

  @IsString()
  pattern: string;
}

export class EvmTypedDataVerifyingContractCriterionDto {
  @IsIn(['evmTypedDataVerifyingContract'])
  type: 'evmTypedDataVerifyingContract';

  @IsIn(['in', 'not in'])
  operator: 'in' | 'not in';

  @IsArray()
  @IsString({ each: true })
  addresses: string[];
}

export class EvmTypedDataFieldCriterionDto {
  @IsIn(['evmTypedDataField'])
  type: 'evmTypedDataField';

  @IsIn(['in', '<=', 'match'])
  operator: 'in' | '<=' | 'match';

  @IsString()
  fieldPath: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  values?: string[];

  @IsOptional()
  @IsString()
  value?: string;
}

// ─── Operations ───────────────────────────────────────────────────────────────

export enum PolicyRuleOperationEnum {
  SIGN_EVM_TRANSACTION = 'signEvmTransaction',
  SEND_EVM_TRANSACTION = 'sendEvmTransaction',
  SIGN_EVM_MESSAGE = 'signEvmMessage',
  SIGN_EVM_TYPED_DATA = 'signEvmTypedData',
  SIGN_EVM_HASH = 'signEvmHash',
  SPONSOR_EVM_TRANSACTION = 'sponsorEvmTransaction',
}

// ─── Rule DTO ─────────────────────────────────────────────────────────────────

export class CreatePolicyRuleDto {
  @IsIn(['accept', 'reject'])
  action: 'accept' | 'reject';

  @IsEnum(PolicyRuleOperationEnum)
  operation: PolicyRuleOperationEnum;

  /** Criteria are passed as raw objects; Openfort validates them server-side. */
  @IsOptional()
  @IsArray()
  criteria?: Record<string, unknown>[];
}

// ─── Policy DTOs ──────────────────────────────────────────────────────────────

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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePolicyRuleDto)
  rules?: CreatePolicyRuleDto[];
}

export class UpdatePolicyDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePolicyRuleDto)
  rules?: CreatePolicyRuleDto[];
}
