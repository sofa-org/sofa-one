import type { ApiKey, User } from '@prisma/client';
import type { AuthenticatedAppSession } from '../modules/app-session/app-session.service';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: User;
      apiKeyRecord?: ApiKey & { user?: User };
      appSession?: AuthenticatedAppSession;
      stepUpVerified?: boolean;
      openfortUserId?: string;
      openfortAccessToken?: string;
      openfortEmail?: string;
      openfortSession?: unknown;
    }
  }
}

export {};
