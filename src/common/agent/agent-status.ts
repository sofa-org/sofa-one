export const AgentStatus = {
  RegistrationRequired: 'registration_required',
  PendingRegistration: 'pending_registration',
  Registered: 'registered',
  RegistrationFailed: 'registration_failed',
  Expired: 'expired',
} as const;

export type AgentStatusValue = (typeof AgentStatus)[keyof typeof AgentStatus];
