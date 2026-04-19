import {
  IsNumber,
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNotEmpty,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InteractionDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'Invalid contract address' })
  contract: string;

  @IsString()
  @IsNotEmpty()
  functionName: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  functionArgs?: string[];
}

export class CreateIntentDto {
  @IsNumber()
  chainId: number;

  @IsString()
  @IsOptional()
  policyId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InteractionDto)
  interactions: InteractionDto[];
}
