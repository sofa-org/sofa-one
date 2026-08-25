import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class TotpCodeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\d{6}|[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$/i, {
    message: 'code must be a 6-digit TOTP code or recovery code',
  })
  code!: string;
}
