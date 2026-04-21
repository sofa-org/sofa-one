export default () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  clerk: {
    secretKey: process.env.CLERK_SECRET_KEY,
  },
  openfort: {
    apiKey: process.env.OPENFORT_API_KEY,
    walletSecret: process.env.OPENFORT_WALLET_SECRET,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  chain: {
    defaultChainId: parseInt(process.env.DEFAULT_CHAIN_ID || '84532', 10),
  },
});
