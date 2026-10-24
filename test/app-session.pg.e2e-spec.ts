/** Real persisted session/MFA boundaries. Only the disposable E2E database is permitted. */
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { PrismaService } from '../src/core/database/prisma.service';
import { AppSessionService } from '../src/modules/app-session/app-session.service';
import { StepUpService } from '../src/modules/step-up/step-up.service';
import { MfaService } from '../src/modules/mfa/mfa.service';
import { applyBillingE2eDatabaseUrl, assertBillingE2eDatabaseIdentity, queryBillingE2eIdentityWithPrisma, resolveBillingE2eDatabaseTarget } from './billing-e2e-database';

const target = process.env.BILLING_E2E_DATABASE_URL ? resolveBillingE2eDatabaseTarget() : null;
if (target) applyBillingE2eDatabaseUrl(target);
const prisma = target ? new PrismaService() : null;
const run = target ? describe : describe.skip;
const originalTotpOptions = authenticator.options;
const recoveryCode = 'ABCD-EFGH-JKLM';

function database() {
  if (!prisma) throw new Error('Runner-provisioned disposable PostgreSQL target required');
  return prisma;
}
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  // Node 20 is supported by this repo and has no Promise.withResolvers().
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
class PausedSessionService extends AppSessionService {
  nextLock: { entered: Deferred; release: Deferred } | undefined;
  override async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await super.lockUser(tx, userId);
    const gate = this.nextLock;
    this.nextLock = undefined;
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
  }
}
function services() {
  const db = database();
  const config = new ConfigService({ NODE_ENV: 'development', MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') });
  const sessions = new PausedSessionService(db, config);
  const stepUp = new StepUpService(db, sessions);
  const mfa = new MfaService(db, config, stepUp, sessions);
  authenticator.options = { ...authenticator.options, epoch: Date.UTC(2026, 9, 22, 12), step: 30, window: 1 };
  return { sessions, stepUp, mfa };
}

run('application session PostgreSQL security and concurrency', () => {
  const userIds: string[] = [];
  beforeAll(async () => {
    if (!target) throw new Error('Runner-provisioned disposable PostgreSQL target required');
    await assertBillingE2eDatabaseIdentity(target, () => queryBillingE2eIdentityWithPrisma(database()));
  });
  afterEach(async () => {
    for (const id of userIds.splice(0)) await database().user.delete({ where: { id } });
    jest.restoreAllMocks();
  });
  afterAll(async () => { authenticator.options = originalTotpOptions; await prisma?.$disconnect(); });

  async function fixture(enabled = true) {
    const user = await database().user.create({ data: { socialProvider: 'test', socialId: `app-session-${randomUUID()}` } });
    userIds.push(user.id);
    const s = services();
    const login = await s.sessions.exchange(user.id, undefined);
    const setup = await s.mfa.setupTotp(user.id, login.session.id);
    if (enabled) {
      const credential = await database().userMfaTotpCredential.update({ where: { userId: user.id }, data: { status: 'enabled', enabledAt: new Date() } });
      await database().userMfaTotpRecoveryCode.create({ data: { credentialId: credential.id, codeHash: await argon2.hash(recoveryCode, { type: argon2.argon2id }) } });
    }
    return { ...s, user, login, secret: setup.secret };
  }

  it('keeps setup/enable pending until verification, with immutable one-hour expiry and session-bound proof', async () => {
    const f = await fixture(false);
    const code = authenticator.generate(f.secret);
    const enabled = await f.mfa.enableTotp(f.user.id, f.login.session.id, code);
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect((await f.sessions.authenticate(f.login.token)).mfaVerified).toBe(false);
    const proof = await f.mfa.verifyTotp(f.user.id, f.login.session.id, code);
    const upgraded = await f.sessions.authenticate(f.login.token);
    expect(upgraded.mfaVerified).toBe(true);
    expect(upgraded.expiresAt).toEqual(f.login.session.expiresAt);
    expect(await f.stepUp.validateProof(proof.proofToken, f.user.id, upgraded.id)).toBe(true);
    const other = await f.sessions.exchange(f.user.id, undefined);
    expect(await f.stepUp.validateProof(proof.proofToken, f.user.id, other.session.id)).toBe(false);
    expect(await f.stepUp.validateProof(proof.proofToken, randomUUID(), upgraded.id)).toBe(false);
  });

  it('rejects database-expired sessions when the PostgreSQL server uses a non-UTC timezone', async () => {
    const f = await fixture();
    await f.mfa.verifyTotp(f.user.id, f.login.session.id, authenticator.generate(f.secret));
    expect((await f.sessions.authenticate(f.login.token)).mfaVerified).toBe(true);
    await database().$executeRaw`
      UPDATE app_sessions SET created_at = clock_timestamp() - INTERVAL '2 hours',
        mfa_pending_until = clock_timestamp() - INTERVAL '90 minutes',
        expires_at = clock_timestamp() - INTERVAL '1 hour'
      WHERE id = ${f.login.session.id}::uuid`;
    await expect(f.sessions.authenticate(f.login.token)).rejects.toThrow(UnauthorizedException);
  });

  it('revokes old session proofs on cookie replacement and never carries full MFA into the replacement', async () => {
    const f = await fixture();
    const proof = await f.mfa.verifyTotp(f.user.id, f.login.session.id, authenticator.generate(f.secret));
    const replacement = await f.sessions.exchange(f.user.id, f.login.token);
    expect(replacement.session.mfaVerified).toBe(false);
    await expect(f.sessions.authenticate(f.login.token)).rejects.toThrow(UnauthorizedException);
    expect(await f.stepUp.validateProof(proof.proofToken, f.user.id, f.login.session.id)).toBe(false);
    expect(await database().stepUpChallenge.count({ where: { sessionId: f.login.session.id } })).toBe(0);
    expect((await database().user.findUniqueOrThrow({ where: { id: f.user.id } })).socialId).toBe(f.user.socialId);
  });

  it('serializes concurrent consumption of the same recovery code across two sessions', async () => {
    const f = await fixture();
    const second = await f.sessions.exchange(f.user.id, undefined);
    const results = await Promise.allSettled([
      f.mfa.verifyTotp(f.user.id, f.login.session.id, recoveryCode),
      f.mfa.verifyTotp(f.user.id, second.session.id, recoveryCode),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await database().appSession.count({ where: { userId: f.user.id, mfaVerified: true } })).toBe(1);
    expect(await database().stepUpChallenge.count({ where: { userId: f.user.id } })).toBe(1);
    expect(await database().userMfaTotpRecoveryCode.count({ where: { credential: { userId: f.user.id }, usedAt: { not: null } } })).toBe(1);
  });

  it('cannot resurrect a session when logout wins the lock before verification', async () => {
    const f = await fixture();
    const gate = { entered: deferred(), release: deferred() };
    f.sessions.nextLock = gate;
    const logout = f.sessions.revoke(f.user.id, f.login.session.id);
    await gate.entered.promise;
    const verify = f.mfa.verifyTotp(f.user.id, f.login.session.id, recoveryCode);
    gate.release.resolve();
    await logout;
    await expect(verify).rejects.toThrow(UnauthorizedException);
    expect(await database().stepUpChallenge.count({ where: { userId: f.user.id } })).toBe(0);
    expect((await database().appSession.findUniqueOrThrow({ where: { id: f.login.session.id } })).mfaVerified).toBe(false);
  });

  it('deletes a just-issued proof when verification wins the lock before logout', async () => {
    const f = await fixture();
    const gate = { entered: deferred(), release: deferred() };
    f.sessions.nextLock = gate;
    const verify = f.mfa.verifyTotp(f.user.id, f.login.session.id, recoveryCode);
    await gate.entered.promise;
    const logout = f.sessions.revoke(f.user.id, f.login.session.id);
    gate.release.resolve();
    const proof = await verify;
    await logout;
    expect(await f.stepUp.validateProof(proof.proofToken, f.user.id, f.login.session.id)).toBe(false);
    expect(await database().stepUpChallenge.count({ where: { sessionId: f.login.session.id } })).toBe(0);
    await expect(f.sessions.authenticate(f.login.token)).rejects.toThrow(UnauthorizedException);
  });

  it('rolls back recovery consumption and MFA upgrade when proof persistence fails', async () => {
    const f = await fixture();
    const suffix = f.user.id.replace(/-/g, '');
    const functionName = `reject_session_proof_${suffix}`;
    await database().$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = '${f.user.id}'::uuid THEN RAISE EXCEPTION 'injected proof persistence failure'; END IF; RETURN NEW; END $$`);
    await database().$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT ON step_up_challenges FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await expect(f.mfa.verifyTotp(f.user.id, f.login.session.id, recoveryCode)).rejects.toThrow();
      expect((await f.sessions.authenticate(f.login.token)).mfaVerified).toBe(false);
      expect(await database().stepUpChallenge.count({ where: { userId: f.user.id } })).toBe(0);
      expect(await database().userMfaTotpRecoveryCode.count({ where: { credential: { userId: f.user.id }, usedAt: null } })).toBe(1);
    } finally {
      await database().$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${functionName} ON step_up_challenges`);
      await database().$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('invalidates all sessions/proofs on logout-all and factor disable', async () => {
    const f = await fixture();
    const code = authenticator.generate(f.secret);
    const firstProof = await f.mfa.verifyTotp(f.user.id, f.login.session.id, code);
    const second = await f.sessions.exchange(f.user.id, undefined);
    const secondProof = await f.mfa.verifyTotp(f.user.id, second.session.id, code);
    await f.sessions.revokeAll(f.user.id, f.login.session.id);
    expect(await f.stepUp.validateProof(firstProof.proofToken, f.user.id, f.login.session.id)).toBe(false);
    expect(await f.stepUp.validateProof(secondProof.proofToken, f.user.id, second.session.id)).toBe(false);
    await expect(f.sessions.authenticate(second.token)).rejects.toThrow(UnauthorizedException);
    const third = await f.sessions.exchange(f.user.id, undefined);
    await f.mfa.verifyTotp(f.user.id, third.session.id, code);
    await f.mfa.disableTotp(f.user.id, third.session.id, code);
    expect(await database().appSession.count({ where: { userId: f.user.id, revokedAt: null } })).toBe(0);
    expect(await database().stepUpChallenge.count({ where: { userId: f.user.id } })).toBe(0);
    expect((await database().userMfaTotpCredential.findUniqueOrThrow({ where: { userId: f.user.id } })).status).toBe('disabled');
  });

  it('serializes initial enable against another pending session attempting setup or enable', async () => {
    const f = await fixture(false);
    const second = await f.sessions.exchange(f.user.id, undefined);
    const gate = { entered: deferred(), release: deferred() };
    f.sessions.nextLock = gate;
    const firstEnable = f.mfa.enableTotp(f.user.id, f.login.session.id, authenticator.generate(f.secret));
    await gate.entered.promise;
    const competing = Promise.allSettled([
      f.mfa.setupTotp(f.user.id, second.session.id),
      f.mfa.enableTotp(f.user.id, second.session.id, authenticator.generate(f.secret)),
    ]);
    gate.release.resolve();
    await firstEnable;
    const results = await competing;
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await database().userMfaTotpRecoveryCode.count({ where: { credential: { userId: f.user.id } } })).toBe(10);
  });

  it('orders both users when concurrently replacing cookies from different owners', async () => {
    const a = await fixture();
    const b = await fixture();
    const replacements = await Promise.all([
      a.sessions.exchange(a.user.id, b.login.token),
      b.sessions.exchange(b.user.id, a.login.token),
    ]);
    expect(replacements.map((login) => login.session.userId)).toEqual([a.user.id, b.user.id]);
    expect(replacements.every((login) => !login.session.mfaVerified)).toBe(true);
    await expect(a.sessions.authenticate(a.login.token)).rejects.toThrow(UnauthorizedException);
    await expect(b.sessions.authenticate(b.login.token)).rejects.toThrow(UnauthorizedException);
    expect(await database().appSession.count({ where: { userId: { in: [a.user.id, b.user.id] }, revokedAt: null } })).toBe(2);
  });

  it('rechecks freeze and pending deadlines inside verification, and live session state during proof validation', async () => {
    const f = await fixture();
    const code = authenticator.generate(f.secret);
    const proof = await f.mfa.verifyTotp(f.user.id, f.login.session.id, code);
    await database().user.update({ where: { id: f.user.id }, data: { frozenAt: new Date() } });
    expect(await f.stepUp.validateProof(proof.proofToken, f.user.id, f.login.session.id)).toBe(false);
    await expect(f.mfa.verifyTotp(f.user.id, f.login.session.id, code)).rejects.toThrow('frozen');
    await database().user.update({ where: { id: f.user.id }, data: { frozenAt: null } });
    const pending = await f.sessions.exchange(f.user.id, undefined);
    await database().appSession.update({ where: { id: pending.session.id }, data: { mfaPendingUntil: new Date(0) } });
    await expect(f.mfa.verifyTotp(f.user.id, pending.session.id, code)).rejects.toThrow(UnauthorizedException);
    await database().appSession.update({ where: { id: f.login.session.id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60_000), mfaPendingUntil: new Date(0), expiresAt: new Date(Date.now() - 1) } });
    expect(await f.stepUp.validateProof(proof.proofToken, f.user.id, f.login.session.id)).toBe(false);
  });
});
