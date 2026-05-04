import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  IsNotEmpty,
  IsString,
  Matches,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class InteractionDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'to must be a valid Ethereum address' })
  to: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(131074, { message: 'data must not exceed 64 KB' })
  @Matches(/^0x[0-9a-fA-F]*$/, { message: 'data must be hex-encoded (0x...)' })
  data: string;

  /** Value in wei (optional, defaults to '0'). Max uint256 = 78 digits. */
  @IsOptional()
  @IsString()
  @MaxLength(78, { message: 'value exceeds maximum uint256' })
  @Matches(/^\d+$/, { message: 'value must be a decimal string (wei)' })
  value?: string;
}

export class SendTransactionDto {
  /** Execution chain ID. Required for multi-chain safety. */
  @IsInt()
  @Min(1)
  chainId: number;

  @IsArray()
  @ArrayMinSize(1)
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
