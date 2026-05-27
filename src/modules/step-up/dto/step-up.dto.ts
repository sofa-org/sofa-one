import { IsOptional } from 'class-validator';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class CreateChallengeDto {
  @IsOptional()
  @IsIn(['email_otp'])
  type?: string = 'email_otp';
}

export class VerifyChallengeDto {
  @IsString()
  @IsNotEmpty()
  challengeId!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;
}