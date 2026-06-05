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
      validate({ ...baseConfig, MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }),
    ).toThrow('MFA_SECRET_ENCRYPTION_KEY must be 32 base64-encoded bytes');
  });

  it('rejects invalid Openfort timeout values', () => {
    expect(() => validate({ ...baseConfig, OPENFORT_TIMEOUT_MS: '0' })).toThrow();
    expect(() =>
      validate({ ...baseConfig, OPENFORT_TIMEOUT_MS: '120001' }),
    ).toThrow();
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
      validate({ ...baseConfig, SECURITY_EVENTS_SIEM_WEBHOOK_URL: 'http://siem.example.com/events' }),
    ).toThrow('SECURITY_EVENTS_SIEM_WEBHOOK_URL must be a valid https URL');
  });
});
