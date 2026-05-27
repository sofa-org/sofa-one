import {
  createStepUpChallengeAuth,
  verifyStepUpChallengeAuth,
  type StepUpChallengeResponse,
} from '@/lib/api';

function getStepUpPromptMessage(challenge: StepUpChallengeResponse) {
  if (challenge.code) {
    return `Enter verification code. Development code: ${challenge.code}`;
  }

  return 'Enter the verification code sent to your email.';
}

export async function requestStepUpToken(getToken: () => Promise<string | null>) {
  const challenge = await createStepUpChallengeAuth(getToken);
  const code = window.prompt(getStepUpPromptMessage(challenge));

  if (!code?.trim()) {
    throw new Error('Step-up verification cancelled.');
  }

  const verification = await verifyStepUpChallengeAuth(
    getToken,
    challenge.challengeId,
    code.trim(),
  );
  return verification.proofToken;
}
