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
        8453: process.env.BILLING_USDC_TREASURY_ADDRESS_8453,
        84532: process.env.BILLING_USDC_TREASURY_ADDRESS_84532,
      },
      rpcUrls: {
        8453: process.env.BILLING_USDC_RPC_URL_8453,
        84532: process.env.BILLING_USDC_RPC_URL_84532,
      },
      requiredConfirmations: parseInt(process.env.BILLING_USDC_REQUIRED_CONFIRMATIONS || '5', 10),
      quoteTtlSeconds: parseInt(process.env.BILLING_USDC_QUOTE_TTL_SECONDS || '86400', 10),
    },
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
