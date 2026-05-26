import type { WalletInfo } from '@/lib/api';
import {
  formatAuthorizationExpiry,
  getAuthorizationBadgeClasses,
  getChainDisplayName,
  formatAgentStatus,
} from './wallet-helpers';

interface AuthorizationBadgesProps {
  authorizations: WalletInfo['chainAuthorizations'];
}

export function AuthorizationBadges({ authorizations }: AuthorizationBadgesProps) {
  if (authorizations.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {authorizations.map((authorization) => {
        const expiry = formatAuthorizationExpiry(authorization.expiresAt);
        return (
          <span
            key={authorization.chainId}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getAuthorizationBadgeClasses(authorization.status)}`}
          >
            <span>{getChainDisplayName(authorization.chainId)}</span>
            <span className="font-mono font-medium opacity-75">{authorization.chainId}</span>
            <span className="font-medium opacity-80">{formatAgentStatus(authorization.status)}</span>
            {expiry && <span className="font-medium opacity-80">· {expiry.relativeLabel}</span>}
          </span>
        );
      })}
    </div>
  );
}
