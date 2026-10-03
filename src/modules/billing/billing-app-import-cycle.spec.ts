jest.mock('../../core/openfort/openfort.module', () => ({ OpenfortModule: class OpenfortModule {} }));
jest.mock('../../core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));

describe('Billing providers through AppModule import order', () => {
  it('retains lifecycle entitlement injection metadata when AppModule loads first', async () => {
    const envNames = [
      'OPENFORT_API_KEY',
      'OPENFORT_WALLET_SECRET',
      'DATABASE_URL',
      'MFA_SECRET_ENCRYPTION_KEY',
    ] as const;
    const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    try {
      process.env.OPENFORT_API_KEY = 'unit-test-openfort-key';
      process.env.OPENFORT_WALLET_SECRET = 'unit-test-openfort-wallet-secret';
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
      process.env.MFA_SECRET_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');

      // No billing service is statically imported in this spec. Load production's
      // root module first so the test exercises its actual module evaluation order.
      await import('../../app.module');
      const { BillingWalletLifecycleService } = await import('./billing-wallet-lifecycle.service');
      const { BillingEntitlementService } = await import('./billing-entitlement.service');
      const params = Reflect.getMetadata('design:paramtypes', BillingWalletLifecycleService) as unknown[];
      expect(params).toHaveLength(2);
      expect(params[1]).toBe(BillingEntitlementService);
    } finally {
      for (const name of envNames) {
        const value = oldEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
