import {
  IsInt,
  IsString,
  IsNotEmpty,
  IsIn,
  Matches,
  IsOptional,
  MaxLength,
  Min,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/** USDC uses 6 decimals. Max single withdrawal: 1,000,000 USDC = 1_000_000_000_000 units. */
const USDC_MAX_AMOUNT = BigInt('1000000000000'); // 1M USDC in micro-units
/** Minimum withdrawal: 0.01 USDC = 10_000 units. */
const USDC_MIN_AMOUNT = BigInt('10000');

function IsUsdcAmount(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isUsdcAmount',
      target: (object as any).constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
          try {
            const n = BigInt(value);
            return n >= USDC_MIN_AMOUNT && n <= USDC_MAX_AMOUNT;
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a numeric string between ${USDC_MIN_AMOUNT} (0.01 USDC) and ${USDC_MAX_AMOUNT} (1,000,000 USDC) in micro-units`;
        },
      },
    });
  };
}

export class WithdrawDto {
  @IsInt()
  @Min(1)
  chainId: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'Invalid Ethereum address' })
  to: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40) // prevent absurdly long strings before BigInt parse
  @IsUsdcAmount()
  amount: string;

  @IsIn(['USDC'], { message: 'Token must be USDC' })
  token: string;

  /** Optional client-supplied idempotency key (UUID or similar, max 64 chars). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_\-]+$/, { message: 'idempotencyKey must be alphanumeric' })
  idempotencyKey?: string;
}
