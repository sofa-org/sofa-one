import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Mark a route as public — bypasses EitherAuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
