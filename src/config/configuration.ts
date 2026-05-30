export default () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  openfort: {
    apiKey: process.env.OPENFORT_API_KEY,
    publishableKey: process.env.OPENFORT_PUBLISHABLE_KEY,
    walletSecret: process.env.OPENFORT_WALLET_SECRET,
    timeoutMs: parseInt(process.env.OPENFORT_TIMEOUT_MS || '15000', 10),
  },
  database: {
    url: process.env.DATABASE_URL,
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
