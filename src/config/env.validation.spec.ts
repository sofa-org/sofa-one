import { validate } from './env.validation';

describe('environment validation', () => {
  const baseConfig = {
    NODE_ENV: 'development',
    OPENFORT_API_KEY: 'sk_test_openfort',
    OPENFORT_WALLET_SECRET: 'wallet_secret',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/agent_wallet',
  };

  it('accepts the minimal development configuration', () => {
    expect(validate(baseConfig)).toEqual(expect.objectContaining(baseConfig));
  });

  it('requires CORS_ORIGIN in production', () => {
    expect(() => validate({ ...baseConfig, NODE_ENV: 'production' })).toThrow(
      'CORS_ORIGIN must be set in production',
    );
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

  it('rejects empty required secrets', () => {
    expect(() => validate({ ...baseConfig, OPENFORT_WALLET_SECRET: '' })).toThrow();
  });

  it('rejects invalid Openfort timeout values', () => {
    expect(() => validate({ ...baseConfig, OPENFORT_TIMEOUT_MS: '0' })).toThrow();
  });

  it('rejects unsupported default chains', () => {
    expect(() => validate({ ...baseConfig, DEFAULT_CHAIN_ID: '999999' })).toThrow(
      'DEFAULT_CHAIN_ID must be one of the supported chains',
    );
  });
});
