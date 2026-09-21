import {
  isPermanentSessionCleanupError,
  isRecurringStripeInvoiceRenewalAttempt,
  RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
  StripeCheckoutSessionCleanupService,
} from './stripe-checkout-session-cleanup.service';
import {
  SESSION_CLEANUP_STATUS_COMPLETED,
  SESSION_CLEANUP_STATUS_IN_FLIGHT,
  SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
  SESSION_CLEANUP_STATUS_PENDING,
} from './stripe.constants';

describe('StripeCheckoutSessionCleanupService (BILL-014 Gate 1)', () => {
  const attemptFindMany = jest.fn();
  const attemptFindUnique = jest.fn();
  const attemptUpdateMany = jest.fn();
  const sessionsRetrieve = jest.fn();
  const sessionsExpire = jest.fn();
  const sessionsList = jest.fn();

  const prisma = {
    billingPaymentAttempt: {
      findMany: attemptFindMany,
      findUnique: attemptFindUnique,
      updateMany: attemptUpdateMany,
    },
  };

  const stripe = {
    checkout: {
      sessions: {
        retrieve: sessionsRetrieve,
        expire: sessionsExpire,
        list: sessionsList,
      },
    },
  };

  let service: StripeCheckoutSessionCleanupService;
  let capturedLeaseToken: string | null;

  const paidInvoice = {
    id: 'inv-1',
    paidAt: new Date('2026-09-18T05:19:45Z'),
    settlementAttemptId: 'att-winner',
    totalMicros: 21_030_000n,
    allocatedMicros: 21_030_000n,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    planVersionId: 'plan-1',
    currency: 'USD',
    billingAccount: { id: 'acc-1', stripeCustomerId: 'cus_123' },
  };

  const siblingRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'att-sibling',
    invoiceId: 'inv-1',
    amountMicros: 21_030_000n,
    currency: 'USD',
    stripeChargeKind: 'full',
    stripeCheckoutSessionId: 'cs_old',
    stripePaymentIntentId: null,
    stripeInvoiceId: null,
    stripeSubscriptionId: null,
    sessionCleanupRetryCount: 0,
    sessionCleanupOwnerId: null,
    sessionCleanupLeaseExpiresAt: null,
    sessionCleanupCompletedAt: null,
    sessionCleanupStatus: null,
    invoice: { ...paidInvoice },
    ...overrides,
  });

  /** Identity-valid open Checkout Session fixture. */
  const validSession = (overrides: Record<string, unknown> = {}) => ({
    id: 'cs_old',
    status: 'open',
    mode: 'payment',
    currency: 'usd',
    amount_total: 2103,
    customer: 'cus_123',
    client_reference_id: 'inv-1',
    metadata: {
      invoiceId: 'inv-1',
      attemptId: 'att-sibling',
      period: '2026-09',
    },
    ...overrides,
  });

  function wireLease(seed: ReturnType<typeof siblingRow>) {
    capturedLeaseToken = null;
    attemptUpdateMany.mockImplementation(async (args: { data?: any; where?: any }) => {
      if (typeof args.data?.sessionCleanupOwnerId === 'string') {
        capturedLeaseToken = args.data.sessionCleanupOwnerId;
      }
      // Stale lease fencing: completion requires the captured token.
      if (
        args.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_COMPLETED ||
        args.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_NEEDS_REVIEW ||
        args.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_PENDING
      ) {
        if (
          args.where?.sessionCleanupOwnerId &&
          args.where.sessionCleanupOwnerId !== capturedLeaseToken
        ) {
          return { count: 0 };
        }
      }
      return { count: 1 };
    });
    attemptFindUnique.mockImplementation(async () => ({
      ...seed,
      sessionCleanupOwnerId: capturedLeaseToken,
      sessionCleanupRetryCount: (seed.sessionCleanupRetryCount ?? 0) + 1,
      sessionCleanupStatus: SESSION_CLEANUP_STATUS_IN_FLIGHT,
      sessionCleanupLeaseExpiresAt: new Date(Date.now() + 120_000),
    }));
  }

  beforeEach(() => {
    jest.resetAllMocks();
    capturedLeaseToken = null;
    service = new StripeCheckoutSessionCleanupService(prisma as any, stripe as any);
    // Default: with-id batch returns seed via first call; without-id empty.
    attemptFindMany.mockImplementation(async (args: { where?: any }) => {
      if (args?.where?.stripeCheckoutSessionId?.not === null) {
        return [];
      }
      if (args?.where?.stripeCheckoutSessionId === null) {
        return [];
      }
      return [];
    });
    attemptUpdateMany.mockResolvedValue({ count: 1 });
  });

  /** Path C backlog probe: renewal-shaped rows with cleanup status in backlog. */
  function isRenewalBacklogProbe(args: { where?: any }): boolean {
    return (
      args?.where?.stripeCheckoutSessionId === null &&
      Array.isArray(args?.where?.sessionCleanupStatus?.in) &&
      args.where.sessionCleanupStatus.in.includes(SESSION_CLEANUP_STATUS_NEEDS_REVIEW)
    );
  }

  function seedWithId(seed: ReturnType<typeof siblingRow>) {
    attemptFindMany.mockImplementation(async (args: { where?: any }) => {
      if (isRenewalBacklogProbe(args)) return [];
      if (args?.where?.stripeCheckoutSessionId?.not === null) return [seed];
      if (args?.where?.stripeCheckoutSessionId === null) return [];
      return [];
    });
  }

  function seedWithoutId(seed: ReturnType<typeof siblingRow>) {
    attemptFindMany.mockImplementation(async (args: { where?: any }) => {
      if (isRenewalBacklogProbe(args)) return [];
      if (args?.where?.stripeCheckoutSessionId?.not === null) return [];
      if (args?.where?.stripeCheckoutSessionId === null) return [seed];
      return [];
    });
  }

  describe('isInvoiceFullyPaid', () => {
    it('requires paidAt, settlementAttemptId, and full coverage', () => {
      expect(service.isInvoiceFullyPaid(paidInvoice)).toBe(true);
      expect(service.isInvoiceFullyPaid({ ...paidInvoice, paidAt: null })).toBe(false);
      expect(service.isInvoiceFullyPaid({ ...paidInvoice, settlementAttemptId: null })).toBe(false);
      expect(
        service.isInvoiceFullyPaid({
          ...paidInvoice,
          allocatedMicros: 10_000_000n,
        }),
      ).toBe(false);
    });
  });

  describe('proveSessionIdentity', () => {
    const attempt = siblingRow() as any;

    it('accepts a fully matching open session', () => {
      expect(service.proveSessionIdentity(attempt, validSession() as any, 'cs_old')).toEqual({
        ok: true,
        sessionId: 'cs_old',
        status: 'open',
      });
    });

    it('rejects empty/unknown session payloads', () => {
      expect(service.proveSessionIdentity(attempt, null, 'cs_old').ok).toBe(false);
      expect(service.proveSessionIdentity(attempt, undefined, 'cs_old').ok).toBe(false);
      expect(service.proveSessionIdentity(attempt, {} as any, 'cs_old').ok).toBe(false);
    });

    it('rejects identity mismatches (id, customer, metadata, amount)', () => {
      const idMismatch = service.proveSessionIdentity(
        attempt,
        validSession({ id: 'cs_OTHER' }) as any,
        'cs_old',
      );
      expect(idMismatch.ok).toBe(false);
      if (!idMismatch.ok) expect(idMismatch.code).toBe('checkout_session_id_mismatch');

      const customerMismatch = service.proveSessionIdentity(
        attempt,
        validSession({ customer: 'cus_OTHER' }) as any,
        'cs_old',
      );
      expect(customerMismatch.ok).toBe(false);
      if (!customerMismatch.ok) expect(customerMismatch.code).toBe('checkout_customer_mismatch');

      const metaMismatch = service.proveSessionIdentity(
        attempt,
        validSession({
          metadata: { invoiceId: 'inv-1', attemptId: 'other', period: '2026-09' },
        }) as any,
        'cs_old',
      );
      expect(metaMismatch.ok).toBe(false);
      if (!metaMismatch.ok) expect(metaMismatch.code).toBe('checkout_metadata_binding_mismatch');

      const amountMismatch = service.proveSessionIdentity(
        attempt,
        validSession({ amount_total: 9999 }) as any,
        'cs_old',
      );
      expect(amountMismatch.ok).toBe(false);
      if (!amountMismatch.ok) expect(amountMismatch.code).toBe('checkout_amount_mismatch');

      const statusUnknown = service.proveSessionIdentity(
        attempt,
        validSession({ status: 'weird' }) as any,
        'cs_old',
      );
      expect(statusUnknown.ok).toBe(false);
      if (!statusUnknown.ok) expect(statusUnknown.code).toBe('checkout_session_status_unknown');
    });
  });

  describe('processDue', () => {
    it('returns empty when Stripe is not configured (still clears renewal cleanup backlog)', async () => {
      const bare = new StripeCheckoutSessionCleanupService(prisma as any, null);
      // Path C still runs without Stripe (local backlog only).
      attemptFindMany.mockResolvedValue([]);
      await expect(bare.processDue('worker-1')).resolves.toEqual({
        attempted: 0,
        expired: 0,
        alreadyClosed: 0,
        needsReview: 0,
        retryable: 0,
      });
      // Only the renewal-backlog probe — no Path A/B provider work.
      expect(attemptFindMany).toHaveBeenCalledTimes(1);
      expect(attemptFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            stripeCheckoutSessionId: null,
            ...RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
            sessionCleanupStatus: {
              in: [
                SESSION_CLEANUP_STATUS_PENDING,
                SESSION_CLEANUP_STATUS_IN_FLIGHT,
                SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
              ],
            },
          }),
        }),
      );
      expect(sessionsList).not.toHaveBeenCalled();
      expect(sessionsRetrieve).not.toHaveBeenCalled();
      expect(sessionsExpire).not.toHaveBeenCalled();
    });

    it('expires an identity-matched open sibling after fully-paid lease/CAS with fencing token', async () => {
      const seed = siblingRow();
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockResolvedValue(validSession());
      sessionsExpire.mockResolvedValue(validSession({ status: 'expired' }));

      const result = await service.processDue('worker-1');

      expect(result).toEqual({
        attempted: 1,
        expired: 1,
        alreadyClosed: 0,
        needsReview: 0,
        retryable: 0,
      });
      expect(sessionsExpire).toHaveBeenCalledWith('cs_old');
      expect(capturedLeaseToken).toMatch(/^worker-1:/);
      const completedWrite = attemptUpdateMany.mock.calls.find(
        (c) => c[0]?.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_COMPLETED,
      );
      expect(completedWrite?.[0]?.where?.sessionCleanupOwnerId).toBe(capturedLeaseToken);
      expect(completedWrite?.[0]?.where?.sessionCleanupLeaseExpiresAt).toEqual({
        gt: expect.any(Date),
      });
      expect(completedWrite?.[0]?.data?.status).toBeUndefined();
    });

    it('treats identity-matched complete/expired as alreadyClosed without expire', async () => {
      const seed = siblingRow();
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockResolvedValue(validSession({ status: 'complete' }));

      const result = await service.processDue('worker-1');

      expect(result.alreadyClosed).toBe(1);
      expect(result.expired).toBe(0);
      expect(sessionsExpire).not.toHaveBeenCalled();
    });

    it('does not complete on bare resource_missing expire without re-proven closed status', async () => {
      const seed = siblingRow();
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve
        .mockResolvedValueOnce(validSession())
        // recheck after expire error still open / missing
        .mockRejectedValueOnce(
          Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' }),
        );
      sessionsExpire.mockRejectedValue(
        Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' }),
      );

      const result = await service.processDue('worker-1');

      expect(result.alreadyClosed).toBe(0);
      expect(result.retryable).toBe(1);
      expect(
        attemptUpdateMany.mock.calls.some(
          (c) => c[0]?.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_COMPLETED,
        ),
      ).toBe(false);
    });

    it('completes alreadyClosed only when expire fails but re-retrieve proves identity-matched expired', async () => {
      const seed = siblingRow();
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve
        .mockResolvedValueOnce(validSession())
        .mockResolvedValueOnce(validSession({ status: 'expired' }));
      sessionsExpire.mockRejectedValue(
        Object.assign(new Error('Session is not open'), { code: 'invalid_request_error' }),
      );

      const result = await service.processDue('worker-1');

      expect(result.alreadyClosed).toBe(1);
      expect(result.retryable).toBe(0);
    });

    it('rejects invalid identity before expire and marks needs_review without paid-fact mutation', async () => {
      const seed = siblingRow({ sessionCleanupRetryCount: 0 });
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockResolvedValue(validSession({ id: 'cs_OTHER' }));

      const result = await service.processDue('worker-1');

      expect(result.needsReview).toBe(1);
      expect(sessionsExpire).not.toHaveBeenCalled();
      const reviewWrite = attemptUpdateMany.mock.calls.find(
        (c) => c[0]?.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
      );
      expect(reviewWrite?.[0]?.data?.status).toBeUndefined();
    });

    it('treats empty retrieve and unknown status as retryable (not done)', async () => {
      const seed = siblingRow();
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockResolvedValue(null);

      const emptyResult = await service.processDue('worker-1');
      expect(emptyResult.retryable).toBe(1);
      expect(emptyResult.alreadyClosed).toBe(0);

      jest.clearAllMocks();
      capturedLeaseToken = null;
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockResolvedValue(validSession({ status: 'something_else' }));

      const unknownResult = await service.processDue('worker-1');
      expect(unknownResult.retryable).toBe(1);
      expect(sessionsExpire).not.toHaveBeenCalled();
    });

    it('skips work when invoice is not fully paid (never expires)', async () => {
      const seed = siblingRow({
        invoice: { ...paidInvoice, allocatedMicros: 1_000_000n },
      });
      seedWithId(seed);
      wireLease(seed);

      const result = await service.processDue('worker-1');

      expect(result).toEqual({
        attempted: 1,
        expired: 0,
        alreadyClosed: 0,
        needsReview: 0,
        retryable: 0,
      });
      expect(sessionsRetrieve).not.toHaveBeenCalled();
      expect(sessionsExpire).not.toHaveBeenCalled();
    });

    it('skips lease/CAS miss without counting failure', async () => {
      seedWithId(siblingRow());
      attemptUpdateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.processDue('worker-1');

      expect(result).toEqual({
        attempted: 1,
        expired: 0,
        alreadyClosed: 0,
        needsReview: 0,
        retryable: 0,
      });
      expect(sessionsRetrieve).not.toHaveBeenCalled();
    });

    it('stale lease fencing: completion CAS misses when owner token does not match', async () => {
      const seed = siblingRow();
      seedWithId(seed);
      // Lease acquires with token A, but completion is forced to use wrong fence.
      let leaseCalls = 0;
      attemptUpdateMany.mockImplementation(async (args: { data?: any }) => {
        leaseCalls += 1;
        if (args.data?.sessionCleanupOwnerId) {
          capturedLeaseToken = args.data.sessionCleanupOwnerId;
          return { count: 1 };
        }
        // Simulate concurrent takeover: completion fence no longer owns the row.
        if (args.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_COMPLETED) {
          return { count: 0 };
        }
        return { count: 1 };
      });
      attemptFindUnique.mockImplementation(async () => ({
        ...seed,
        sessionCleanupOwnerId: capturedLeaseToken,
        sessionCleanupRetryCount: 1,
        sessionCleanupStatus: SESSION_CLEANUP_STATUS_IN_FLIGHT,
        sessionCleanupLeaseExpiresAt: new Date(Date.now() + 120_000),
      }));
      sessionsRetrieve.mockResolvedValue(validSession({ status: 'expired' }));

      const result = await service.processDue('worker-1');

      // CAS miss on complete → skipped (benign), not counted as success.
      expect(result.alreadyClosed).toBe(0);
      expect(result.expired).toBe(0);
      expect(leaseCalls).toBeGreaterThan(0);
    });

    it('reschedules retryable 429/5xx', async () => {
      const seed = siblingRow({ sessionCleanupRetryCount: 0 });
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockRejectedValue(
        Object.assign(new Error('rate limited'), { statusCode: 429, code: 'rate_limit' }),
      );

      const result = await service.processDue('worker-1');

      expect(result.retryable).toBe(1);
      expect(result.needsReview).toBe(0);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionCleanupStatus: SESSION_CLEANUP_STATUS_PENDING,
            sessionCleanupNextRetryAt: expect.any(Date),
          }),
        }),
      );
    });

    it('exhausts retry budget into needs_review after repeated 5xx', async () => {
      const seed = siblingRow({ sessionCleanupRetryCount: 4 });
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockRejectedValue(
        Object.assign(new Error('stripe down'), { statusCode: 503 }),
      );

      const result = await service.processDue('worker-1');

      expect(result.needsReview).toBe(1);
      expect(result.retryable).toBe(0);
    });

    it('late ID discovery: binds unique metadata-matched Session then expires open sibling', async () => {
      const seed = siblingRow({ stripeCheckoutSessionId: null });
      seedWithoutId(seed);
      wireLease(seed);
      sessionsList.mockResolvedValue({
        data: [
          validSession({ id: 'cs_discovered', status: 'open' }),
          // Unrelated session for another attempt — ignored.
          validSession({
            id: 'cs_other',
            metadata: {
              invoiceId: 'inv-1',
              attemptId: 'att-other',
              period: '2026-09',
            },
          }),
        ],
      });
      sessionsRetrieve.mockResolvedValue(validSession({ id: 'cs_discovered', status: 'open' }));
      sessionsExpire.mockResolvedValue(validSession({ id: 'cs_discovered', status: 'expired' }));

      const result = await service.processDue('worker-1');

      expect(result.expired).toBe(1);
      expect(sessionsList).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_123', limit: 100 }),
      );
      // First-writer CAS bind of discovered id (null → cs_discovered).
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ stripeCheckoutSessionId: null }),
          data: expect.objectContaining({ stripeCheckoutSessionId: 'cs_discovered' }),
        }),
      );
      expect(sessionsExpire).toHaveBeenCalledWith('cs_discovered');
    });

    it('late ID discovery: unrecoverable identity retains needs_review (never recreates)', async () => {
      const seed = siblingRow({ stripeCheckoutSessionId: null });
      seedWithoutId(seed);
      wireLease(seed);
      sessionsList.mockResolvedValue({ data: [] });

      const result = await service.processDue('worker-1');

      expect(result.needsReview).toBe(1);
      expect(sessionsExpire).not.toHaveBeenCalled();
      // Never creates a Checkout Session.
      expect((stripe.checkout.sessions as any).create).toBeUndefined();
    });

    it('late ID discovery: ambiguous multi-match retains needs_review', async () => {
      const seed = siblingRow({ stripeCheckoutSessionId: null });
      seedWithoutId(seed);
      wireLease(seed);
      sessionsList.mockResolvedValue({
        data: [
          validSession({ id: 'cs_a', status: 'open' }),
          validSession({ id: 'cs_b', status: 'open' }),
        ],
      });

      const result = await service.processDue('worker-1');

      expect(result.needsReview).toBe(1);
      expect(sessionsExpire).not.toHaveBeenCalled();
    });

    it('discovers both known-id and missing-id candidates on paid invoices', async () => {
      attemptFindMany.mockResolvedValue([]);
      await service.processDue('worker-1', 25);
      // Path C: renewal backlog clear probe
      expect(attemptFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            method: 'stripe',
            stripeCheckoutSessionId: null,
            ...RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
            sessionCleanupStatus: {
              in: [
                SESSION_CLEANUP_STATUS_PENDING,
                SESSION_CLEANUP_STATUS_IN_FLIGHT,
                SESSION_CLEANUP_STATUS_NEEDS_REVIEW,
              ],
            },
          }),
          take: 25,
        }),
      );
      // Path A: known session id
      expect(attemptFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            method: 'stripe',
            stripeCheckoutSessionId: { not: null },
            sessionCleanupCompletedAt: null,
            invoice: expect.objectContaining({
              paidAt: { not: null },
              settlementAttemptId: { not: null },
            }),
          }),
          take: 25,
        }),
      );
      // Path B: missing session id, excluding recurring renewals
      expect(attemptFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            stripeCheckoutSessionId: null,
            NOT: RECURRING_STRIPE_INVOICE_RENEWAL_WHERE,
          }),
        }),
      );
    });

    it('BILL-014: paid recurring renewal (invoice+sub, no session) skips cleanup provider calls and backlog', async () => {
      // Path C: stuck renewal backlog is cleared with no provider calls.
      // Path B: dueFilter excludes renewals so they are never leased for discovery.
      const stuckRenewal = {
        id: 'att-renewal-stuck',
      };
      attemptFindMany.mockImplementation(async (args: { where?: any }) => {
        // Path C backlog probe
        if (
          args?.where?.sessionCleanupStatus?.in?.includes(SESSION_CLEANUP_STATUS_NEEDS_REVIEW) &&
          args?.where?.stripeCheckoutSessionId === null &&
          args?.where?.AND
        ) {
          return [stuckRenewal];
        }
        // Path A / Path B: renewals must not appear (filter excludes them).
        return [];
      });
      attemptUpdateMany.mockResolvedValue({ count: 1 });

      const result = await service.processDue('worker-1');

      expect(result).toEqual({
        attempted: 0,
        expired: 0,
        alreadyClosed: 0,
        needsReview: 0,
        retryable: 0,
      });
      expect(sessionsList).not.toHaveBeenCalled();
      expect(sessionsRetrieve).not.toHaveBeenCalled();
      expect(sessionsExpire).not.toHaveBeenCalled();
      // Backlog cleared to null — not left pending/needs_review.
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-renewal-stuck',
            stripeCheckoutSessionId: null,
            stripeInvoiceId: { not: null },
            stripeSubscriptionId: { not: null },
          }),
          data: expect.objectContaining({
            sessionCleanupStatus: null,
            sessionCleanupOwnerId: null,
            sessionCleanupLeaseExpiresAt: null,
            sessionCleanupNextRetryAt: null,
          }),
        }),
      );
    });

    it('BILL-014: defense-in-depth skips renewal if late-discovery path still receives one', async () => {
      // Even if a buggy query returned a renewal row, processOne must release
      // without list/retrieve/expire and without writing cleanup needs_review.
      const renewal = siblingRow({
        id: 'att-renewal',
        stripeCheckoutSessionId: null,
        stripeInvoiceId: 'in_renewal_paid',
        stripeSubscriptionId: 'sub_renewal',
        stripeChargeKind: 'fixed_fee',
      });
      // Path C finds nothing; Path B is forced to return the renewal (buggy query).
      attemptFindMany.mockImplementation(async (args: { where?: any }) => {
        if (args?.where?.sessionCleanupStatus?.in?.includes(SESSION_CLEANUP_STATUS_NEEDS_REVIEW)) {
          return [];
        }
        if (args?.where?.stripeCheckoutSessionId?.not === null) return [];
        if (args?.where?.stripeCheckoutSessionId === null) return [renewal];
        return [];
      });
      wireLease(renewal);

      const result = await service.processDue('worker-1');

      expect(result).toEqual({
        attempted: 1,
        expired: 0,
        alreadyClosed: 0,
        needsReview: 0,
        retryable: 0,
      });
      expect(sessionsList).not.toHaveBeenCalled();
      expect(sessionsRetrieve).not.toHaveBeenCalled();
      expect(sessionsExpire).not.toHaveBeenCalled();
      expect(
        attemptUpdateMany.mock.calls.some(
          (c) =>
            c[0]?.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_NEEDS_REVIEW ||
            c[0]?.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_COMPLETED ||
            c[0]?.data?.sessionCleanupStatus === SESSION_CLEANUP_STATUS_PENDING,
        ),
      ).toBe(false);
      expect(attemptUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'att-renewal',
            sessionCleanupOwnerId: capturedLeaseToken,
          }),
          data: expect.objectContaining({
            sessionCleanupStatus: null,
            sessionCleanupOwnerId: null,
            sessionCleanupLeaseExpiresAt: null,
            sessionCleanupNextRetryAt: null,
          }),
        }),
      );
    });

    it('BILL-014: late-ID recovery still runs for checkout attempts without invoice+subscription pair', async () => {
      // Legitimate checkout crash before session id persist: no stripeInvoiceId.
      const seed = siblingRow({
        stripeCheckoutSessionId: null,
        stripeInvoiceId: null,
        stripeSubscriptionId: null,
      });
      seedWithoutId(seed);
      wireLease(seed);
      sessionsList.mockResolvedValue({
        data: [validSession({ id: 'cs_late', status: 'open' })],
      });
      sessionsRetrieve.mockResolvedValue(validSession({ id: 'cs_late', status: 'open' }));
      sessionsExpire.mockResolvedValue(validSession({ id: 'cs_late', status: 'expired' }));

      const result = await service.processDue('worker-1');

      expect(result.expired).toBe(1);
      expect(sessionsList).toHaveBeenCalled();
      expect(sessionsExpire).toHaveBeenCalledWith('cs_late');
    });

    it('BILL-014: known checkout session id still cleans up even when invoice+subscription are bound', async () => {
      // Path A retains known session ids regardless of renewal-shaped provider ids.
      const seed = siblingRow({
        stripeCheckoutSessionId: 'cs_old',
        stripeInvoiceId: 'in_also_bound',
        stripeSubscriptionId: 'sub_also_bound',
      });
      seedWithId(seed);
      wireLease(seed);
      sessionsRetrieve.mockResolvedValue(validSession({ status: 'complete' }));

      const result = await service.processDue('worker-1');

      expect(result.alreadyClosed).toBe(1);
      expect(sessionsRetrieve).toHaveBeenCalledWith('cs_old');
      expect(sessionsList).not.toHaveBeenCalled();
    });
  });

  describe('isRecurringStripeInvoiceRenewalAttempt', () => {
    it('matches only invoice+subscription with null checkout session', () => {
      expect(
        isRecurringStripeInvoiceRenewalAttempt({
          stripeCheckoutSessionId: null,
          stripeInvoiceId: 'in_1',
          stripeSubscriptionId: 'sub_1',
        }),
      ).toBe(true);
      expect(
        isRecurringStripeInvoiceRenewalAttempt({
          stripeCheckoutSessionId: 'cs_1',
          stripeInvoiceId: 'in_1',
          stripeSubscriptionId: 'sub_1',
        }),
      ).toBe(false);
      expect(
        isRecurringStripeInvoiceRenewalAttempt({
          stripeCheckoutSessionId: null,
          stripeInvoiceId: null,
          stripeSubscriptionId: 'sub_1',
        }),
      ).toBe(false);
      expect(
        isRecurringStripeInvoiceRenewalAttempt({
          stripeCheckoutSessionId: null,
          stripeInvoiceId: 'in_1',
          stripeSubscriptionId: null,
        }),
      ).toBe(false);
    });
  });

  describe('isPermanentSessionCleanupError', () => {
    it('does not treat bare resource_missing as permanent completion-worthy', () => {
      expect(
        isPermanentSessionCleanupError(
          Object.assign(new Error('missing'), { code: 'resource_missing' }),
        ),
      ).toBe(false);
    });

    it('treats identity mismatches as permanent', () => {
      expect(
        isPermanentSessionCleanupError(
          Object.assign(new Error('mismatch'), {
            code: 'checkout_session_id_mismatch',
            permanent: true,
          }),
        ),
      ).toBe(true);
    });

    it('treats 429/5xx as non-permanent', () => {
      expect(
        isPermanentSessionCleanupError(
          Object.assign(new Error('rl'), { statusCode: 429, code: 'rate_limit' }),
        ),
      ).toBe(false);
    });
  });
});
