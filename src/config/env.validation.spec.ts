import { validate } from './env.validation';

describe('environment validation', () => {
  const mfaSecretEncryptionKey = Buffer.alloc(32, 1).toString('base64');
  const baseConfig = {
    NODE_ENV: 'development',
    OPENFORT_API_KEY: 'sk_test_openfort',
    OPENFORT_WALLET_SECRET: 'wallet_secret',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/agent_wallet',
    MFA_SECRET_ENCRYPTION_KEY: mfaSecretEncryptionKey,
  };

  it('accepts the minimal development configuration', () => {
    expect(validate(baseConfig)).toEqual(expect.objectContaining(baseConfig));
  });

  it('requires CORS_ORIGIN in production', () => {
    expect(() => validate({ ...baseConfig, NODE_ENV: 'production' })).toThrow(
      'CORS_ORIGIN must be set in production',
    );
  });

  it('rejects blank CORS_ORIGIN in production', () => {
    expect(() =>
      validate({
        ...baseConfig,
        NODE_ENV: 'production',
        CORS_ORIGIN: '   ',
      }),
    ).toThrow('CORS_ORIGIN must be set in production');
  });

  it('accepts production when CORS_ORIGIN is configured', () => {
    expect(
      validate({
        ...baseConfig,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
      }),
    ).toEqual(expect.objectContaining({ NODE_ENV: 'production' }));
  });

  it('does not require STEP_UP_OTP_WEBHOOK_URL in production', () => {
    expect(
      validate({
        ...baseConfig,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
      }),
    ).toEqual(expect.objectContaining({ NODE_ENV: 'production' }));
  });

  it('rejects empty required secrets', () => {
    expect(() => validate({ ...baseConfig, OPENFORT_WALLET_SECRET: '' })).toThrow();
  });

  it('rejects blank MFA_SECRET_ENCRYPTION_KEY', () => {
    expect(() => validate({ ...baseConfig, MFA_SECRET_ENCRYPTION_KEY: '   ' })).toThrow();
  });

  it('rejects missing MFA_SECRET_ENCRYPTION_KEY', () => {
    const configWithoutMfaKey: Partial<typeof baseConfig> = { ...baseConfig };
    delete configWithoutMfaKey.MFA_SECRET_ENCRYPTION_KEY;
    expect(() => validate(configWithoutMfaKey)).toThrow();
  });

  it('rejects MFA_SECRET_ENCRYPTION_KEY values that are not 32 bytes', () => {
    expect(() =>
      validate({
        ...baseConfig,
        MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
      }),
    ).toThrow('MFA_SECRET_ENCRYPTION_KEY must be 32 base64-encoded bytes');
  });

  it('rejects invalid Openfort timeout values', () => {
    expect(() => validate({ ...baseConfig, OPENFORT_TIMEOUT_MS: '0' })).toThrow();
    expect(() => validate({ ...baseConfig, OPENFORT_TIMEOUT_MS: '120001' })).toThrow();
  });

  it('rejects unsupported default chains', () => {
    expect(() => validate({ ...baseConfig, DEFAULT_CHAIN_ID: '999999' })).toThrow(
      'DEFAULT_CHAIN_ID must be one of the supported chains',
    );
  });

  it('validates EOA execution global opt-in as a boolean string', () => {
    expect(validate({ ...baseConfig, EOA_EXECUTION_ENABLED: 'true' })).toEqual(
      expect.objectContaining({ EOA_EXECUTION_ENABLED: 'true' }),
    );
    expect(() => validate({ ...baseConfig, EOA_EXECUTION_ENABLED: 'yes' })).toThrow();
  });

  it('validates optional SecurityEvent SIEM webhook URL as HTTPS', () => {
    expect(
      validate({
        ...baseConfig,
        SECURITY_EVENTS_SIEM_WEBHOOK_URL: 'https://siem.example.com/events',
      }),
    ).toEqual(
      expect.objectContaining({
        SECURITY_EVENTS_SIEM_WEBHOOK_URL: 'https://siem.example.com/events',
      }),
    );

    expect(() =>
      validate({
        ...baseConfig,
        SECURITY_EVENTS_SIEM_WEBHOOK_URL: 'http://siem.example.com/events',
      }),
    ).toThrow('SECURITY_EVENTS_SIEM_WEBHOOK_URL must be a valid https URL');
  });

  it('starts without Stripe configuration', () => {
    expect(validate(baseConfig)).toEqual(expect.objectContaining(baseConfig));
  });

  it('requires success/cancel URLs when Stripe is configured', () => {
    expect(() => validate({ ...baseConfig, STRIPE_SECRET_KEY: 'sk_test_123' })).toThrow(
      'STRIPE_SUCCESS_URL must be set when Stripe is configured',
    );
    expect(() =>
      validate({
        ...baseConfig,
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_SUCCESS_URL: 'https://app.example.com/billing?checkout=success',
      }),
    ).toThrow('STRIPE_CANCEL_URL must be set when Stripe is configured');
  });

  it('rejects non-https Stripe redirect URLs', () => {
    expect(() =>
      validate({
        ...baseConfig,
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_SUCCESS_URL: 'http://app.example.com/billing',
        STRIPE_CANCEL_URL: 'https://app.example.com/billing',
      }),
    ).toThrow('STRIPE_SUCCESS_URL must be a valid https URL');
  });

  it('accepts a complete Stripe configuration', () => {
    expect(
      validate({
        ...baseConfig,
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
        STRIPE_SUCCESS_URL: 'https://app.example.com/billing?checkout=success',
        STRIPE_CANCEL_URL: 'https://app.example.com/billing?checkout=cancelled',
      }),
    ).toEqual(
      expect.objectContaining({
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_SUCCESS_URL: 'https://app.example.com/billing?checkout=success',
      }),
    );
  });

  it('starts without USDC billing configuration', () => {
    expect(validate(baseConfig)).toEqual(
      expect.objectContaining({
        BILLING_USDC_REQUIRED_CONFIRMATIONS: 5,
        BILLING_USDC_QUOTE_TTL_SECONDS: 86400,
      }),
    );
  });

  it('requires both treasuries and RPC URLs when USDC billing is enabled', () => {
    expect(() => validate({ ...baseConfig, BILLING_USDC_ENABLED: 'true' })).toThrow(
      'BILLING_USDC_TREASURY_ADDRESS_8453 must be set when BILLING_USDC_ENABLED=true',
    );
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x1111111111111111111111111111111111111111',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_RPC_URL_84532 must be set when BILLING_USDC_ENABLED=true');
  });

  it('rejects malformed treasury addresses when USDC billing is enabled', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_8453: 'not-an-address',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
        BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_TREASURY_ADDRESS_8453 must be a valid EVM address');
  });

  it('rejects malformed RPC URLs when USDC billing is enabled', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x1111111111111111111111111111111111111111',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_RPC_URL_8453: 'ftp://base.example.com/rpc',
        BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_RPC_URL_8453 must be a valid https URL');
  });

  it('rejects non-https RPC URLs when USDC billing is enabled', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x1111111111111111111111111111111111111111',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_RPC_URL_8453: 'http://base.example.com/rpc',
        BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_RPC_URL_8453 must be a valid https URL');
  });

  it('rejects a non-https RPC URL even while USDC billing is disabled', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_RPC_URL_8453: 'http://base.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_RPC_URL_8453 must be a valid https URL');
  });

  it('rejects a zero-address treasury when USDC billing is enabled', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x0000000000000000000000000000000000000000',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
        BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_TREASURY_ADDRESS_8453 must not be the zero address');
  });

  it('rejects a zero-address treasury even while USDC billing is disabled', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x0000000000000000000000000000000000000000',
      }),
    ).toThrow('BILLING_USDC_TREASURY_ADDRESS_8453 must not be the zero address');
  });

  it('rejects fewer than 5 required confirmations', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_REQUIRED_CONFIRMATIONS: '4',
      }),
    ).toThrow();
    expect(
      validate({
        ...baseConfig,
        BILLING_USDC_REQUIRED_CONFIRMATIONS: '5',
      }),
    ).toEqual(expect.objectContaining({ BILLING_USDC_REQUIRED_CONFIRMATIONS: 5 }));
  });

  it('accepts a complete USDC billing configuration', () => {
    expect(
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x1111111111111111111111111111111111111111',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
        BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
        BILLING_USDC_REQUIRED_CONFIRMATIONS: '10',
        BILLING_USDC_QUOTE_TTL_SECONDS: '3600',
      }),
    ).toEqual(
      expect.objectContaining({
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_REQUIRED_CONFIRMATIONS: 10,
        BILLING_USDC_QUOTE_TTL_SECONDS: 3600,
      }),
    );
  });

  it('rejects invalid USDC confirmation/TTL values', () => {
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_REQUIRED_CONFIRMATIONS: '0',
      }),
    ).toThrow();
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_QUOTE_TTL_SECONDS: '0',
      }),
    ).toThrow();
  });
});
