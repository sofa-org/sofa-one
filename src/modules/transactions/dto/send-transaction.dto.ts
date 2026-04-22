import { Type } from 'class-transformer';
import {
  IsArray,
  IsHexadecimal,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
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

  /** Optional idempotency key to prevent duplicate submissions. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  idempotencyKey?: string;
}
