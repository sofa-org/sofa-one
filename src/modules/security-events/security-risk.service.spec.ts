import { SecurityRiskService } from './security-risk.service';

describe('SecurityRiskService', () => {
  let service: SecurityRiskService;

  beforeEach(() => {
    service = new SecurityRiskService();
  });

  it('keeps ordinary lifecycle events low risk', () => {
    expect(service.score({ actorType: 'user', eventType: 'api_key.created' })).toEqual({
      riskLevel: 'low',
      score: 10,
      reasons: ['default'],
    });
  });

  it('scores first API-key use as medium risk', () => {
    expect(service.score({ actorType: 'api_key', eventType: 'api_key.first_used' })).toEqual({
      riskLevel: 'medium',
      score: 40,
      reasons: ['event:api_key.first_used'],
    });
  });

  it('scores policy-denied transaction events as high risk', () => {
    expect(
      service.score({
        actorType: 'api_key',
        eventType: 'transaction.policy_denied',
        result: 'denied',
      }),
    ).toEqual({
      riskLevel: 'high',
      score: 70,
      reasons: ['event:transaction.policy_denied'],
    });
  });

  it('scores frozen-key events as critical risk', () => {
    expect(service.score({ actorType: 'api_key', eventType: 'api_key_frozen' })).toEqual({
      riskLevel: 'critical',
      score: 95,
      reasons: ['event:api_key_frozen'],
    });
  });

  it('raises denied unknown events to high risk', () => {
    expect(
      service.score({ actorType: 'system', eventType: 'unknown.policy_denied', result: 'denied' }),
    ).toEqual({
      riskLevel: 'high',
      score: 70,
      reasons: ['result:denied'],
    });
  });

  it('does not downgrade an explicit higher risk level', () => {
    expect(
      service.score({
        actorType: 'system',
        eventType: 'api_key.first_used',
        riskLevel: 'critical',
      }),
    ).toEqual({
      riskLevel: 'critical',
      score: 95,
      reasons: ['event:api_key.first_used', 'explicit:critical'],
    });
  });
});
