import { PrismaService } from '../../core/database/prisma.service';

const enabled = process.env.DEFI_POLICY_PG_TEST === 'true' && Boolean(process.env.DATABASE_URL);

describe('DeFi pause row cross-client serialization (PostgreSQL)', () => {
  (enabled ? it : it.skip)('a pause writer row lock blocks a final authorization shared lock across clients', async () => {
    const writer = new PrismaService();
    const authorizer = new PrismaService();
    let unlockWriter!: () => void;
    let signalLocked!: () => void;
    let signalAttempted!: () => void;
    const writerLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const attempted = new Promise<void>((resolve) => { signalAttempted = resolve; });
    const held = new Promise<void>((resolve) => { unlockWriter = resolve; });
    try {
      await Promise.all([writer.$connect(), authorizer.$connect()]);
      const writerTx = writer.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR UPDATE`;
        signalLocked();
        await held;
      }, { isolationLevel: 'ReadCommitted' });
      await writerLocked;
      let authorizerFinished = false;
      const authTx = authorizer.$transaction(async (tx) => {
        signalAttempted();
        await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE`;
      }, { isolationLevel: 'ReadCommitted' }).then(() => { authorizerFinished = true; });
      await attempted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(authorizerFinished).toBe(false);
      unlockWriter();
      await Promise.all([writerTx, authTx]);
      expect(authorizerFinished).toBe(true);
    } finally {
      unlockWriter?.();
      await Promise.allSettled([writer.$disconnect(), authorizer.$disconnect()]);
    }
  }, 10000);
});
