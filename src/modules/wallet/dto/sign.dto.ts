import {
  IsNotEmpty,
  IsIn,
  IsObject,
  IsOptional,
  IsInt,
  Min,
  ValidateIf,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

export type SignMessage = string | { raw: `0x${string}` };

function isSignMessage(value: unknown): value is SignMessage {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const rawMessage = value as { raw?: unknown };
  return (
    Object.keys(value).length === 1 &&
    typeof rawMessage.raw === 'string' &&
    /^0x(?:[a-fA-F0-9]{2})*$/.test(rawMessage.raw)
  );
}

function IsSignMessage(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isSignMessage',
      validator: {
        validate: isSignMessage,
        defaultMessage: () => 'message must be a non-empty string or { raw: "0x..." } hex data',
      },
    },
    validationOptions,
  );
}

export class SignDto {
  /** Chain context for API-key authorization. Required for API-key message signing. */
  @IsOptional()
  @IsInt()
  @Min(1)
  chainId?: number;

  /** Signing method: 'message' (EIP-191) or 'typed_data' (EIP-712). Raw hash signing is intentionally disabled. */
  @IsIn(['message', 'typed_data'], {
    message: 'type must be message or typed_data',
  })
  type: 'message' | 'typed_data';

  /** Plain-text message or hex data to sign (required when type = 'message'). */
  @ValidateIf((o) => o.type === 'message')
  @IsNotEmpty({ message: 'message is required when type is message' })
  @IsSignMessage()
  message?: SignMessage;

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
}
