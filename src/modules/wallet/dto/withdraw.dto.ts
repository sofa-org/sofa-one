import { IsString, IsNotEmpty, IsIn, Matches } from 'class-validator';

export class WithdrawDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'Invalid Ethereum address' })
  to: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'Amount must be a numeric string' })
  amount: string;

  @IsIn(['USDC'], { message: 'Token must be USDC' })
  token: string;
}
