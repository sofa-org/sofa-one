import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from './security-event.service';
import type { SecurityEventRiskLevel } from './security-event.service';

/**
 * Recommended action based on risk assessment.
 *
 * - allow: Operation proceeds normally
 * - require_step_up: Dashboard operations require step-up verification;
 *   API-key operations are blocked since there is no user to verify
 * - block: Operation is denied; a SecurityEvent is recorded
 * - freeze: API key is frozen; a critical SecurityEvent is recorded
 *   (only when an API key is present; dashboard critical risk blocks)
 */
export type RiskAction = 'allow' | 'require_step_up' | 'block' | 'freeze';

export type RiskFactor = {
  category: 'identity' | 'api_key' | 'wallet' | 'transaction';
  name: string;
  weight: number;
  description: string;
};

export type RiskAssessment = {
  riskLevel: SecurityEventRiskLevel;
  score: number;
  action: RiskAction;
  factors: RiskFactor[];
  reason: string;
};

export type RiskEvaluationContext = {
  userId: string;
  apiKeyId?: string;
  walletId?: string;
  operationType: 'transaction_send' | 'signing' | 'withdrawal' | 'api_key_use';
  ip?: string;
  userAgent?: string;
};

/** Score thresholds that map cumulative risk scores to risk levels and actions. */
const SCORE_THRESHOLDS = {
  low: { max: 25, riskLevel: 'low' as SecurityEventRiskLevel, action: 'allow' as RiskAction },
  medium: {
    max: 50,
    riskLevel: 'medium' as SecurityEventRiskLevel,
    action: 'require_step_up' as RiskAction,
  },
  high: { max: 75, riskLevel: 'high' as SecurityEventRiskLevel, action: 'block' as RiskAction },
  critical: {
    max: 100,
    riskLevel: 'critical' as SecurityEventRiskLevel,
    action: 'freeze' as RiskAction,
  },
};

/** Operation types that use API-key authentication (no user session for step-up). */
const API_KEY_OPERATIONS: RiskEvaluationContext['operationType'][] = [
  'transaction_send',
  'signing',
  'api_key_use',
];

/** Event types that indicate a policy denial. */
const POLICY_DENIED_EVENT_TYPES = [
  'transaction.policy_denied',
  'withdrawal.policy_denied',
  'signing.policy_denied',
  'eoa_execution_denied',
];

/** Event types that indicate a freeze event. */
const FREEZE_EVENT_TYPES = [
  'api_key_frozen',
  'api_key_frozen_rejected',
  'api_key_user_frozen_rejected',
];

