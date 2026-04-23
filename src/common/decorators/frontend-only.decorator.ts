import { SetMetadata } from '@nestjs/common';

export const IS_FRONTEND_ONLY_KEY = 'isFrontendOnly';

/** Mark a route as frontend-only — enforces Origin/Referer check via FrontendOnlyGuard. */
export const FrontendOnly = () => SetMetadata(IS_FRONTEND_ONLY_KEY, true);
