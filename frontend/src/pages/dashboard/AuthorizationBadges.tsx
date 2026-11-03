import type { WalletInfo } from '@/lib/api';
import {
  formatAuthorizationExpiry,
  getAuthorizationBadgeClasses,
  formatAgentStatus,
} from './wallet-helpers';
import { formatChainName } from '@/lib/chains';
import { isAuthorizationReady } from './wallet-recovery';

interface AuthorizationBadgesProps {
  authorizations: WalletInfo['chainAuthorizations'];
  now: number;
}

export function AuthorizationBadges({ authorizations, now }: AuthorizationBadgesProps) {
  if (authorizations.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {authorizations.map((authorization) => {
        const expiry = formatAuthorizationExpiry(authorization.expiresAt);
        const status = authorization.status === 'registered' && !isAuthorizationReady(authorization, now) ? 'expired' : authorization.status;
        return (
          <span
            key={authorization.chainId}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getAuthorizationBadgeClasses(status)}`}
          >
            <span>{formatChainName(authorization.chainId)}</span>
            <span className="font-mono font-medium opacity-75">{authorization.chainId}</span>
            <span className="font-medium opacity-80">{formatAgentStatus(status)}</span>
            {expiry && <span className="font-medium opacity-80">· {expiry.relativeLabel}</span>}
          </span>
        );
      })}
    </div>
  );
}
