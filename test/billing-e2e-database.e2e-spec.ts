/**
 * No-DB gate tests for billing E2E isolation helpers (Gate 1).
 * Does not require PostgreSQL. Restores process.env after each case.
 */
import {
  BILLING_E2E_APPLICATION_NAME_ENV,
  BILLING_E2E_DATABASE_URL_ENV,
  BILLING_E2E_DISPOSABLE_ENV,
  BILLING_E2E_EXPECTED_DATABASE_ENV,
  BILLING_E2E_EXPECTED_OWNER_ENV,
  BILLING_E2E_EXPECTED_USER_ENV,
  BILLING_E2E_PROVISIONED_ENV,
  BILLING_E2E_PROVISIONED_TOKEN,
  BILLING_E2E_RUN_ID_ENV,
  applyBillingE2eDatabaseUrl,
  assertBillingE2eDatabaseIdentity,
  buildBillingE2eChildEnv,
  normalizeBillingE2eIdentityRow,
  resolveBillingE2eDatabaseTarget,
  type BillingE2eDatabaseTarget,
} from './billing-e2e-database';

const RUN_ID = 'a1b2c3d4e5f67890';
const DB_NAME = `billing_e2e_d_${RUN_ID}`;
const ROLE = `billing_e2e_r_${RUN_ID}`;
const APP = `billing-e2e-${RUN_ID}`;
const TARGET_URL = `postgresql://${ROLE}:secret@127.0.0.1:5432/${DB_NAME}?application_name=${APP}`;

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearBillingE2eEnv(): void {
  delete process.env[BILLING_E2E_DATABASE_URL_ENV];
  delete process.env[BILLING_E2E_DISPOSABLE_ENV];
  delete process.env[BILLING_E2E_PROVISIONED_ENV];
  delete process.env[BILLING_E2E_RUN_ID_ENV];
  delete process.env[BILLING_E2E_EXPECTED_DATABASE_ENV];
  delete process.env[BILLING_E2E_EXPECTED_USER_ENV];
  delete process.env[BILLING_E2E_EXPECTED_OWNER_ENV];
  delete process.env[BILLING_E2E_APPLICATION_NAME_ENV];
  delete process.env.BILLING_E2E_ADMIN_DATABASE_URL;
}

function setValidProvisionedEnv(): void {
  process.env[BILLING_E2E_DATABASE_URL_ENV] = TARGET_URL;
  process.env[BILLING_E2E_DISPOSABLE_ENV] = 'true';
  process.env[BILLING_E2E_PROVISIONED_ENV] = BILLING_E2E_PROVISIONED_TOKEN;
  process.env[BILLING_E2E_RUN_ID_ENV] = RUN_ID;
  process.env[BILLING_E2E_EXPECTED_DATABASE_ENV] = DB_NAME;
  process.env[BILLING_E2E_EXPECTED_USER_ENV] = ROLE;
  process.env[BILLING_E2E_EXPECTED_OWNER_ENV] = ROLE;
  process.env[BILLING_E2E_APPLICATION_NAME_ENV] = APP;
}

function validTarget(): BillingE2eDatabaseTarget {
  return {
    url: TARGET_URL,
    databaseName: DB_NAME,
    runId: RUN_ID,
    expectedUser: ROLE,
    expectedOwner: ROLE,
    applicationName: APP,
  };
}

const TRACKED = [
  BILLING_E2E_DATABASE_URL_ENV,
  BILLING_E2E_DISPOSABLE_ENV,
  BILLING_E2E_PROVISIONED_ENV,
  BILLING_E2E_RUN_ID_ENV,
  BILLING_E2E_EXPECTED_DATABASE_ENV,
  BILLING_E2E_EXPECTED_USER_ENV,
  BILLING_E2E_EXPECTED_OWNER_ENV,
  BILLING_E2E_APPLICATION_NAME_ENV,
  'BILLING_E2E_ADMIN_DATABASE_URL',
  'DATABASE_URL',
];