@Injectable()
export class RiskEvaluationService {
  private readonly logger = new Logger(RiskEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * Evaluate multi-factor risk for an operation.
   *
   * Queries recent SecurityEvents and API key metadata to compute a risk
   * score based on factors like consecutive policy denials, auth failures,
   * suspicious key use, IP rejections, recently created keys, high velocity,
   * and recent freeze events.
   *
   * For API-key operations, `require_step_up` is automatically mapped to
   * `block` since there is no user session to prompt for verification.
   */
  async evaluateRisk(context: RiskEvaluationContext): Promise<RiskAssessment> {
    const factors: RiskFactor[] = [];

    const [
      consecutiveDenials,
      authFailures,
      suspiciousKeyUse,
      ipRejected,
      recentlyCreatedKey,
      highVelocity,
      recentFreeze,
    ] = await Promise.all([
      this.checkConsecutivePolicyDenials(context),
      this.checkConsecutiveAuthFailures(context),
      this.checkSuspiciousKeyUse(context),
      this.checkIpRejected(context),
      this.checkRecentlyCreatedKey(context),
      this.checkHighVelocity(context),
      this.checkRecentFreezeEvent(context),
    ]);

    if (consecutiveDenials) factors.push(consecutiveDenials);
    if (authFailures) factors.push(authFailures);
    if (suspiciousKeyUse) factors.push(suspiciousKeyUse);
    if (ipRejected) factors.push(ipRejected);
    if (recentlyCreatedKey) factors.push(recentlyCreatedKey);
    if (highVelocity) factors.push(highVelocity);
    if (recentFreeze) factors.push(recentFreeze);

    const score = Math.min(
      100,
      factors.reduce((total, f) => total + f.weight, 0),
    );
    const { riskLevel, action: baseAction } = this.scoreToLevelAndAction(score);

    // For API-key operations, require_step_up maps to block; for dashboard
    // operations, critical risk blocks because there is no API key to freeze.
    let action = baseAction;
    if (action === 'require_step_up' && API_KEY_OPERATIONS.includes(context.operationType)) {
      action = 'block';
    } else if (action === 'freeze' && !context.apiKeyId) {
      action = 'block';
    }

    const reason =
      factors.length === 0
        ? 'No risk factors detected'
        : factors.map((f) => `${f.name}(${f.weight})`).join(' + ');

    const assessment: RiskAssessment = { riskLevel, score, action, factors, reason };

    this.logger.log({
      message: 'Risk evaluation completed',
      userId: context.userId,
      apiKeyId: context.apiKeyId,
      operationType: context.operationType,
      riskLevel,
      score,
      action,
      factorCount: factors.length,
    });

    return assessment;
  }

  /**
   * Enforce the recommended action from a risk assessment.
   *
   * - allow: No-op, operation proceeds
   * - require_step_up: Throws ForbiddenException with `RiskStepUpRequired` error code
   * - block: Records a SecurityEvent and throws ForbiddenException
   * - freeze: Freezes the API key, records a critical SecurityEvent, throws ForbiddenException
   */
  async enforceRiskAction(
    assessment: RiskAssessment,
    context: RiskEvaluationContext,
  ): Promise<void> {
    if (assessment.action === 'allow') return;

    const action =
      assessment.action === 'freeze' && !context.apiKeyId ? 'block' : assessment.action;
    const eventType =
      action === 'freeze'
        ? 'risk.critical_frozen'
        : action === 'require_step_up'
          ? 'risk.step_up_required'
          : 'risk.blocked';

    try {
      await this.securityEvents?.record({
        actorType: context.apiKeyId ? 'api_key' : 'user',
        eventType,
        userId: context.userId,
        apiKeyId: context.apiKeyId,
        walletId: context.walletId,
        riskLevel: assessment.riskLevel,
        result: 'denied',
        reason: assessment.reason,
        metadata: {
          operationType: context.operationType,
          factors: assessment.factors.map((f) => f.name),
          score: assessment.score,
        },
      });
    } catch (error) {
      this.logger.error('Failed to record risk enforcement event', error);
    }

    if (action === 'freeze') {
      await this.freezeApiKey(context.apiKeyId!, assessment.reason);
    }

    if (action === 'require_step_up') {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Additional verification required due to risk assessment',
        error: 'RiskStepUpRequired',
        risk: this.toRiskResponse(assessment),
      });
    }

