import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsObject,
  ValidateIf,
  Matches,
} from 'class-validator';

export class SignDto {
  /** Signing method: 'message' (EIP-191), 'typed_data' (EIP-712), or 'hash' (raw). */
  @IsIn(['message', 'typed_data', 'hash'], {
    message: 'type must be message, typed_data, or hash',
  })
  type: 'message' | 'typed_data' | 'hash';

  /** Plain-text message to sign (required when type = 'message'). */
  @ValidateIf((o) => o.type === 'message')
  @IsString()
  @IsNotEmpty({ message: 'message is required when type is message' })
  message?: string;

  /**
   * EIP-712 typed data object (required when type = 'typed_data').
   *
   * Must contain: domain, types, primaryType, message.
   * @example
   * {
   *   "domain": { "name": "MyDApp", "version": "1", "chainId": 8453 },
   *   "types": { "Mail": [{ "name": "to", "type": "address" }, { "name": "body", "type": "string" }] },
   *   "primaryType": "Mail",
   *   "message": { "to": "0x...", "body": "Hello" }
   * }
   */
  @ValidateIf((o) => o.type === 'typed_data')
  @IsObject({ message: 'typedData is required when type is typed_data' })
  @IsNotEmpty({ message: 'typedData is required when type is typed_data' })
  typedData?: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };

  /** 32-byte hex hash to sign (required when type = 'hash'). */
  @ValidateIf((o) => o.type === 'hash')
  @IsString()
  @IsNotEmpty({ message: 'hash is required when type is hash' })
  @Matches(/^0x[a-fA-F0-9]{64}$/, {
    message: 'hash must be a 32-byte hex string (0x + 64 hex chars)',
  })
  hash?: string;
}
