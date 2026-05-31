import { Injectable } from '@nestjs/common';
import type { RecordSecurityEventInput, SecurityEventRiskLevel } from './security-event.service';

export type SecurityRiskScore = {
  riskLevel: SecurityEventRiskLevel;
  score: number;
  reasons: string[];
};

const RISK_SCORE: Record<SecurityEventRiskLevel, number> = {
  low: 10,
  medium: 40,
  high: 70,
  critical: 95,
};

const EVENT_RISK_RULES: Array<{
  eventType: string;
  riskLevel: SecurityEventRiskLevel;
}> = [
  { eventType: 'api_key_frozen', riskLevel: 'critical' },
  { eventType: 'api_key_frozen_rejected', riskLevel: 'critical' },
  { eventType: 'api_key_user_frozen_rejected', riskLevel: 'critical' },
  { eventType: 'eoa_execution_denied', riskLevel: 'critical' },
  { eventType: 'api_key_suspicious_use', riskLevel: 'high' },
  { eventType: 'transaction.policy_denied', riskLevel: 'high' },
  { eventType: 'transaction.simulation_denied', riskLevel: 'high' },
  { eventType: 'withdrawal.policy_denied', riskLevel: 'high' },
  { eventType: 'withdrawal.high_value_requested', riskLevel: 'high' },
  { eventType: 'eoa_execution_allowed', riskLevel: 'high' },
  { eventType: 'api_key.first_used', riskLevel: 'medium' },
  { eventType: 'withdrawal_address.added', riskLevel: 'medium' },
  { eventType: 'withdrawal_address.removed', riskLevel: 'medium' },
  { eventType: 'login.new_ip', riskLevel: 'medium' },
  { eventType: 'login.failed', riskLevel: 'high' },
  { eventType: 'signing.policy_denied', riskLevel: 'high' },
  { eventType: 'signing.message_allowed', riskLevel: 'low' },
  { eventType: 'signing.typed_data_allowed', riskLevel: 'low' },
  { eventType: 'api_key.ip_rejected', riskLevel: 'high' },
  { eventType: 'risk.blocked', riskLevel: 'high' },
  { eventType: 'risk.critical_frozen', riskLevel: 'critical' },
  { eventType: 'risk.step_up_required', riskLevel: 'medium' },
];

@Injectable()
export class SecurityRiskService {
  score(input: RecordSecurityEventInput): SecurityRiskScore {
    const eventType = input.eventType.trim();
    const inferred = this.inferRiskLevel(input, eventType);
    const riskLevel = this.maxRisk(input.riskLevel ?? 'low', inferred.riskLevel);

    return {
      riskLevel,
      score: RISK_SCORE[riskLevel],
      reasons: this.reasons(input, inferred.reason, riskLevel),
    };
  }

  private inferRiskLevel(input: RecordSecurityEventInput, eventType: string) {
    const eventRule = EVENT_RISK_RULES.find((rule) => rule.eventType === eventType);
    if (eventRule) {
      return { riskLevel: eventRule.riskLevel, reason: `event:${eventType}` };
    }

    if (input.result === 'denied') {
      return { riskLevel: 'high' as const, reason: 'result:denied' };
    }

    return { riskLevel: 'low' as const, reason: 'default' };
  }

  private maxRisk(
    explicitRisk: SecurityEventRiskLevel,
    inferredRisk: SecurityEventRiskLevel,
  ): SecurityEventRiskLevel {
    return RISK_SCORE[explicitRisk] >= RISK_SCORE[inferredRisk] ? explicitRisk : inferredRisk;
  }

  private reasons(
    input: RecordSecurityEventInput,
    inferredReason: string,
    riskLevel: SecurityEventRiskLevel,
  ) {
    const reasons = [inferredReason];
    if (input.riskLevel && input.riskLevel !== riskLevel) {
      reasons.push(`raised_from:${input.riskLevel}`);
    } else if (input.riskLevel) {
      reasons.push(`explicit:${input.riskLevel}`);
    }
    return reasons;
  }
}