    throw new ForbiddenException({
      statusCode: 403,
      message:
        action === 'freeze'
          ? 'API key frozen due to critical risk assessment'
          : 'Operation blocked due to risk assessment',
      error: action === 'freeze' ? 'RiskCriticalFreeze' : 'RiskBlocked',
      risk: this.toRiskResponse(assessment),
    });
  }

  // ─── Risk Factor Checks ──────────────────────────────────────────────

  /** 2+ policy denials in the last hour → weight 35 */
  private async checkConsecutivePolicyDenials(
    context: RiskEvaluationContext,
  ): Promise<RiskFactor | null> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const where: Record<string, unknown> = {
      eventType: { in: POLICY_DENIED_EVENT_TYPES },
      createdAt: { gte: oneHourAgo },
    };
    if (context.apiKeyId) {
      where.OR = [{ userId: context.userId }, { apiKeyId: context.apiKeyId }];
    } else {
      where.userId = context.userId;
    }

    const count = await this.prisma.securityEvent.count({ where });
    if (count >= 2) {
      return {
        category: 'transaction',
        name: 'consecutive_policy_denials',
        weight: 35,
        description: `${count} policy denials in the last hour`,
      };
    }
    return null;
  }

  /** 3+ authentication failures in the last hour → weight 30 */
  private async checkConsecutiveAuthFailures(
    context: RiskEvaluationContext,
  ): Promise<RiskFactor | null> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.prisma.securityEvent.count({
      where: {
        userId: context.userId,
        eventType: 'login.failed',
        createdAt: { gte: oneHourAgo },
      },
    });
    if (count >= 3) {
      return {
        category: 'identity',
        name: 'consecutive_auth_failures',
        weight: 30,
        description: `${count} authentication failures in the last hour`,
      };
    }
    return null;
  }

  /** Any suspicious key use in the last 24 hours → weight 25 */
  private async checkSuspiciousKeyUse(context: RiskEvaluationContext): Promise<RiskFactor | null> {
    if (!context.apiKeyId) return null;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.securityEvent.count({
      where: {
        apiKeyId: context.apiKeyId,
        eventType: 'api_key_suspicious_use',
        createdAt: { gte: twentyFourHoursAgo },
      },
    });
    if (count > 0) {
      return {
        category: 'api_key',
        name: 'suspicious_key_use',
        weight: 25,
        description: 'API key has suspicious use events in the last 24 hours',
      };
    }
    return null;
  }

  /** Any IP rejection in the last 24 hours → weight 20 */
  private async checkIpRejected(context: RiskEvaluationContext): Promise<RiskFactor | null> {
    if (!context.apiKeyId) return null;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.securityEvent.count({
      where: {
        apiKeyId: context.apiKeyId,
        eventType: 'api_key.ip_rejected',
        createdAt: { gte: twentyFourHoursAgo },
      },
    });
    if (count > 0) {
      return {
        category: 'api_key',
        name: 'ip_rejected',
        weight: 20,
        description: 'API key had IP rejections in the last 24 hours',
      };
    }
    return null;
  }

  /** API key created less than 1 hour ago → weight 15 */
  private async checkRecentlyCreatedKey(
    context: RiskEvaluationContext,
  ): Promise<RiskFactor | null> {
    if (!context.apiKeyId) return null;
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: context.apiKeyId },
      select: { createdAt: true },
    });
    if (!apiKey) return null;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (apiKey.createdAt > oneHourAgo) {
      return {
        category: 'api_key',
        name: 'recently_created_key',
        weight: 15,
        description: 'API key was created less than 1 hour ago',
      };
    }
    return null;
  }

  /** 50+ events for this API key in the last hour → weight 20 */
  private async checkHighVelocity(context: RiskEvaluationContext): Promise<RiskFactor | null> {
    if (!context.apiKeyId) return null;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.prisma.securityEvent.count({
      where: {
        apiKeyId: context.apiKeyId,
        createdAt: { gte: oneHourAgo },
      },
    });
    if (count > 50) {
      return {
        category: 'api_key',
        name: 'high_velocity',
        weight: 20,
        description: `${count} events for this API key in the last hour`,
      };
    }
    return null;
  }

  /** Any freeze event in the last 24 hours → weight 50 */
  private async checkRecentFreezeEvent(context: RiskEvaluationContext): Promise<RiskFactor | null> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const where: Record<string, unknown> = {
      eventType: { in: FREEZE_EVENT_TYPES },
      createdAt: { gte: twentyFourHoursAgo },
    };
    if (context.apiKeyId) {
      where.OR = [{ userId: context.userId }, { apiKeyId: context.apiKeyId }];
    } else {
      where.userId = context.userId;
    }

    const count = await this.prisma.securityEvent.count({ where });
    if (count > 0) {
      return {
        category: 'api_key',
        name: 'recent_freeze_event',
        weight: 50,
        description: 'Recent freeze event detected in the last 24 hours',
      };
    }
    return null;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private scoreToLevelAndAction(score: number): {
    riskLevel: SecurityEventRiskLevel;
    action: RiskAction;
  } {
    if (score <= SCORE_THRESHOLDS.low.max) {
      return { riskLevel: 'low', action: 'allow' };
    }
    if (score <= SCORE_THRESHOLDS.medium.max) {
      return { riskLevel: 'medium', action: 'require_step_up' };
    }
    if (score <= SCORE_THRESHOLDS.high.max) {
      return { riskLevel: 'high', action: 'block' };
    }
    return { riskLevel: 'critical', action: 'freeze' };
  }

  private async freezeApiKey(apiKeyId: string, reason: string): Promise<void> {
    try {
      await this.prisma.apiKey.update({
        where: { id: apiKeyId },
        data: {
          frozenAt: new Date(),
          frozenReason: `Critical risk: ${reason}`,
        },
      });
      this.logger.warn({
        message: 'API key frozen due to critical risk assessment',
        apiKeyId,
        reason,
      });
    } catch (error) {
      this.logger.error('Failed to freeze API key', error);
    }
  }

  private toRiskResponse(assessment: RiskAssessment) {
    return {
      riskLevel: assessment.riskLevel,
      score: assessment.score,
      factors: assessment.factors.map((f) => f.name),
      reason: assessment.reason,
    };
  }
}
