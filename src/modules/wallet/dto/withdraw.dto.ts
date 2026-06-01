import {
  IsString,
  IsNotEmpty,
  IsIn,
  Matches,
  MaxLength,
  IsInt,
  Min,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

export type WithdrawalToken = 'USDC' | 'NATIVE';

/** USDC uses 6 decimals. Max single withdrawal: 10,000 USDC = 10_000_000_000 units. */
export const USDC_MAX_AMOUNT = BigInt('10000000000'); // 10k USDC in micro-units
/** High-value withdrawal threshold: 1,000 USDC = 1_000_000_000 units. */
export const USDC_HIGH_VALUE_AMOUNT = BigInt('1000000000');
/** Minimum withdrawal: 0.01 USDC = 10_000 units. */
export const USDC_MIN_AMOUNT = BigInt('10000');
/** Native tokens use 18 decimals. Max single withdrawal: 100 native tokens in wei. */
export const NATIVE_MAX_AMOUNT = BigInt('100000000000000000000');
/** High-value native threshold: 1 native token in wei. */
export const NATIVE_HIGH_VALUE_AMOUNT = BigInt('1000000000000000000');
/** Minimum native withdrawal: 1 wei. */
export const NATIVE_MIN_AMOUNT = 1n;

function getWithdrawalAmountBounds(token: unknown) {
  if (token === 'NATIVE') {
    return { min: NATIVE_MIN_AMOUNT, max: NATIVE_MAX_AMOUNT, label: 'native token wei' };
  }

  return { min: USDC_MIN_AMOUNT, max: USDC_MAX_AMOUNT, label: 'USDC micro-units' };
}

function IsWithdrawalAmount(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isWithdrawalAmount',
      target: (object as any).constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
          try {
            const n = BigInt(value);
            const bounds = getWithdrawalAmountBounds((args.object as WithdrawDto).token);
            return n >= bounds.min && n <= bounds.max;
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments): string {
          const bounds = getWithdrawalAmountBounds((args.object as WithdrawDto).token);
          return `${args.property} must be a numeric string between ${bounds.min} and ${bounds.max} in ${bounds.label}`;
        },
      },
    });
  };
}

export class WithdrawDto {
  /** Chain to withdraw from. Required so users explicitly choose the source chain. */
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
  @IsWithdrawalAmount()
  amount: string;

  @IsIn(['USDC', 'NATIVE'], { message: 'Token must be USDC or NATIVE' })
  token: WithdrawalToken;

  /** Required client-supplied idempotency key (UUID or similar, max 64 chars). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'idempotencyKey must be alphanumeric' })
  idempotencyKey: string;
}
