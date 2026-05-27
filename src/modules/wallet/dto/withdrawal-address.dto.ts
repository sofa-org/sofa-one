import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateWithdrawalAddressDto {
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'Invalid Ethereum address' })
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}
