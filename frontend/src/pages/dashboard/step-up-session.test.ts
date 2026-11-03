import { beforeEach, describe, expect, it } from 'vitest';
import { bindDashboardStepUpSession, clearDashboardStepUpProof, getDashboardStepUpSessionId, getDashboardStepUpToken, storeDashboardStepUpProof } from './step-up-session';

beforeEach(() => { window.sessionStorage.clear(); bindDashboardStepUpSession(null); });
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();

describe('session-bound step-up proof cache', () => {
  it('does not accept legacy unbound proof storage or storage without server session binding', () => {
    window.sessionStorage.setItem('sofa-one:dashboard-step-up', JSON.stringify({ proofToken: 'legacy', expiresAt: expiresAt() }));
    expect(getDashboardStepUpToken()).toBeNull();
    bindDashboardStepUpSession('session-1');
    expect(getDashboardStepUpToken()).toBeNull();
  });
  it('persists only for the exact server session and clears on replacement and logout', () => {
    bindDashboardStepUpSession('session-1');
    storeDashboardStepUpProof({ proofToken: 'proof', expiresAt: expiresAt() }, 'session-1');
    expect(getDashboardStepUpToken()).toBe('proof');
    bindDashboardStepUpSession('session-1');
    expect(getDashboardStepUpToken()).toBe('proof');
    bindDashboardStepUpSession('session-2');
    expect(getDashboardStepUpToken()).toBeNull();
    storeDashboardStepUpProof({ proofToken: 'second', expiresAt: expiresAt() }, 'session-2');
    bindDashboardStepUpSession(null);
    expect(getDashboardStepUpToken()).toBeNull();
    expect(window.sessionStorage.getItem('sofa-one:dashboard-step-up')).toBeNull();
  });
  it('rejects expired proofs and does not write a proof without authentication', () => {
    storeDashboardStepUpProof({ proofToken: 'unauthenticated', expiresAt: expiresAt() }, 'session-1');
    expect(window.sessionStorage.getItem('sofa-one:dashboard-step-up')).toBeNull();
    bindDashboardStepUpSession('session-1');
    storeDashboardStepUpProof({ proofToken: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() }, 'session-1');
    expect(getDashboardStepUpToken()).toBeNull();
    clearDashboardStepUpProof();
    expect(window.sessionStorage.getItem('sofa-one:dashboard-step-up')).toBeNull();
  });

  it('discards a delayed verification from a replaced session without poisoning its replacement', () => {
    bindDashboardStepUpSession('session-1');
    const originatingSession = getDashboardStepUpSessionId();
    bindDashboardStepUpSession('session-2');
    storeDashboardStepUpProof({ proofToken: 'current-proof', expiresAt: expiresAt() }, 'session-2');
    expect(storeDashboardStepUpProof({ proofToken: 'late-proof', expiresAt: expiresAt() }, originatingSession)).toBe(false);
    expect(getDashboardStepUpToken()).toBe('current-proof');
  });
});
