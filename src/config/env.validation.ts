import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsNumber()
  @IsOptional()
  PORT: number = 3001;

  @IsString()
  CLERK_SECRET_KEY: string;

  @IsString()
  OPENFORT_API_KEY: string;

  @IsString()
  OPENFORT_WALLET_SECRET: string;

  @IsNumber()
  @IsOptional()
  OPENFORT_TIMEOUT_MS?: number;

  @IsString()
  @IsOptional()
  TRANSACTION_RECONCILER_ENABLED?: string;

  @IsNumber()
  @IsOptional()
  TRANSACTION_RECONCILER_INTERVAL_MS?: number;

  @IsNumber()
  @IsOptional()
  TRANSACTION_RECONCILER_STALE_AFTER_MS?: number;

  @IsNumber()
  @IsOptional()
  TRANSACTION_RECONCILER_BATCH_SIZE?: number;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  @IsString()
  @IsOptional()
  DEFAULT_CHAIN_ID?: string;

  @IsString()
  @IsOptional()
  TRUST_PROXY?: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validatedConfig;
}
