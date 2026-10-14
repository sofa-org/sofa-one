import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { isAddress } from 'viem';
import type { SignDto } from './dto/sign.dto';
import { SecurityEventService } from '../security-events/security-event.service';

const BLOCKED_TYPED_DATA_PRIMARY_TYPES = new Set([
  'permit',
  'permitbatch',
  'permitsingle',
  'permittransferfrom',
  'permitbatchtransferfrom',
]);
const MAX_DOMAIN_NAME_LENGTH = 100;

export type SigningPolicyResult = {
  typedDataPrimaryType?: string;
  typedDataVerifyingContract?: string;
  typedDataDomainName?: string;
};

export type SigningPolicyContext = {
  userId: string;
  chainId: number;
  type: 'message' | 'typed_data';
  executionMode: 'session_key' | 'eoa';
  apiKeyId?: string;
  apiKeyPrefix?: string;
  /** Caller will persist its own allowed audit atomically at acceptance. */
  deferAllowedAudit?: boolean;
};

@Injectable()
export class SigningPolicyService {
  private readonly logger = new Logger(SigningPolicyService.name);

  constructor(
    @Optional() private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * Validate a typed data signing request against the signing policy.
   *
   * Checks:
   * - Shape validation (domain, types, primaryType, message)
   * - Blocked permit primary types
   * - Valid verifyingContract if present
   * - domain.chainId matches request chainId
   * - domain.name length limit (100 chars)
   *
   * Records a `signing.typed_data_allowed` SecurityEvent on success.
   * Records a `signing.policy_denied` SecurityEvent on denial and throws.
   */
  async assertTypedDataSigningPolicy(
    typedData: NonNullable<SignDto['typedData']>,
    context: SigningPolicyContext,
  ): Promise<SigningPolicyResult> {
    await this.assertTypedDataShape(typedData, context);

    const primaryType = typedData.primaryType.trim();
    if (this.isBlockedTypedDataPrimaryType(primaryType)) {
      await this.reject('Permit typed data signing is not allowed', context, {
        typedDataPrimaryType: primaryType,
      });
    }

    const verifyingContract = typedData.domain.verifyingContract;
    if (verifyingContract !== undefined) {
      if (typeof verifyingContract !== 'string' || !isAddress(verifyingContract)) {
        await this.reject(
          'typedData.domain.verifyingContract must be a valid address',
          context,
          {
            typedDataPrimaryType: primaryType,
            hasVerifyingContract: true,
          },
        );
      }
    }

    // Defense-in-depth: domain.chainId must be present and match request chainId
    // (Already enforced in resolveSigningChainId(), but checked here as well)
    const domainChainId = typedData.domain.chainId;
    if (typeof domainChainId !== 'number') {
      await this.reject(
        'typedData.domain.chainId is required and must be a number',
        context,
        { typedDataPrimaryType: primaryType },
      );
    }
    if (domainChainId !== context.chainId) {
      await this.reject(
        'typedData.domain.chainId must match the request chainId',
        context,
        {
          typedDataPrimaryType: primaryType,
          domainChainId,
          requestChainId: context.chainId,
        },
      );
    }

    // domain.name length limit
    const domainName = typedData.domain.name;
    if (typeof domainName === 'string' && domainName.length > MAX_DOMAIN_NAME_LENGTH) {
      await this.reject(
        'typedData.domain.name must not exceed 100 characters',
        context,
        {
          typedDataPrimaryType: primaryType,
          domainNameLength: domainName.length,
        },
      );
    }

    const result: SigningPolicyResult = {
      typedDataPrimaryType: primaryType,
      ...(typeof verifyingContract === 'string'
        ? { typedDataVerifyingContract: verifyingContract.toLowerCase() }
        : {}),
      ...(typeof domainName === 'string' ? { typedDataDomainName: domainName } : {}),
    };

    if (!context.deferAllowedAudit) {
      await this.recordAllowedEvent('signing.typed_data_allowed', context, {
        type: 'typed_data',
        primaryType,
        verifyingContract:
          typeof verifyingContract === 'string' ? verifyingContract : undefined,
        domainName: typeof domainName === 'string' ? domainName : undefined,
      });
    }

    return result;
  }

  // ── Private: Rejection with SecurityEvent recording ───────────────

  /**
   * Record a `signing.policy_denied` SecurityEvent and throw a BadRequestException.
   * If SecurityEvent recording fails, the error is logged but the throw still occurs.
   */
  private async reject(
    reason: string,
    context: SigningPolicyContext,
    extra: Record<string, unknown> = {},
  ): Promise<never> {
    await this.recordDeniedEvent(reason, context, extra);
    throw new BadRequestException(reason);
  }

  // ── Security Event Recording ──────────────────────────────────────

  private async recordDeniedEvent(
    reason: string,
    context: SigningPolicyContext,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.securityEvents) {
      this.logger.warn({
        event: 'security',
        message: `Signing policy denied: ${reason}`,
        userId: context.userId,
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix,
        ...extra,
      });
      return;
    }

    try {
      await this.securityEvents.record({
        actorType: 'api_key',
        eventType: 'signing.policy_denied',
        userId: context.userId,
        apiKeyId: context.apiKeyId ?? null,
        result: 'denied',
        reason,
        metadata: {
          chainId: context.chainId,
          executionMode: context.executionMode,
          apiKeyPrefix: context.apiKeyPrefix ?? null,
          ...extra,
        },
      });
    } catch (error) {
      this.logger.error(
        'Failed to record signing policy denial event',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async recordAllowedEvent(
    eventType: string,
    context: SigningPolicyContext,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.securityEvents) return;

    try {
      await this.securityEvents.record({
        actorType: 'api_key',
        eventType,
        userId: context.userId,
        apiKeyId: context.apiKeyId ?? null,
        result: 'allowed',
        metadata: {
          chainId: context.chainId,
          executionMode: context.executionMode,
          apiKeyPrefix: context.apiKeyPrefix ?? null,
          ...extra,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record signing allowed event: ${eventType}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  // ── Typed Data Policy Helpers ─────────────────────────────────────

  /**
   * Check if a primary type is one of the blocked Permit types (case-insensitive).
   */
  private isBlockedTypedDataPrimaryType(primaryType: string): boolean {
    return BLOCKED_TYPED_DATA_PRIMARY_TYPES.has(primaryType.toLowerCase());
  }

  /**
   * Validate the structural shape of a typed data object.
   * All four fields (domain, types, primaryType, message) must be present
   * and of the correct types.
   */
  private async assertTypedDataShape(
    typedData: NonNullable<SignDto['typedData']>,
    context: SigningPolicyContext,
  ): Promise<void> {
    if (
      !typedData.domain ||
      typeof typedData.domain !== 'object' ||
      Array.isArray(typedData.domain)
    ) {
      await this.reject('typedData.domain is required', context);
    }

    if (
      !typedData.types ||
      typeof typedData.types !== 'object' ||
      Array.isArray(typedData.types)
    ) {
      await this.reject('typedData.types is required', context);
    }

    if (
      typeof typedData.primaryType !== 'string' ||
      typedData.primaryType.trim().length === 0
    ) {
      await this.reject('typedData.primaryType is required', context);
    }

    if (
      !typedData.message ||
      typeof typedData.message !== 'object' ||
      Array.isArray(typedData.message)
    ) {
      await this.reject('typedData.message is required', context, {
        typedDataPrimaryType:
          typeof typedData.primaryType === 'string'
            ? typedData.primaryType.trim()
            : undefined,
      });
    }
  }
}
