import { SetMetadata } from '@nestjs/common';

export type ApiKeyPermission =
  | 'canSign'
  | 'canSendTransaction'
  | 'canReadTransactionStatus'
  | 'canUseEoaExecution';

export const API_KEY_PERMISSION_KEY = 'apiKeyPermission';

/**
 * Marks an API-key route as requiring a specific permission before service code runs.
 * Services should keep their own permission checks as a second line of defense.
 */
export const RequireApiKeyPermission = (permission: ApiKeyPermission) =>
  SetMetadata(API_KEY_PERMISSION_KEY, permission);
