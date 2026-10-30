import {
  verifyTotpAuth,
} from '@/lib/api';
import { getDashboardStepUpSessionId, storeDashboardStepUpProof } from './step-up-session';

export async function requestStepUpToken() {
  const sessionId = getDashboardStepUpSessionId();
  if (!sessionId) throw new Error('Your SOFA session is not ready. Sign in again.');
  const code = window.prompt('Enter your 6-digit authenticator code.');

  if (!code?.trim()) {
    throw new Error('Step-up verification cancelled.');
  }

  const verification = await verifyTotpAuth(code.trim());
  if (!storeDashboardStepUpProof(verification, sessionId)) {
    throw new Error('Session changed during authenticator verification. Try again.');
  }
  return verification.proofToken;
}
