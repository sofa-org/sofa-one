import { ForbiddenException } from '@nestjs/common';
import { RiskEvaluationService, type RiskEvaluationContext } from './risk-evaluation.service';

/**
 * Helper to create a mock PrismaService with `mockImplementation`-based
 * count mocking that matches on eventType, making tests order-independent.
 */
function createMockPrisma() {
  const countMock = jest.fn();
  const findUniqueMock = jest.fn().mockResolvedValue(null);
  const updateMock = jest.fn().mockResolvedValue({});

  // Default: all count queries return 0
  countMock.mockResolvedValue(0);

  return {
    securityEvent: { count: countMock },
    apiKey: { findUnique: findUniqueMock, update: updateMock },
  };
}

/**
 * Configure mock return values for specific event-type queries.
 * This is order-independent since it matches on the query's eventType filter.
 */
function configureCountMocks(
  prisma: ReturnType<typeof createMockPrisma>,
  config: Record<string, number>,
) {
  prisma.securityEvent.count.mockImplementation((args: { where: Record<string, unknown> }) => {
    const eventType = args.where?.eventType;
    // Handle { in: [...] } patterns
    if (eventType && typeof eventType === 'object' && 'in' in eventType) {
      const types = eventType.in as string[];
      // Sum all matching config values
      for (const [key, val] of Object.entries(config)) {
        if (types.includes(key)) return Promise.resolve(val);
      }
      // Check for aggregate keys like 'policy_denied' or 'freeze'
      if (types.some((t) => t.endsWith('.policy_denied') || t === 'eoa_execution_denied')) {
        return Promise.resolve(config['policy_denied'] ?? 0);
      }
      if (types.some((t) => t.includes('frozen'))) {
        return Promise.resolve(config['freeze'] ?? 0);
      }
      return Promise.resolve(0);
    }
    // Handle simple string eventType
    if (typeof eventType === 'string' && eventType in config) {
      return Promise.resolve(config[eventType]);
    }
    // No eventType filter — high velocity check (counts all events for apiKeyId)
    if (!eventType && args.where?.apiKeyId) {
      return Promise.resolve(config['velocity'] ?? 0);
    }
    return Promise.resolve(0);
  });
}

