import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_MFA_KEY = 'allowPendingMfa';
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA_KEY, true);
