import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsString,
  Matches,
  IsOptional,
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
  @Matches(/^0x[0-9a-fA-F]*$/, { message: 'data must be hex-encoded (0x...)' })
  data: string;

  /** Value in wei (optional, defaults to '0'). */
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'value must be a decimal string (wei)' })
  value?: string;
}

export class SendTransactionDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InteractionDto)
  interactions: InteractionDto[];

  /** Optional Openfort policy ID for gas sponsorship. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  policyId?: string;

  /** Required idempotency key to prevent duplicate transaction submissions. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_\-]+$/, { message: 'idempotencyKey must be alphanumeric' })
  idempotencyKey: string;
}
