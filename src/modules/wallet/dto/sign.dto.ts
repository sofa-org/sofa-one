import {
  IsNotEmpty,
  IsIn,
  IsObject,
  IsOptional,
  IsInt,
  Min,
  IsUUID,
} from 'class-validator';

export type ExecutionMode = 'eoa';

export class SignDto {
  @IsOptional()
  @IsUUID()
  walletId?: string;
  /** Signs with the user's EOA backend wallet (the default). */
  @IsOptional()
  @IsIn(['eoa'], {
    message: 'executionMode must be eoa',
  })
  executionMode?: ExecutionMode;

  /** Optional when typedData.domain.chainId is present. */
  @IsOptional()
  @IsInt()
  @Min(1)
  chainId?: number;

  /** Only approved EIP-712 typed-data signing is supported. */
  @IsIn(['typed_data'], {
    message: 'type must be typed_data',
  })
  type: 'typed_data';

  /**
   * Exact approved Polymarket ClobAuth, CLOB V2 order, or DepositWallet Batch
   * payload. Domain, types, primaryType and message are checked by the signing
   * policy; domain.chainId is required and must match any top-level chainId.
   */
  @IsObject({ message: 'typedData is required when type is typed_data' })
  @IsNotEmpty({ message: 'typedData is required when type is typed_data' })
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}
