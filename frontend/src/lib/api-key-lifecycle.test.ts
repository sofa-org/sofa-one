import { describe, expect, it } from 'vitest';

import {
  formatApiKeyFrozenReason,
  getApiKeyLifecycleLabel,
  getApiKeyLifecycleSortRank,
  getApiKeyLifecycleStatus,
  isApiKeyLifecycleActive,
  matchesApiKeyLifecycleFilter,
  type ApiKeyLifecycleFields,
} from './api';

const NOW = Date.parse('2026-09-21T12:00:00.000Z');

function fields(over: Partial<ApiKeyLifecycleFields> = {}): ApiKeyLifecycleFields {
  return {
    revoked: false,
    frozenAt: null,
    expiresAt: null,
    ...over,
  };
}

describe('getApiKeyLifecycleStatus — priority revoked > frozen > expired > active', () => {
  it('returns active for a non-revoked, non-frozen, non-expired key', () => {
    expect(
      getApiKeyLifecycleStatus(
        fields({ expiresAt: '2026-12-01T00:00:00.000Z' }),
        NOW,
      ),
    ).toBe('active');
    expect(isApiKeyLifecycleActive(fields({ expiresAt: '2026-12-01T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('returns frozen for a non-revoked key with frozenAt set', () => {
    expect(
      getApiKeyLifecycleStatus(
        fields({
          frozenAt: '2026-09-18T00:00:00.000Z',
          expiresAt: '2026-12-01T00:00:00.000Z',
        }),
        NOW,
      ),
    ).toBe('frozen');
    expect(
      isApiKeyLifecycleActive(fields({ frozenAt: '2026-09-18T00:00:00.000Z' }), NOW),
    ).toBe(false);
  });

  it('returns expired when expiresAt is in the past and key is not revoked/frozen', () => {
    expect(
      getApiKeyLifecycleStatus(fields({ expiresAt: '2026-09-01T00:00:00.000Z' }), NOW),
    ).toBe('expired');
  });

  it('prefers revoked over frozen and expired', () => {
    expect(
      getApiKeyLifecycleStatus(
        fields({
          revoked: true,
          frozenAt: '2026-09-18T00:00:00.000Z',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        NOW,
      ),
    ).toBe('revoked');
  });

  it('prefers frozen over expired when both apply', () => {
    expect(
      getApiKeyLifecycleStatus(
        fields({
          frozenAt: '2026-09-18T00:00:00.000Z',
          expiresAt: '2026-09-01T00:00:00.000Z',
        }),
        NOW,
      ),
    ).toBe('frozen');
  });
});

describe('matchesApiKeyLifecycleFilter', () => {
  const active = fields({ expiresAt: '2026-12-01T00:00:00.000Z' });
  const frozen = fields({ frozenAt: '2026-09-18T00:00:00.000Z' });
  const expired = fields({ expiresAt: '2026-09-01T00:00:00.000Z' });
  const revoked = fields({ revoked: true });

  it('keeps frozen keys out of the Active filter', () => {
    expect(matchesApiKeyLifecycleFilter(frozen, 'active', NOW)).toBe(false);
    expect(matchesApiKeyLifecycleFilter(active, 'active', NOW)).toBe(true);
    expect(matchesApiKeyLifecycleFilter(expired, 'active', NOW)).toBe(false);
    expect(matchesApiKeyLifecycleFilter(revoked, 'active', NOW)).toBe(false);
  });

  it('filters frozen, expired, and revoked sets independently', () => {
    expect(matchesApiKeyLifecycleFilter(frozen, 'frozen', NOW)).toBe(true);
    expect(matchesApiKeyLifecycleFilter(active, 'frozen', NOW)).toBe(false);
    expect(matchesApiKeyLifecycleFilter(expired, 'expired', NOW)).toBe(true);
    expect(matchesApiKeyLifecycleFilter(revoked, 'revoked', NOW)).toBe(true);
    expect(matchesApiKeyLifecycleFilter(frozen, 'all', NOW)).toBe(true);
  });
});

describe('lifecycle labels, sort rank, and freeze reason copy', () => {
  it('labels match status tokens used by filters and badges', () => {
    expect(getApiKeyLifecycleLabel('active')).toBe('Active');
    expect(getApiKeyLifecycleLabel('frozen')).toBe('Frozen');
    expect(getApiKeyLifecycleLabel('expired')).toBe('Expired');
    expect(getApiKeyLifecycleLabel('revoked')).toBe('Revoked');
  });

  it('sorts active before frozen before expired before revoked', () => {
    expect(getApiKeyLifecycleSortRank('active')).toBeLessThan(getApiKeyLifecycleSortRank('frozen'));
    expect(getApiKeyLifecycleSortRank('frozen')).toBeLessThan(getApiKeyLifecycleSortRank('expired'));
    expect(getApiKeyLifecycleSortRank('expired')).toBeLessThan(getApiKeyLifecycleSortRank('revoked'));
  });

  it('maps known freeze reasons to safe recovery-oriented copy', () => {
    expect(formatApiKeyFrozenReason(null)).toMatch(/security review/i);
    expect(formatApiKeyFrozenReason('repeated_context_changed')).toMatch(/IP or client changes/i);
    expect(formatApiKeyFrozenReason('Critical risk: anomalous spend')).toMatch(/critical risk/i);
    expect(formatApiKeyFrozenReason('api_key_frozen')).toMatch(/suspicious/i);
  });
});
