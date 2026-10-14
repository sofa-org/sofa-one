import { IsUUID } from 'class-validator';

export class RotateApiKeyDto {
  @IsUUID()
  walletId!: string;
}
