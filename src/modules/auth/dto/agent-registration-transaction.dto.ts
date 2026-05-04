import { Matches } from 'class-validator';

export class AgentRegistrationTransactionDto {
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'txHash must be a valid transaction hash' })
  txHash: string;
}
