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
  @IsOptional()
  STRIPE_SECRET_KEY?: string;

  @IsString()
  @IsOptional()
  STRIPE_WEBHOOK_SECRET?: string;

  @IsString()
  @IsOptional()
  STRIPE_SUCCESS_URL?: string;

  @IsString()
  @IsOptional()
  STRIPE_CANCEL_URL?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'MFA_SECRET_ENCRYPTION_KEY must not be blank' })
  MFA_SECRET_ENCRYPTION_KEY: string;

  // ── USDC billing (Phase 3B foundation — optional) ─────────────────────────
  // Feature is off unless BILLING_USDC_ENABLED=true; when off, none of the
  // USDC variables are required and the app starts normally. When on, both
  // per-chain treasuries and RPC URLs are required and format-validated.
  @IsBooleanString()
  @IsOptional()
  BILLING_USDC_ENABLED?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_TREASURY_ADDRESS_8453?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_TREASURY_ADDRESS_84532?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_TREASURY_ADDRESS_1?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_TREASURY_ADDRESS_11155111?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_RPC_URL_8453?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_RPC_URL_84532?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_RPC_URL_1?: string;

  @IsString()
  @IsOptional()
  BILLING_USDC_RPC_URL_11155111?: string;

  @IsInt()
  @Min(5)
  @Max(100)
  @IsOptional()
  BILLING_USDC_REQUIRED_CONFIRMATIONS?: number = 5;

  @IsInt()
  @Min(1)
  @Max(604800)
  @IsOptional()
  BILLING_USDC_QUOTE_TTL_SECONDS?: number = 86400;

  // ── Billing worker (Phase 1 foundation — default OFF) ────────────────────
  // The worker is a separate service seam that drains reconciliation,
  // finalization catch-up, USDC active-claim recovery, and deferred Stripe
  // renewal retries. It is safely disabled unless explicitly enabled.
  // Development/test may leave it unset/false; production MUST set the
  // literal string "true" (validated in validateBillingWorkerConfig).
  @IsBooleanString()
  @IsOptional()
  BILLING_WORKER_ENABLED?: string;
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
  validateStripeConfig(validatedConfig);
  validateUsdcConfig(validatedConfig);
  validateBillingWorkerConfig(validatedConfig);
  validateSimulationRpcUrls(config);
  return validatedConfig;
}

/**
 * Per-chain debt-gate simulation RPCs (`SIMULATION_RPC_URLS__<chainId>`).
 *
 * - Keys must be numeric string chain ids present in SUPPORTED_CHAINS.
 * - Values must be non-empty https:// URLs (no http, no blanks).
 * - Present-but-empty values are rejected (empty is not implicitly valid).
 * - Unknown / non-numeric chain suffixes fail startup.
 * - Absence of all keys is allowed at boot; runtime debt-gate fails closed
 *   per-chain via BILLING_ASSET_FLOW_UNVERIFIABLE when a URL is missing.
 */
