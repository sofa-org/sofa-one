import { IsUUID } from 'class-validator';

export class RefreshApiKeyDto {
  @IsUUID()
  walletId!: string;
}
