const STEP_UP_SESSION_KEY = 'sofa-one:dashboard-step-up';
let currentSessionId: string | null = null;

type StepUpProof = { proofToken: string; expiresAt: string };
type StoredStepUpProof = StepUpProof & { sessionId: string };

function readStoredProof(): StoredStepUpProof | null {
  try {
    const raw = window.sessionStorage.getItem(STEP_UP_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredStepUpProof>;
    if (typeof parsed.proofToken !== 'string' || typeof parsed.expiresAt !== 'string' ||
        typeof parsed.sessionId !== 'string') return null;
    return parsed as StoredStepUpProof;
  } catch {
    return null;
  }
}

export function bindDashboardStepUpSession(sessionId: string | null) {
  const proof = readStoredProof();
  if (proof?.sessionId !== sessionId) clearDashboardStepUpProof();
  currentSessionId = sessionId;
}

export function getDashboardStepUpSessionId() {
  return currentSessionId;
}

export function getDashboardStepUpToken() {
  const proof = readStoredProof();
  if (!currentSessionId || !proof || proof.sessionId !== currentSessionId) return null;
  const expiresAt = Date.parse(proof.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearDashboardStepUpProof();
    return null;
  }
  return proof.proofToken;
}

export function storeDashboardStepUpProof(proof: StepUpProof, sessionId: string | null): boolean {
  if (!sessionId || sessionId !== currentSessionId) return false;
  try {
    window.sessionStorage.setItem(STEP_UP_SESSION_KEY, JSON.stringify({ ...proof, sessionId }));
  } catch {
    // Storage can be disabled; verification itself remains server-authoritative.
  }
  return true;
}

export function clearDashboardStepUpProof() {
  try { window.sessionStorage.removeItem(STEP_UP_SESSION_KEY); } catch { /* Storage unavailable. */ }
}