export function validateSimulationRpcUrls(config: Record<string, unknown>): void {
  const prefix = 'SIMULATION_RPC_URLS__';
  let sawAny = false;

  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(prefix)) continue;
    sawAny = true;

    const chainPart = key.slice(prefix.length);
    if (!/^\d+$/.test(chainPart)) {
      throw new Error(
        `${key} must use a numeric supported chain id (got non-numeric suffix)`,
      );
    }

    const chainId = Number(chainPart);
    if (!Number.isSafeInteger(chainId) || !SUPPORTED_CHAIN_IDS.includes(chainId)) {
      throw new Error(
        `${key} must use a supported chain id: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
      );
    }

    if (typeof value !== 'string' || !value.trim()) {
      // Empty object/value is not implicitly legal for a declared chain key.
      throw new Error(`${key} must be a non-empty https URL`);
    }

    validateRpcUrl(value.trim(), key);
  }

  // A bare empty map is fine (no keys). Reject an explicit empty JSON object
  // if operators set SIMULATION_RPC_URLS="{}" (Nest may pass through as string).
  const bare = config.SIMULATION_RPC_URLS;
  if (bare !== undefined && bare !== null) {
    if (typeof bare === 'string' && bare.trim() === '') {
      throw new Error('SIMULATION_RPC_URLS must not be an empty value; use SIMULATION_RPC_URLS__<chainId>');
    }
    if (typeof bare === 'object' && !Array.isArray(bare) && Object.keys(bare as object).length === 0) {
      throw new Error(
        'SIMULATION_RPC_URLS empty object is not valid; set SIMULATION_RPC_URLS__<chainId>=https://...',
      );
    }
    if (typeof bare === 'string' && bare.trim() === '{}') {
      throw new Error(
        'SIMULATION_RPC_URLS empty object is not valid; set SIMULATION_RPC_URLS__<chainId>=https://...',
      );
    }
  }

  void sawAny;
}

function validateProductionConfig(config: EnvironmentVariables) {
  if (config.NODE_ENV !== Environment.Production) return;

  if (!config.CORS_ORIGIN?.trim()) {
    throw new Error('CORS_ORIGIN must be set in production');
  }
}

/**
 * The billing worker must be explicitly enabled in production: the literal
 * string `true` is required, never a default-on, never a bare truthy value.
 * Development/test keep the safe default (unset or `false`) so the app starts
 * normally without the reconciliation/finalization loop.
 */
function validateBillingWorkerConfig(config: EnvironmentVariables) {
  if (config.NODE_ENV !== Environment.Production) return;
  if (config.BILLING_WORKER_ENABLED !== 'true') {
    throw new Error('BILLING_WORKER_ENABLED must be set to "true" in production');
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

/**
 * Stripe billing is optional: with no `STRIPE_SECRET_KEY` the app and all
 * non-payment functionality start normally. When Stripe IS configured, the
 * server-side success/cancel URLs are required and must be valid https URLs —
 * they are never accepted from the client.
 */
function validateStripeConfig(config: EnvironmentVariables) {
  if (!config.STRIPE_SECRET_KEY?.trim()) return;
  if (!config.STRIPE_SUCCESS_URL?.trim()) {
    throw new Error('STRIPE_SUCCESS_URL must be set when Stripe is configured');
  }
  if (!config.STRIPE_CANCEL_URL?.trim()) {
    throw new Error('STRIPE_CANCEL_URL must be set when Stripe is configured');
  }
  validateOptionalHttpsUrl(config.STRIPE_SUCCESS_URL, 'STRIPE_SUCCESS_URL');
  validateOptionalHttpsUrl(config.STRIPE_CANCEL_URL, 'STRIPE_CANCEL_URL');
}

/**
 * USDC billing is optional: with `BILLING_USDC_ENABLED` unset/false the app
 * and all non-USDC functionality start normally. When enabled, every
 * supported USDC chain (Base 8453, Base Sepolia 84532, Ethereum mainnet 1,
 * Ethereum Sepolia 11155111) must have a static treasury address (EVM format,
 * never the zero address) and an HTTPS RPC URL; confirmations (minimum 5) and
 * quote TTL are validated by the class decorators with defaults of 5 and
 * 86400.
 *
 * Treasury addresses and RPC URLs are format-validated whenever they are
 * provided (even while the feature is disabled) so a misconfigured value never
 * silently passes; only required-ness is gated on the enabled flag.
 *
 * Token addresses are intentionally NOT configured here — they are derived
 * from the existing `SUPPORTED_CHAINS` registry at runtime. Addresses are
 * format-validated only; no cross-assertion against user wallets is made at
 * env-validation time (that belongs to runtime/operator checks).
 */
function validateUsdcConfig(config: EnvironmentVariables) {
  for (const chain of USDC_BILLING_CHAINS) {
    const treasury = config[chain.treasuryKey] as string | undefined;
    const rpc = config[chain.rpcKey] as string | undefined;

    if (treasury?.trim()) validateEthereumAddress(treasury, chain.treasuryKey);
    if (rpc?.trim()) validateRpcUrl(rpc, chain.rpcKey);
  }

  if (config.BILLING_USDC_ENABLED !== 'true') return;

  for (const chain of USDC_BILLING_CHAINS) {
    const treasury = config[chain.treasuryKey] as string | undefined;
    const rpc = config[chain.rpcKey] as string | undefined;

    if (!treasury?.trim()) {
      throw new Error(`${chain.treasuryKey} must be set when BILLING_USDC_ENABLED=true`);
    }
    if (!rpc?.trim()) {
      throw new Error(`${chain.rpcKey} must be set when BILLING_USDC_ENABLED=true`);
    }
  }
}

/**
 * USDC billing chains (Ethereum mainnet, Ethereum Sepolia, Base + Base
 * Sepolia). All are in SUPPORTED_CHAINS.
 */
const USDC_BILLING_CHAINS: ReadonlyArray<{
  chainId: number;
  treasuryKey: keyof EnvironmentVariables;
  rpcKey: keyof EnvironmentVariables;
}> = [
  {
    chainId: 1,
    treasuryKey: 'BILLING_USDC_TREASURY_ADDRESS_1',
    rpcKey: 'BILLING_USDC_RPC_URL_1',
  },
  {
    chainId: 11155111,
    treasuryKey: 'BILLING_USDC_TREASURY_ADDRESS_11155111',
    rpcKey: 'BILLING_USDC_RPC_URL_11155111',
  },
  {
    chainId: 8453,
    treasuryKey: 'BILLING_USDC_TREASURY_ADDRESS_8453',
    rpcKey: 'BILLING_USDC_RPC_URL_8453',
  },
  {
    chainId: 84532,
    treasuryKey: 'BILLING_USDC_TREASURY_ADDRESS_84532',
    rpcKey: 'BILLING_USDC_RPC_URL_84532',
  },
];

/** A token/treasury contract address is exactly 20 bytes (40 hex chars). */
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/** The burn/zero address is never a valid treasury. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function validateEthereumAddress(address: string, name: string): void {
  if (!EVM_ADDRESS_REGEX.test(address)) {
    throw new Error(`${name} must be a valid EVM address (0x + 40 hex characters)`);
  }
  if (address.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${name} must not be the zero address`);
  }
}

function validateRpcUrl(rawUrl: string, name: string): void {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error(`${name} must be a valid https URL`);
  }
}
