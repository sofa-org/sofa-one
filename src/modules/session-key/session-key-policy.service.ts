import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import {
  hasCaliburDelegation,
  isCaliburKeyRegistered,
  getCaliburKeySettings,
  getAgentKeyUsabilityFailure,
  encodeUpdateKeySettings,
  ZERO_ADDRESS,
  type CaliburKeySettings,
} from '../../common/calibur/calibur';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { createPublicClient, http, type Hex } from 'viem';

export type SessionKeyPolicyContext = {
  userId: string;
  walletId: string;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  chainId: number;
  accountAddress: string;
  keyHash: string;
  operation: 'sign' | 'send_transaction';
  /** Backend policy constraints for drift detection */
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
  dailySpendLimit?: string | null;
  monthlySpendLimit?: string | null;
  apiKeyExpiresAt?: Date | string | null;
};

export type OnChainKeyStatus = {
  delegated: boolean;
  registered: boolean;
  usable: boolean;
  settings?: CaliburKeySettings;
  failureReason?: string;
};

export type PolicyDriftAssessment = {
  hasDrift: boolean;
  drifts: string[];
};

const SESSION_KEY_EVENT_TYPES: Record<string, string> = {
  session_key_policy_drift: 'session_key.policy_drift',
  session_key_expiration_mismatch: 'session_key.expiration_mismatch',
};

