import {
  verifyTotpAuth,
} from '@/lib/api';
import { storeDashboardStepUpProof } from './step-up-session';

export async function requestStepUpToken(getToken: () => Promise<string | null>) {
  const code = window.prompt('Enter your 6-digit authenticator code.');

  if (!code?.trim()) {
    throw new Error('Step-up verification cancelled.');
  }

  const verification = await verifyTotpAuth(getToken, code.trim());
  storeDashboardStepUpProof(verification);
  return verification.proofToken;
}
