import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Mark a route as public — authentication guards short-circuit for the route. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