@Injectable()
export class SessionKeyPolicyService {
  private readonly logger = new Logger(SessionKeyPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * Validate that a session key operation is allowed.
   *
   * Checks on-chain key validity (delegation, registration, usability),
   * detects policy drift between backend constraints and on-chain capabilities,
   * and checks expiration alignment between API key and on-chain key.
   *
   * Throws ForbiddenException if the key is not usable on-chain.
   * Throws ServiceUnavailableException if the on-chain verification RPC fails.
   */
  async assertSessionKeyAllowed(context: SessionKeyPolicyContext): Promise<void> {
    // 1. Verify on-chain key status
    const onChainStatus = await this.verifyOnChainKeyStatus(
      context.accountAddress,
      context.keyHash,
      context.chainId,
    );

    if (!onChainStatus.usable) {
      await this.recordDecision(context, 'denied', `session_key_${onChainStatus.failureReason}`);
      throw new ForbiddenException(
        `Session key is not usable on-chain: ${onChainStatus.failureReason}`,
      );
    }

    // 2. Check expiration alignment between API key and on-chain key
    if (onChainStatus.settings && context.apiKeyExpiresAt) {
      const apiKeyExpiration = new Date(context.apiKeyExpiresAt);
      const onChainExpiration = new Date(onChainStatus.settings.expiration * 1000);

      // If on-chain key expires before API key, the on-chain enforcement will
      // stop working before the API key expires — flag this as a drift
      if (onChainExpiration < apiKeyExpiration) {
        await this.recordDecision(context, 'allowed', 'session_key_expiration_mismatch', {
          onChainExpiration: onChainStatus.settings.expiration,
          apiKeyExpiration: apiKeyExpiration.toISOString(),
        });
        this.logger.warn(
          `On-chain key expires before API key for wallet ${context.walletId}: ` +
            `on-chain=${onChainStatus.settings.expiration}, api-key=${apiKeyExpiration.toISOString()}`,
        );
      }
    }

    // 3. Detect policy drift (backend restrictions not enforceable on-chain)
    const drift = this.detectPolicyDrift(context);
    if (drift.hasDrift) {
      await this.recordDecision(context, 'allowed', 'session_key_policy_drift', {
        drifts: drift.drifts,
      });
      this.logger.warn(
        `Session key policy drift for wallet ${context.walletId}: ${drift.drifts.join(', ')}`,
      );
    }

    // 4. Record allowed event
    await this.recordDecision(context, 'allowed', 'session_key_allowed');
  }

  /**
   * Verify on-chain key status by checking Calibur delegation, registration, and settings.
   *
   * Returns a structured status object. Throws ServiceUnavailableException
   * if the blockchain RPC call fails (fail-closed for security).
   */
  async verifyOnChainKeyStatus(
    accountAddress: string,
    keyHash: string,
    chainId: number,
  ): Promise<OnChainKeyStatus> {
    try {
      const { chain } = getSupportedChain(chainId);
      const client = createPublicClient({ chain, transport: http() });
      const account = accountAddress as Hex;
      const key = keyHash as Hex;

      const delegated = await hasCaliburDelegation(client, account);
      if (!delegated) {
        return {
          delegated: false,
          registered: false,
          usable: false,
          failureReason: 'not_delegated',
        };
      }

      const registered = await isCaliburKeyRegistered(client, account, key);
      if (!registered) {
        return {
          delegated: true,
          registered: false,
          usable: false,
          failureReason: 'not_registered',
        };
      }

      const settings = await getCaliburKeySettings(client, account, key);
      const failure = getAgentKeyUsabilityFailure(settings);

      if (failure) {
        return {
          delegated: true,
          registered: true,
          usable: false,
          settings,
          failureReason: failure,
        };
      }

      return { delegated: true, registered: true, usable: true, settings };
    } catch (error: any) {
      this.logger.error(
        `Failed to verify on-chain key status for account ${accountAddress}: ${error.message}`,
        error.stack,
      );
      // Fail-closed: if we can't verify on-chain status, block the operation
      // This prevents operations with potentially revoked keys when RPC is unavailable
      throw new ServiceUnavailableException(
        'Unable to verify session key status on-chain. Please try again later.',
      );
    }
  }

  /**
   * Detect drift between backend policy and on-chain capabilities.
   *
   * Backend policy can be MORE restrictive than on-chain (which is fine —
   * defense in depth), but we flag when backend restrictions have NO on-chain
   * enforcement, since a compromised backend API key could bypass those
   * restrictions by interacting with the chain directly.
   */
  detectPolicyDrift(context: SessionKeyPolicyContext): PolicyDriftAssessment {
    const drifts: string[] = [];

    // Calibur doesn't enforce contract/selector/spend restrictions on-chain
    // If backend has these restrictions, they're backend-only (defense in depth)
    if (context.allowedContracts?.length) {
      drifts.push('allowedContracts_not_enforced_on_chain');
    }

    if (context.allowedFunctionSelectors?.length) {
      drifts.push('allowedFunctionSelectors_not_enforced_on_chain');
    }

    if (context.dailySpendLimit || context.monthlySpendLimit) {
      drifts.push('spend_limits_not_enforced_on_chain');
    }

    return { hasDrift: drifts.length > 0, drifts };
  }

  /**
   * Generate revocation calldata for a session key.
   *
   * Encodes a Calibur update(keyHash, settings) call that sets expiration to 0,
   * effectively revoking the key on-chain. The user must sign and submit this
   * transaction from their EOA (the account owner).
   */
  generateRevocationCalldata(keyHash: string): Hex {
    return encodeUpdateKeySettings(keyHash as Hex, {
      expiration: 0,
      isAdmin: false,
      hook: ZERO_ADDRESS as Hex,
    });
  }

  private async recordDecision(
    context: SessionKeyPolicyContext,
    result: 'allowed' | 'denied',
    reason: string,
    metadata?: Record<string, unknown>,
  ) {
    if (!this.securityEvents) return;

    return this.securityEvents.record({
      actorType: 'api_key',
      eventType:
        SESSION_KEY_EVENT_TYPES[reason] ??
        (result === 'allowed' ? 'session_key.allowed' : 'session_key.denied'),
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      walletId: context.walletId,
      riskLevel: result === 'allowed' ? 'low' : 'high',
      result,
      reason,
      metadata: {
        operation: context.operation,
        chainId: context.chainId,
        walletId: context.walletId,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      },
    });
  }
}
