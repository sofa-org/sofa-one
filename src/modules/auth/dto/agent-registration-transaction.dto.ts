import { IsInt, Matches, Min } from 'class-validator';

export class AgentRegistrationTransactionDto {
  @IsInt()
  @Min(1)
  chainId: number;

  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'txHash must be a valid transaction hash' })
  txHash: string;
}