describe('RiskEvaluationService', () => {
  let service: RiskEvaluationService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let securityEvents: { record: jest.Mock };

  const baseContext: RiskEvaluationContext = {
    userId: 'user-1',
    apiKeyId: 'key-1',
    walletId: 'wallet-1',
    operationType: 'transaction_send',
    ip: '203.0.113.10',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    prisma = createMockPrisma();
    securityEvents = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
    service = new RiskEvaluationService(prisma as never, securityEvents as never);
  });

  // ─── evaluateRisk ────────────────────────────────────────────────────

  describe('evaluateRisk', () => {
    it('returns low risk with no factors when no risk conditions are met', async () => {
      // All defaults: count returns 0, findUnique returns null
      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.riskLevel).toBe('low');
      expect(assessment.score).toBe(0);
      expect(assessment.action).toBe('allow');
      expect(assessment.factors).toEqual([]);
      expect(assessment.reason).toBe('No risk factors detected');
    });

    it('maps require_step_up to block for API-key operations', async () => {
      // recently_created_key (15) + suspicious_key_use (25) = 40 → medium → block for API-key
      configureCountMocks(prisma, { api_key_suspicious_use: 1 });
      prisma.apiKey.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      });

      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.action).toBe('block');
      expect(assessment.riskLevel).toBe('medium');
      expect(assessment.score).toBe(40); // 15 + 25
    });

    it('keeps require_step_up for dashboard operations', async () => {
      const dashboardContext: RiskEvaluationContext = {
        ...baseContext,
        operationType: 'withdrawal',
      };

      // consecutive_auth_failures (30) → medium → require_step_up for dashboard
      configureCountMocks(prisma, { 'login.failed': 5 });

      const assessment = await service.evaluateRisk(dashboardContext);

      expect(assessment.action).toBe('require_step_up');
      expect(assessment.riskLevel).toBe('medium');
    });

    // ─── Individual Risk Factors ──────────────────────────────────────

    describe('consecutive_policy_denials', () => {
      it('triggers when 2+ policy denials in the last hour', async () => {
        configureCountMocks(prisma, { policy_denied: 3 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'consecutive_policy_denials',
            weight: 35,
          }),
        );
        expect(assessment.score).toBe(35);
        expect(assessment.riskLevel).toBe('medium');
        expect(assessment.action).toBe('block'); // require_step_up maps to block for API-key ops
      });

      it('does not trigger when fewer than 2 policy denials', async () => {
        configureCountMocks(prisma, { policy_denied: 1 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).not.toContainEqual(
          expect.objectContaining({ name: 'consecutive_policy_denials' }),
        );
      });

      it('counts two DeFi denials and blocks the next API-key operation', async () => {
        configureCountMocks(prisma, { 'defi.policy_denied': 2 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(expect.objectContaining({ name: 'consecutive_policy_denials', weight: 35 }));
        expect(assessment.riskLevel).toBe('medium');
        expect(assessment.action).toBe('block');
        const denialQuery = prisma.securityEvent.count.mock.calls.find((call: [{ where: Record<string, unknown> }]) => {
          const eventType = call[0]?.where?.eventType;
          return Boolean(eventType && typeof eventType === 'object' && 'in' in eventType && (eventType.in as string[]).includes('defi.policy_denied'));
        });
        expect(denialQuery).toBeDefined();
      });
    });

    describe('consecutive_auth_failures', () => {
      it('triggers when 3+ auth failures in the last hour', async () => {
        configureCountMocks(prisma, { 'login.failed': 4 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'consecutive_auth_failures',
            weight: 30,
          }),
        );
        expect(assessment.score).toBe(30);
        expect(assessment.riskLevel).toBe('medium');
      });

      it('does not trigger when fewer than 3 auth failures', async () => {
        configureCountMocks(prisma, { 'login.failed': 2 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).not.toContainEqual(
          expect.objectContaining({ name: 'consecutive_auth_failures' }),
        );
      });
    });

    describe('suspicious_key_use', () => {
      it('triggers when suspicious use events exist in the last 24 hours', async () => {
        configureCountMocks(prisma, { api_key_suspicious_use: 1 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'suspicious_key_use',
            weight: 25,
          }),
        );
      });

      it('skips when no apiKeyId in context', async () => {
        const noKeyContext = { ...baseContext, apiKeyId: undefined };
        configureCountMocks(prisma, { api_key_suspicious_use: 5 });

        const assessment = await service.evaluateRisk(noKeyContext);

        expect(assessment.factors).not.toContainEqual(
          expect.objectContaining({ name: 'suspicious_key_use' }),
        );
      });
    });

    describe('ip_rejected', () => {
      it('triggers when IP rejection events exist in the last 24 hours', async () => {
        configureCountMocks(prisma, { 'api_key.ip_rejected': 2 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'ip_rejected',
            weight: 20,
          }),
        );
      });
    });

    describe('recently_created_key', () => {
      it('triggers when API key was created less than 1 hour ago', async () => {
        prisma.apiKey.findUnique.mockResolvedValue({
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
        });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'recently_created_key',
            weight: 15,
          }),
        );
      });

      it('does not trigger when API key was created more than 1 hour ago', async () => {
        prisma.apiKey.findUnique.mockResolvedValue({
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).not.toContainEqual(
          expect.objectContaining({ name: 'recently_created_key' }),
        );
      });

      it('does not trigger when API key is not found', async () => {
        prisma.apiKey.findUnique.mockResolvedValue(null);

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).not.toContainEqual(
          expect.objectContaining({ name: 'recently_created_key' }),
        );
      });
    });

    describe('high_velocity', () => {
      it('triggers when 50+ events for API key in the last hour', async () => {
        configureCountMocks(prisma, { velocity: 75 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'high_velocity',
            weight: 20,
          }),
        );
      });

      it('does not trigger when fewer than 51 events', async () => {
        configureCountMocks(prisma, { velocity: 50 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).not.toContainEqual(
          expect.objectContaining({ name: 'high_velocity' }),
        );
      });
    });

    describe('recent_freeze_event', () => {
      it('triggers when freeze events exist in the last 24 hours', async () => {
        configureCountMocks(prisma, { freeze: 1 });

        const assessment = await service.evaluateRisk(baseContext);

        expect(assessment.factors).toContainEqual(
          expect.objectContaining({
            name: 'recent_freeze_event',
            weight: 50,
          }),
        );
        expect(assessment.score).toBe(50);
        expect(assessment.riskLevel).toBe('medium');
      });
    });

    // ─── Score Combinations ───────────────────────────────────────────

    it('accumulates scores from multiple factors', async () => {
      // recently_created_key (15) + suspicious_key_use (25) + ip_rejected (20) = 60
      configureCountMocks(prisma, {
        api_key_suspicious_use: 1,
        'api_key.ip_rejected': 1,
      });
      prisma.apiKey.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });

      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.score).toBe(60); // 15 + 25 + 20
      expect(assessment.riskLevel).toBe('high');
      expect(assessment.action).toBe('block');
      expect(assessment.factors).toHaveLength(3);
    });

    it('caps score at 100 even with many factors', async () => {
      // All factors triggered: 35 + 30 + 25 + 20 + 15 + 20 + 50 = 195 → capped at 100
      configureCountMocks(prisma, {
        policy_denied: 5,
        'login.failed': 5,
        api_key_suspicious_use: 2,
        'api_key.ip_rejected': 3,
        velocity: 60,
        freeze: 2,
      });
      prisma.apiKey.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });

      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.score).toBe(100);
      expect(assessment.riskLevel).toBe('critical');
      expect(assessment.action).toBe('freeze');
    });

    it('returns low risk when score is 0-25', async () => {
      // Only recently_created_key (15) → score 15
      prisma.apiKey.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });

      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.score).toBe(15);
      expect(assessment.riskLevel).toBe('low');
      expect(assessment.action).toBe('allow');
    });

    it('returns medium risk when score is 26-50', async () => {
      // suspicious_key_use (25) + recently_created_key (15) = 40
      configureCountMocks(prisma, { api_key_suspicious_use: 1 });
      prisma.apiKey.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });

      const dashboardContext = { ...baseContext, operationType: 'withdrawal' as const };
      const assessment = await service.evaluateRisk(dashboardContext);

      expect(assessment.score).toBe(40);
      expect(assessment.riskLevel).toBe('medium');
      expect(assessment.action).toBe('require_step_up');
    });

    it('returns high risk when score is 51-75', async () => {
      // consecutive_policy_denials (35) + suspicious_key_use (25) = 60
      configureCountMocks(prisma, {
        policy_denied: 3,
        api_key_suspicious_use: 1,
      });

      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.score).toBe(60);
      expect(assessment.riskLevel).toBe('high');
      expect(assessment.action).toBe('block');
    });

    it('returns critical risk when score is 76+', async () => {
      // recent_freeze_event (50) + consecutive_policy_denials (35) = 85
      configureCountMocks(prisma, {
        policy_denied: 3,
        freeze: 2,
      });

      const assessment = await service.evaluateRisk(baseContext);

      expect(assessment.score).toBe(85);
      expect(assessment.riskLevel).toBe('critical');
      expect(assessment.action).toBe('freeze');
    });

    it('blocks instead of freezing for critical dashboard risk without an API key', async () => {
      const dashboardContext = {
        ...baseContext,
        apiKeyId: undefined,
        operationType: 'withdrawal' as const,
      };
      configureCountMocks(prisma, {
        policy_denied: 3,
        freeze: 2,
      });

      const assessment = await service.evaluateRisk(dashboardContext);

      expect(assessment.riskLevel).toBe('critical');
      expect(assessment.action).toBe('block');
    });

    it('queries with OR clause when apiKeyId is present for policy denials', async () => {
      configureCountMocks(prisma, { policy_denied: 0 });

      await service.evaluateRisk(baseContext);

      const calls = prisma.securityEvent.count.mock.calls;
      const policyDenialCall = calls.find((call: [args: { where: Record<string, unknown> }]) => {
        const where = call[0]?.where;
        return where?.eventType && typeof where.eventType === 'object' && 'in' in where.eventType;
      });
      expect(policyDenialCall).toBeDefined();
      expect(policyDenialCall![0].where).toHaveProperty('OR');
    });

    it('queries with userId only when apiKeyId is absent for policy denials', async () => {
      const noKeyContext = { ...baseContext, apiKeyId: undefined };
      configureCountMocks(prisma, { policy_denied: 0 });

      await service.evaluateRisk(noKeyContext);

      const calls = prisma.securityEvent.count.mock.calls;
      const policyDenialCall = calls.find((call: [args: { where: Record<string, unknown> }]) => {
        const where = call[0]?.where;
        return where?.eventType && typeof where.eventType === 'object' && 'in' in where.eventType;
      });
      expect(policyDenialCall).toBeDefined();
      expect(policyDenialCall![0].where).toHaveProperty('userId');
      expect(policyDenialCall![0].where).not.toHaveProperty('OR');
    });
  });

  // ─── enforceRiskAction ────────────────────────────────────────────────

  describe('enforceRiskAction', () => {
    const allowAssessment = {
      riskLevel: 'low' as const,
      score: 10,
      action: 'allow' as const,
      factors: [],
      reason: 'No risk factors detected',
    };

    const stepUpAssessment = {
      riskLevel: 'medium' as const,
      score: 40,
      action: 'require_step_up' as const,
      factors: [
        {
          category: 'identity' as const,
          name: 'consecutive_auth_failures',
          weight: 30,
          description: 'test',
        },
      ],
      reason: 'consecutive_auth_failures(30)',
    };

    const blockAssessment = {
      riskLevel: 'high' as const,
      score: 60,
      action: 'block' as const,
      factors: [
        {
          category: 'transaction' as const,
          name: 'consecutive_policy_denials',
          weight: 35,
          description: 'test',
        },
      ],
      reason: 'consecutive_policy_denials(35)',
    };

    const freezeAssessment = {
      riskLevel: 'critical' as const,
      score: 85,
      action: 'freeze' as const,
      factors: [
        {
          category: 'api_key' as const,
          name: 'recent_freeze_event',
          weight: 50,
          description: 'test',
        },
      ],
      reason: 'recent_freeze_event(50)',
    };

    it('does nothing for allow action', async () => {
      await service.enforceRiskAction(allowAssessment, baseContext);
      expect(securityEvents.record).not.toHaveBeenCalled();
      expect(prisma.apiKey.update).not.toHaveBeenCalled();
    });

    it('throws RiskStepUpRequired for require_step_up action', async () => {
      await expect(service.enforceRiskAction(stepUpAssessment, baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'risk.step_up_required',
          riskLevel: 'medium',
          result: 'denied',
        }),
      );
    });

    it('throws RiskBlocked for block action', async () => {
      await expect(service.enforceRiskAction(blockAssessment, baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'risk.blocked',
          riskLevel: 'high',
          result: 'denied',
        }),
      );
    });

    it('freezes API key and throws RiskCriticalFreeze for freeze action', async () => {
      await expect(service.enforceRiskAction(freezeAssessment, baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      expect(prisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: {
          frozenAt: expect.any(Date),
          frozenReason: expect.stringContaining('Critical risk'),
        },
      });
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'risk.critical_frozen',
          riskLevel: 'critical',
          result: 'denied',
        }),
      );
    });

    it('blocks instead of reporting API-key freeze when apiKeyId is absent for freeze action', async () => {
      const noKeyContext = { ...baseContext, apiKeyId: undefined };

      await expect(service.enforceRiskAction(freezeAssessment, noKeyContext)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            message: 'Operation blocked due to risk assessment',
            error: 'RiskBlocked',
          }),
        },
      );

      expect(prisma.apiKey.update).not.toHaveBeenCalled();
      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'risk.blocked',
          riskLevel: 'critical',
          result: 'denied',
        }),
      );
    });

    it('records SecurityEvent even when freeze fails', async () => {
      prisma.apiKey.update.mockRejectedValue(new Error('DB error'));

      await expect(service.enforceRiskAction(freezeAssessment, baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      // SecurityEvent should still be recorded
      expect(securityEvents.record).toHaveBeenCalled();
    });

    it('continues enforcement even when SecurityEvent recording fails', async () => {
      securityEvents.record.mockRejectedValue(new Error('Event recording failed'));

      await expect(service.enforceRiskAction(blockAssessment, baseContext)).rejects.toThrow(
        ForbiddenException,
      );

      // Should still throw the block exception even if event recording fails
    });

    it('uses actorType api_key when apiKeyId is present', async () => {
      await expect(service.enforceRiskAction(blockAssessment, baseContext)).rejects.toThrow();

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'api_key' }),
      );
    });

    it('uses actorType user when apiKeyId is absent', async () => {
      const noKeyContext = { ...baseContext, apiKeyId: undefined };

      await expect(service.enforceRiskAction(blockAssessment, noKeyContext)).rejects.toThrow();

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'user' }),
      );
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles context without apiKeyId (dashboard operations)', async () => {
      const dashboardContext: RiskEvaluationContext = {
        userId: 'user-1',
        walletId: 'wallet-1',
        operationType: 'withdrawal',
      };

      const assessment = await service.evaluateRisk(dashboardContext);

      expect(assessment.riskLevel).toBe('low');
      expect(assessment.action).toBe('allow');
      // API-key-specific factors should be skipped
      expect(assessment.factors).toEqual([]);
    });

    it('works without SecurityEventService (graceful degradation)', async () => {
      const serviceWithoutEvents = new RiskEvaluationService(prisma as never, undefined);

      // evaluateRisk should still work
      const assessment = await serviceWithoutEvents.evaluateRisk(baseContext);
      expect(assessment.riskLevel).toBe('low');

      // enforceRiskAction for block should still throw
      const blockAssessment = {
        riskLevel: 'high' as const,
        score: 60,
        action: 'block' as const,
        factors: [],
        reason: 'test',
      };
      await expect(
        serviceWithoutEvents.enforceRiskAction(blockAssessment, baseContext),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
