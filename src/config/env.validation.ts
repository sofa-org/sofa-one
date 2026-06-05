import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Matches,
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
  OPENFORT_API_KEY: string;

  @IsString()
  @IsOptional()
  OPENFORT_PUBLISHABLE_KEY?: string;

  @IsString()
  @IsNotEmpty()
  OPENFORT_WALLET_SECRET: string;

  @IsInt()
  @Min(1)
  @Max(120000)
  @IsOptional()
  OPENFORT_TIMEOUT_MS?: number;

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

  @IsString()
  @IsOptional()
  STEP_UP_OTP_WEBHOOK_URL?: string;

  @IsString()
  @IsOptional()
  STEP_UP_OTP_WEBHOOK_SECRET?: string;

  @IsBooleanString()
  @IsOptional()
  EOA_EXECUTION_ENABLED?: string;

  @IsString()
  @IsOptional()
  SECURITY_EVENTS_SIEM_WEBHOOK_URL?: string;

  @IsString()
  @IsOptional()
  SECURITY_EVENTS_SIEM_WEBHOOK_SECRET?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'MFA_SECRET_ENCRYPTION_KEY must not be blank' })
  MFA_SECRET_ENCRYPTION_KEY: string;
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
  validateOptionalHttpsUrl(
    validatedConfig.SECURITY_EVENTS_SIEM_WEBHOOK_URL,
    'SECURITY_EVENTS_SIEM_WEBHOOK_URL',
  );
  validateOptionalHttpsUrl(validatedConfig.STEP_UP_OTP_WEBHOOK_URL, 'STEP_UP_OTP_WEBHOOK_URL');
  validateDefaultChain(validatedConfig.DEFAULT_CHAIN_ID);
  validateMfaSecretEncryptionKey(validatedConfig.MFA_SECRET_ENCRYPTION_KEY);
  return validatedConfig;
}

function validateProductionConfig(config: EnvironmentVariables) {
  if (config.NODE_ENV !== Environment.Production) return;

  if (!config.CORS_ORIGIN?.trim()) {
    throw new Error('CORS_ORIGIN must be set in production');
  }

}

function validateOptionalHttpsUrl(rawUrl: string | undefined, name: string) {
  if (!rawUrl?.trim()) return;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error(`${name} must be a valid https URL`);
  }
}

function validateDefaultChain(rawChainId: string | undefined) {
  const chainId = Number(rawChainId ?? '84532');
  if (!Number.isInteger(chainId) || !SUPPORTED_CHAIN_IDS.includes(chainId)) {
    throw new Error(
      `DEFAULT_CHAIN_ID must be one of the supported chains: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
    );
  }
}

function validateMfaSecretEncryptionKey(rawKey: string) {
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) {
    throw new Error('MFA_SECRET_ENCRYPTION_KEY must be 32 base64-encoded bytes');
  }
}