describe('billing E2E database gate (no Postgres)', () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv(TRACKED);
    clearBillingE2eEnv();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  it('rejects inherited DATABASE_URL alone', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/agent_wallet';
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_DATABASE_URL is required/);
  });

  it('rejects missing explicit target', () => {
    process.env[BILLING_E2E_DISPOSABLE_ENV] = 'true';
    process.env[BILLING_E2E_PROVISIONED_ENV] = BILLING_E2E_PROVISIONED_TOKEN;
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_DATABASE_URL is required/);
  });

  it('rejects missing disposable ack', () => {
    setValidProvisionedEnv();
    delete process.env[BILLING_E2E_DISPOSABLE_ENV];
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_DISPOSABLE_DB/);
  });

  it('rejects missing provisioned runner metadata', () => {
    setValidProvisionedEnv();
    delete process.env[BILLING_E2E_PROVISIONED_ENV];
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_PROVISIONED/);
  });

  it('rejects missing run id / expected owner-user metadata', () => {
    setValidProvisionedEnv();
    delete process.env[BILLING_E2E_RUN_ID_ENV];
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_RUN_ID/);

    setValidProvisionedEnv();
    delete process.env[BILLING_E2E_EXPECTED_OWNER_ENV];
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_EXPECTED_OWNER/);

    setValidProvisionedEnv();
    delete process.env[BILLING_E2E_EXPECTED_USER_ENV];
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_EXPECTED_USER/);

    setValidProvisionedEnv();
    delete process.env[BILLING_E2E_APPLICATION_NAME_ENV];
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/BILLING_E2E_APPLICATION_NAME/);
  });

  it('rejects forbidden and static non-runner targets', () => {
    setValidProvisionedEnv();
    process.env[BILLING_E2E_DATABASE_URL_ENV] = 'postgresql://u:p@localhost:5432/agent_wallet';
    process.env[BILLING_E2E_EXPECTED_DATABASE_ENV] = `billing_e2e_d_${RUN_ID}`;
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(/path name does not match|forbidden/);

    setValidProvisionedEnv();
    process.env[BILLING_E2E_DATABASE_URL_ENV] = 'postgresql://u:p@localhost:5432/sofa_one_e2e';
    process.env[BILLING_E2E_EXPECTED_DATABASE_ENV] = 'sofa_one_e2e';
    // Static shared name without run-id embedding fails metadata rules first.
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(
      /embed the run id|forbidden database name/,
    );
  });

  it('rejects malformed URL without leaking credentials', () => {
    setValidProvisionedEnv();
    process.env[BILLING_E2E_DATABASE_URL_ENV] = 'not-a-url';
    try {
      resolveBillingE2eDatabaseTarget();
      fail('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      expect(msg).toMatch(/not a parseable URL/);
      expect(msg).not.toMatch(/secret/);
      expect(msg).not.toMatch(/postgresql:\/\//);
    }
  });

  it('rejects target URL missing username (dedicated role is required)', () => {
    setValidProvisionedEnv();
    // Host-only authority — no userinfo. Ownership proof requires the runner role.
    process.env[BILLING_E2E_DATABASE_URL_ENV] =
      `postgresql://127.0.0.1:5432/${DB_NAME}?application_name=${APP}`;
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(
      /must include a username \(dedicated test role\)/,
    );

    setValidProvisionedEnv();
    // Empty user with password still counts as missing dedicated role identity.
    process.env[BILLING_E2E_DATABASE_URL_ENV] =
      `postgresql://:secret@127.0.0.1:5432/${DB_NAME}?application_name=${APP}`;
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(
      /must include a username \(dedicated test role\)/,
    );
  });

  it('rejects target URL username that does not match expected test role', () => {
    setValidProvisionedEnv();
    process.env[BILLING_E2E_DATABASE_URL_ENV] =
      `postgresql://wrong_role:secret@127.0.0.1:5432/${DB_NAME}?application_name=${APP}`;
    expect(() => resolveBillingE2eDatabaseTarget()).toThrow(
      /user does not match expected test role/,
    );
  });

  it('accepts valid runner metadata and apply sets DATABASE_URL', () => {
    setValidProvisionedEnv();
    const target = resolveBillingE2eDatabaseTarget();
    expect(target.databaseName).toBe(DB_NAME);
    expect(target.expectedUser).toBe(ROLE);
    expect(target.runId).toBe(RUN_ID);

    const applied = applyBillingE2eDatabaseUrl(target);
    expect(process.env.DATABASE_URL).toBe(TARGET_URL);
    expect(applied.databaseName).toBe(DB_NAME);
  });

  it('buildBillingE2eChildEnv strips admin URL and injects target metadata', () => {
    const child = buildBillingE2eChildEnv(validTarget(), {
      BILLING_E2E_ADMIN_DATABASE_URL: 'postgresql://postgres:admin@localhost:5432/postgres',
      DATABASE_URL: 'postgresql://postgres:admin@localhost:5432/agent_wallet',
      NODE_ENV: 'test',
    });
    expect(child.BILLING_E2E_ADMIN_DATABASE_URL).toBeUndefined();
    expect(child.DATABASE_URL).toBe(TARGET_URL);
    expect(child[BILLING_E2E_DATABASE_URL_ENV]).toBe(TARGET_URL);
    expect(child[BILLING_E2E_PROVISIONED_ENV]).toBe(BILLING_E2E_PROVISIONED_TOKEN);
    expect(child[BILLING_E2E_RUN_ID_ENV]).toBe(RUN_ID);
    expect(child[BILLING_E2E_EXPECTED_DATABASE_ENV]).toBe(DB_NAME);
    expect(child[BILLING_E2E_EXPECTED_USER_ENV]).toBe(ROLE);
    expect(child[BILLING_E2E_EXPECTED_OWNER_ENV]).toBe(ROLE);
    expect(child[BILLING_E2E_APPLICATION_NAME_ENV]).toBe(APP);
    expect(child[BILLING_E2E_DISPOSABLE_ENV]).toBe('true');
  });

  it('assertBillingE2eDatabaseIdentity rejects query failure and mismatches', async () => {
    const target = validTarget();

    await expect(
      assertBillingE2eDatabaseIdentity(target, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/could not read identity/);

    await expect(assertBillingE2eDatabaseIdentity(target, async () => [])).rejects.toThrow(
      /empty or malformed identity/,
    );

    await expect(
      assertBillingE2eDatabaseIdentity(target, async () => [
        {
          database_name: 'other_db',
          current_user: ROLE,
          session_user: ROLE,
          database_owner: ROLE,
          application_name: APP,
        },
      ]),
    ).rejects.toThrow(/current_database/);

    await expect(
      assertBillingE2eDatabaseIdentity(target, async () => [
        {
          database_name: DB_NAME,
          current_user: 'wrong_user',
          session_user: ROLE,
          database_owner: ROLE,
          application_name: APP,
        },
      ]),
    ).rejects.toThrow(/current_user/);

    await expect(
      assertBillingE2eDatabaseIdentity(target, async () => [
        {
          database_name: DB_NAME,
          current_user: ROLE,
          session_user: 'wrong_session',
          database_owner: ROLE,
          application_name: APP,
        },
      ]),
    ).rejects.toThrow(/session_user/);

    await expect(
      assertBillingE2eDatabaseIdentity(target, async () => [
        {
          database_name: DB_NAME,
          current_user: ROLE,
          session_user: ROLE,
          database_owner: 'wrong_owner',
          application_name: APP,
        },
      ]),
    ).rejects.toThrow(/database_owner/);

    await expect(
      assertBillingE2eDatabaseIdentity(target, async () => [
        {
          database_name: DB_NAME,
          current_user: ROLE,
          session_user: ROLE,
          database_owner: ROLE,
          application_name: 'wrong-app',
        },
      ]),
    ).rejects.toThrow(/application_name/);
  });

  it('assertBillingE2eDatabaseIdentity accepts a matching snapshot', async () => {
    const target = validTarget();
    const snap = await assertBillingE2eDatabaseIdentity(target, async () => [
      {
        database_name: DB_NAME,
        current_user: ROLE,
        session_user: ROLE,
        database_owner: ROLE,
        application_name: APP,
      },
    ]);
    expect(snap.databaseName).toBe(DB_NAME);
    expect(snap.applicationName).toBe(APP);
  });

  it('does not invoke seed/cleanup callbacks when identity assertion fails', async () => {
    const target = validTarget();
    const seed = jest.fn();
    const cleanup = jest.fn();

    const runGuarded = async () => {
      await assertBillingE2eDatabaseIdentity(target, async () => {
        throw new Error('identity unavailable');
      });
      seed();
      cleanup();
    };

    await expect(runGuarded()).rejects.toThrow(/could not read identity/);
    expect(seed).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('normalizeBillingE2eIdentityRow accepts snake_case and camelCase keys', () => {
    expect(
      normalizeBillingE2eIdentityRow({
        database_name: 'd',
        current_user: 'u',
        session_user: 'u',
        database_owner: 'o',
        application_name: 'a',
      }),
    ).toEqual({
      databaseName: 'd',
      currentUser: 'u',
      sessionUser: 'u',
      databaseOwner: 'o',
      applicationName: 'a',
    });
  });
});
