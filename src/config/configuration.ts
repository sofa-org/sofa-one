export default () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  clerk: {
    secretKey: process.env.CLERK_SECRET_KEY,
  },
  openfort: {
    apiKey: process.env.OPENFORT_API_KEY,
    walletSecret: process.env.OPENFORT_WALLET_SECRET,
    timeoutMs: parseInt(process.env.OPENFORT_TIMEOUT_MS || '15000', 10),
  },
  transactions: {
    reconciler: {
      enabled: process.env.TRANSACTION_RECONCILER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.TRANSACTION_RECONCILER_INTERVAL_MS || '60000', 10),
      staleAfterMs: parseInt(process.env.TRANSACTION_RECONCILER_STALE_AFTER_MS || '300000', 10),
      batchSize: parseInt(process.env.TRANSACTION_RECONCILER_BATCH_SIZE || '50', 10),
    },
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
});
