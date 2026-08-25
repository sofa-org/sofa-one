const STEP_UP_SESSION_KEY = 'sofa-one:dashboard-step-up';

type StoredStepUpProof = {
  proofToken: string;
  expiresAt: string;
};

function readStoredProof(): StoredStepUpProof | null {
  const raw = window.sessionStorage.getItem(STEP_UP_SESSION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredStepUpProof>;
    if (typeof parsed.proofToken !== 'string' || typeof parsed.expiresAt !== 'string') {
      return null;
    }
    return { proofToken: parsed.proofToken, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function getDashboardStepUpToken() {
  const proof = readStoredProof();
  if (!proof) return null;

  const expiresAt = Date.parse(proof.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearDashboardStepUpProof();
    return null;
  }

  return proof.proofToken;
}

export function storeDashboardStepUpProof(proof: StoredStepUpProof) {
  window.sessionStorage.setItem(STEP_UP_SESSION_KEY, JSON.stringify(proof));
}

export function clearDashboardStepUpProof() {
  window.sessionStorage.removeItem(STEP_UP_SESSION_KEY);
}
