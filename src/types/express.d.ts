import type { ApiKey, User } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: User;
      apiKeyRecord?: ApiKey & { user?: User };
      clerkUserId?: string;
      clerkPayload?: unknown;
    }
  }
}

export {};
