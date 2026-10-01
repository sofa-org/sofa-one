import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  IsNotEmpty,
  IsString,
  Matches,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
  ValidateNested,
  IsIn,
  IsUUID,
} from 'class-validator';

export type ExecutionMode = 'session_key' | 'eoa';
export type SponsorshipMode = 'required' | 'none';

export const MAX_TRANSACTION_INTERACTIONS = 10;
export const MAX_INTERACTION_CALLDATA_BYTES = 64 * 1024;
export const MAX_INTERACTION_CALLDATA_HEX_LENGTH = 2 + MAX_INTERACTION_CALLDATA_BYTES * 2;

export class InteractionDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'to must be a valid Ethereum address' })
  to: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_INTERACTION_CALLDATA_HEX_LENGTH, { message: 'data must not exceed 64 KB' })
  @Matches(/^0x(?:[0-9a-fA-F]{2})*$/, {
    message: 'data must be byte-aligned hex-encoded (0x...)',
  })
  data: string;

  /** Value in wei (optional, defaults to '0'). Max uint256 = 78 digits. */
  @IsOptional()
  @IsString()
  @MaxLength(78, { message: 'value exceeds maximum uint256' })
  @Matches(/^\d+$/, { message: 'value must be a decimal string (wei)' })
  value?: string;
}

export class SendTransactionDto {
  /** Optional owned wallet selector for multi-wallet accounts. */
  @IsOptional()
  @IsUUID()
  walletId?: string;

  /** Which backend wallet authority executes: session key (default) or the user's EOA backend wallet. */
  @IsOptional()
  @IsIn(['session_key', 'eoa'], {
    message: 'executionMode must be session_key or eoa',
  })
  executionMode?: ExecutionMode;

  @IsOptional()
  @IsIn(['required', 'none'], {
    message: 'sponsorship must be required or none',
  })
  sponsorship?: SponsorshipMode;

  /** Execution chain ID. Required for multi-chain safety. */
  @IsInt()
  @Min(1)
  chainId: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRANSACTION_INTERACTIONS)
  @ValidateNested({ each: true })
  @Type(() => InteractionDto)
  interactions: InteractionDto[];

  /** Required idempotency key to prevent duplicate transaction submissions. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'idempotencyKey must be alphanumeric' })
  idempotencyKey: string;
}
