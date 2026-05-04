import { IsIn, Matches } from 'class-validator';

export class AgentRegistrationResultDto {
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'txHash must be a valid transaction hash' })
  txHash: string;

  @IsIn(['registered', 'registration_failed'])
  status: 'registered' | 'registration_failed';
}
