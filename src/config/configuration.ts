import { SUPPORTED_CHAINS } from '../common/chains/supported-chains';

/**
 * Load shared per-chain RPC URLs from `RPC_URLS__<chainId>` env vars
 * (Nest-style double-underscore nested keys). Keys are numeric chain id strings.
 * Startup validation in env.validation.ts enforces supported chains + https;
 * it also rejects non-numeric / unknown-chain suffixes on the same prefix.
 */
function loadRpcUrls(): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const { chainId, chain } of Object.values(SUPPORTED_CHAINS)) {
    const url = chain.rpcUrls.default.http.find((candidate) => candidate.startsWith('https://'));
    if (!url) throw new Error(`No default HTTPS RPC for supported chain ${chainId}`);
    urls[String(chainId)] = url;
  }
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^RPC_URLS__(\d+)$/.exec(key);
    if (!match) continue;
    urls[match[1]] = typeof value === 'string' ? value.trim() : '';
  }
  return urls;
}

export default () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  openfort: {
    apiKey: process.env.OPENFORT_API_KEY,
    publishableKey: process.env.OPENFORT_PUBLISHABLE_KEY,
    walletSecret: process.env.OPENFORT_WALLET_SECRET,
    timeoutMs: parseInt(process.env.OPENFORT_TIMEOUT_MS || '15000', 10),
  },
  pimlico: {
    apiKey: process.env.PIMLICO_API_KEY,
    rpcUrls: {
      143: process.env.PIMLICO_RPC_URL_143,
      10143: process.env.PIMLICO_RPC_URL_10143,
    },
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    successUrl: process.env.STRIPE_SUCCESS_URL,
    cancelUrl: process.env.STRIPE_CANCEL_URL,
  },
  billing: {
    usdc: {
      enabled: process.env.BILLING_USDC_ENABLED === 'true',
      treasuryAddresses: {
        1: process.env.BILLING_USDC_TREASURY_ADDRESS_1,
        11155111: process.env.BILLING_USDC_TREASURY_ADDRESS_11155111,
        8453: process.env.BILLING_USDC_TREASURY_ADDRESS_8453,
        84532: process.env.BILLING_USDC_TREASURY_ADDRESS_84532,
      },
      rpcUrls: {
        1: process.env.BILLING_USDC_RPC_URL_1,
        11155111: process.env.BILLING_USDC_RPC_URL_11155111,
        8453: process.env.BILLING_USDC_RPC_URL_8453,
        84532: process.env.BILLING_USDC_RPC_URL_84532,
      },
      requiredConfirmations: parseInt(process.env.BILLING_USDC_REQUIRED_CONFIRMATIONS || '5', 10),
      quoteTtlSeconds: parseInt(process.env.BILLING_USDC_QUOTE_TTL_SECONDS || '86400', 10),
    },
    worker: {
      enabled: process.env.BILLING_WORKER_ENABLED === 'true',
    },
  },
  /**
   * Per-chain HTTPS RPCs shared by simulation and on-chain verification.
   * Registry defaults apply only when no explicit RPC_URLS__<chainId> is set.
   * Provider failures remain fail-closed; explicit overrides never fail over.
   */
  rpc: {
    urls: loadRpcUrls(),
  },
  security: {
    trustProxy: process.env.TRUST_PROXY,
  },
  chain: {
    defaultChainId: parseInt(process.env.DEFAULT_CHAIN_ID || '84532', 10),
  },
  redis: {
    url: process.env.REDIS_URL,
  },
});
