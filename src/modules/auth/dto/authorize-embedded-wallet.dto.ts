import { IsEthereumAddress, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AuthorizeEmbeddedWalletDto {
  @IsString()
  openfortAccessToken: string;

  @IsEthereumAddress()
  embeddedWalletAddress: string;

  @IsString()
  @IsOptional()
  embeddedOpenfortAccountId?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  chainId?: number;
}
