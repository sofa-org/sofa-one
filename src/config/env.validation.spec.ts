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

  it('accepts production when CORS_ORIGIN and the billing worker are configured', () => {
    expect(
      validate({
        ...baseConfig,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
        BILLING_WORKER_ENABLED: 'true',
      }),
    ).toEqual(expect.objectContaining({ NODE_ENV: 'production' }));
  });

  it('does not require STEP_UP_OTP_WEBHOOK_URL in production', () => {
    expect(
      validate({
        ...baseConfig,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
        BILLING_WORKER_ENABLED: 'true',
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
      'BILLING_USDC_TREASURY_ADDRESS_1 must be set when BILLING_USDC_ENABLED=true',
    );
    expect(() =>
      validate({
        ...baseConfig,
        BILLING_USDC_ENABLED: 'true',
        BILLING_USDC_TREASURY_ADDRESS_1: '0x1111111111111111111111111111111111111111',
        BILLING_USDC_TREASURY_ADDRESS_11155111: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x3333333333333333333333333333333333333333',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x4444444444444444444444444444444444444444',
        BILLING_USDC_RPC_URL_1: 'https://eth.example.com/rpc',
        BILLING_USDC_RPC_URL_11155111: 'https://sepolia.example.com/rpc',
        BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
      }),
    ).toThrow('BILLING_USDC_RPC_URL_84532 must be set when BILLING_USDC_ENABLED=true');
  });

  it('requires all four per-chain treasuries and RPC URLs when USDC billing is enabled', () => {
    const valid: Record<string, unknown> = {
      ...baseConfig,
      BILLING_USDC_ENABLED: 'true',
      BILLING_USDC_TREASURY_ADDRESS_1: '0x1111111111111111111111111111111111111111',
      BILLING_USDC_TREASURY_ADDRESS_11155111: '0x2222222222222222222222222222222222222222',
      BILLING_USDC_TREASURY_ADDRESS_8453: '0x3333333333333333333333333333333333333333',
      BILLING_USDC_TREASURY_ADDRESS_84532: '0x4444444444444444444444444444444444444444',
      BILLING_USDC_RPC_URL_1: 'https://eth.example.com/rpc',
      BILLING_USDC_RPC_URL_11155111: 'https://sepolia.example.com/rpc',
      BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
      BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
    };

    // Omitting any single chain's treasury or RPC fails closed.
    for (const missing of [
      'BILLING_USDC_TREASURY_ADDRESS_1',
      'BILLING_USDC_TREASURY_ADDRESS_11155111',
      'BILLING_USDC_TREASURY_ADDRESS_8453',
      'BILLING_USDC_TREASURY_ADDRESS_84532',
      'BILLING_USDC_RPC_URL_1',
      'BILLING_USDC_RPC_URL_11155111',
      'BILLING_USDC_RPC_URL_8453',
      'BILLING_USDC_RPC_URL_84532',
    ]) {
      const rest = { ...valid };
      delete rest[missing];
      expect(() => validate(rest)).toThrow(`${missing} must be set when BILLING_USDC_ENABLED=true`);
    }

    // Full four-chain configuration is accepted.
    expect(validate(valid)).toEqual(expect.objectContaining({ BILLING_USDC_ENABLED: 'true' }));
  });

  it('rejects malformed treasury addresses on every chain when USDC billing is enabled', () => {
    for (const key of [
      'BILLING_USDC_TREASURY_ADDRESS_1',
      'BILLING_USDC_TREASURY_ADDRESS_11155111',
      'BILLING_USDC_TREASURY_ADDRESS_8453',
      'BILLING_USDC_TREASURY_ADDRESS_84532',
    ]) {
      expect(() =>
        validate({
          ...baseConfig,
          BILLING_USDC_ENABLED: 'true',
          BILLING_USDC_TREASURY_ADDRESS_1: '0x1111111111111111111111111111111111111111',
          BILLING_USDC_TREASURY_ADDRESS_11155111: '0x2222222222222222222222222222222222222222',
          BILLING_USDC_TREASURY_ADDRESS_8453: '0x3333333333333333333333333333333333333333',
          BILLING_USDC_TREASURY_ADDRESS_84532: '0x4444444444444444444444444444444444444444',
          BILLING_USDC_RPC_URL_1: 'https://eth.example.com/rpc',
          BILLING_USDC_RPC_URL_11155111: 'https://sepolia.example.com/rpc',
          BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
          BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
          [key]: 'not-an-address',
        }),
      ).toThrow(`${key} must be a valid EVM address`);
    }
  });

  it('rejects malformed RPC URLs on every chain when USDC billing is enabled', () => {
    for (const key of [
      'BILLING_USDC_RPC_URL_1',
      'BILLING_USDC_RPC_URL_11155111',
      'BILLING_USDC_RPC_URL_8453',
      'BILLING_USDC_RPC_URL_84532',
    ]) {
      expect(() =>
        validate({
          ...baseConfig,
          BILLING_USDC_ENABLED: 'true',
          BILLING_USDC_TREASURY_ADDRESS_1: '0x1111111111111111111111111111111111111111',
          BILLING_USDC_TREASURY_ADDRESS_11155111: '0x2222222222222222222222222222222222222222',
          BILLING_USDC_TREASURY_ADDRESS_8453: '0x3333333333333333333333333333333333333333',
          BILLING_USDC_TREASURY_ADDRESS_84532: '0x4444444444444444444444444444444444444444',
          BILLING_USDC_RPC_URL_1: 'https://eth.example.com/rpc',
          BILLING_USDC_RPC_URL_11155111: 'https://sepolia.example.com/rpc',
          BILLING_USDC_RPC_URL_8453: 'https://base.example.com/rpc',
          BILLING_USDC_RPC_URL_84532: 'https://base-sepolia.example.com/rpc',
          [key]: 'ftp://example.com/rpc',
        }),
      ).toThrow(`${key} must be a valid https URL`);
    }
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
        BILLING_USDC_TREASURY_ADDRESS_1: '0x1111111111111111111111111111111111111111',
        BILLING_USDC_TREASURY_ADDRESS_11155111: '0x2222222222222222222222222222222222222222',
        BILLING_USDC_TREASURY_ADDRESS_8453: '0x3333333333333333333333333333333333333333',
        BILLING_USDC_TREASURY_ADDRESS_84532: '0x4444444444444444444444444444444444444444',
        BILLING_USDC_RPC_URL_1: 'https://eth.example.com/rpc',
        BILLING_USDC_RPC_URL_11155111: 'https://sepolia.example.com/rpc',
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

  describe('billing worker enabled flag', () => {
    it('accepts an unset BILLING_WORKER_ENABLED in development (safe default off)', () => {
      expect(validate(baseConfig)).toEqual(expect.objectContaining(baseConfig));
    });

    it('accepts BILLING_WORKER_ENABLED=false in development', () => {
      expect(validate({ ...baseConfig, BILLING_WORKER_ENABLED: 'false' })).toEqual(
        expect.objectContaining({ BILLING_WORKER_ENABLED: 'false' }),
      );
    });

    it('accepts BILLING_WORKER_ENABLED=true in development', () => {
      expect(validate({ ...baseConfig, BILLING_WORKER_ENABLED: 'true' })).toEqual(
        expect.objectContaining({ BILLING_WORKER_ENABLED: 'true' }),
      );
    });

    it('accepts BILLING_WORKER_ENABLED=false in test', () => {
      expect(validate({ ...baseConfig, NODE_ENV: 'test', BILLING_WORKER_ENABLED: 'false' })).toEqual(
        expect.objectContaining({ BILLING_WORKER_ENABLED: 'false' }),
      );
    });

    it('rejects a non-boolean BILLING_WORKER_ENABLED value', () => {
      expect(() => validate({ ...baseConfig, BILLING_WORKER_ENABLED: 'yes' })).toThrow();
    });

    it('requires BILLING_WORKER_ENABLED=true in production (never default-on)', () => {
      expect(() =>
        validate({
          ...baseConfig,
          NODE_ENV: 'production',
          CORS_ORIGIN: 'https://app.example.com',
        }),
      ).toThrow('BILLING_WORKER_ENABLED must be set to "true" in production');
    });

    it('rejects an explicit BILLING_WORKER_ENABLED=false in production', () => {
      expect(() =>
        validate({
          ...baseConfig,
          NODE_ENV: 'production',
          CORS_ORIGIN: 'https://app.example.com',
          BILLING_WORKER_ENABLED: 'false',
        }),
      ).toThrow('BILLING_WORKER_ENABLED must be set to "true" in production');
    });

    it('rejects a non-string true (e.g. numeric 1) in production', () => {
      expect(() =>
        validate({
          ...baseConfig,
          NODE_ENV: 'production',
          CORS_ORIGIN: 'https://app.example.com',
          BILLING_WORKER_ENABLED: '1',
        }),
      ).toThrow('BILLING_WORKER_ENABLED must be set to "true" in production');
    });

    it('accepts an explicit BILLING_WORKER_ENABLED=true in production', () => {
      expect(
        validate({
          ...baseConfig,
          NODE_ENV: 'production',
          CORS_ORIGIN: 'https://app.example.com',
          BILLING_WORKER_ENABLED: 'true',
        }),
      ).toEqual(
        expect.objectContaining({
          NODE_ENV: 'production',
          BILLING_WORKER_ENABLED: 'true',
        }),
      );
    });
  });

  describe('SIMULATION_RPC_URLS__<chainId>', () => {
    it('accepts valid https URLs for supported chain ids', () => {
      expect(
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS__84532: 'https://base-sepolia.example.com',
          SIMULATION_RPC_URLS__8453: 'https://base.example.com/v1',
        }),
      ).toEqual(
        expect.objectContaining({
          SIMULATION_RPC_URLS__84532: 'https://base-sepolia.example.com',
          SIMULATION_RPC_URLS__8453: 'https://base.example.com/v1',
        }),
      );
    });

    it('starts without any simulation RPC URLs (runtime debt-gate fails closed per chain)', () => {
      expect(validate(baseConfig)).toEqual(expect.objectContaining(baseConfig));
    });

    it('rejects non-https simulation RPC URLs', () => {
      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS__84532: 'http://insecure.example.com',
        }),
      ).toThrow('SIMULATION_RPC_URLS__84532 must be a valid https URL');
    });

    it('rejects invalid URL values', () => {
      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS__8453: 'not-a-url',
        }),
      ).toThrow('SIMULATION_RPC_URLS__8453 must be a valid https URL');
    });

    it('rejects unknown chain ids', () => {
      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS__999999: 'https://evil.example.com',
        }),
      ).toThrow('SIMULATION_RPC_URLS__999999 must use a supported chain id');
    });

    it('rejects non-numeric chain suffixes', () => {
      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS__abc: 'https://example.com',
        }),
      ).toThrow('SIMULATION_RPC_URLS__abc must use a numeric supported chain id');
    });

    it('rejects empty URL values for a declared chain key', () => {
      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS__84532: '   ',
        }),
      ).toThrow('SIMULATION_RPC_URLS__84532 must be a non-empty https URL');
    });

    it('rejects an empty SIMULATION_RPC_URLS object (not implicitly valid)', () => {
      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS: {},
        }),
      ).toThrow('SIMULATION_RPC_URLS empty object is not valid');

      expect(() =>
        validate({
          ...baseConfig,
          SIMULATION_RPC_URLS: '{}',
        }),
      ).toThrow('SIMULATION_RPC_URLS empty object is not valid');
    });
  });
});
