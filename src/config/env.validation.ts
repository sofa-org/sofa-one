import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';
import { SUPPORTED_CHAIN_IDS } from '../common/chains/supported-chains';

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
  @IsNotEmpty()
  CLERK_SECRET_KEY: string;

  @IsString()
  @IsNotEmpty()
  OPENFORT_API_KEY: string;

  @IsString()
  @IsNotEmpty()
  OPENFORT_WALLET_SECRET: string;

  @IsInt()
  @Min(1)
  @Max(120000)
  @IsOptional()
  OPENFORT_TIMEOUT_MS?: number;

  @IsString()
  @IsOptional()
  TRANSACTION_RECONCILER_ENABLED?: string;

  @IsInt()
  @Min(1000)
  @Max(86400000)
  @IsOptional()
  TRANSACTION_RECONCILER_INTERVAL_MS?: number;

  @IsInt()
  @Min(1000)
  @Max(86400000)
  @IsOptional()
  TRANSACTION_RECONCILER_STALE_AFTER_MS?: number;

  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  TRANSACTION_RECONCILER_BATCH_SIZE?: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsOptional()
  CORS_ORIGIN?: string;

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
  validateProductionConfig(validatedConfig);
  validateBooleanString(
    'TRANSACTION_RECONCILER_ENABLED',
    validatedConfig.TRANSACTION_RECONCILER_ENABLED,
  );
  validateDefaultChain(validatedConfig.DEFAULT_CHAIN_ID);
  return validatedConfig;
}

function validateProductionConfig(config: EnvironmentVariables) {
  if (config.NODE_ENV !== Environment.Production) return;

  if (!config.CORS_ORIGIN?.trim()) {
    throw new Error('CORS_ORIGIN must be set in production');
  }
}

function validateBooleanString(name: string, value: string | undefined) {
  if (value === undefined) return;
  if (value === 'true' || value === 'false') return;

  throw new Error(`${name} must be either "true" or "false"`);
}

function validateDefaultChain(rawChainId: string | undefined) {
  const chainId = Number(rawChainId ?? '84532');
  if (!Number.isInteger(chainId) || !SUPPORTED_CHAIN_IDS.includes(chainId)) {
    throw new Error(
      `DEFAULT_CHAIN_ID must be one of the supported chains: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
    );
  }
}
