import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { isAddress } from 'viem';
import type { SignDto, SignMessage } from './dto/sign.dto';
import { SecurityEventService } from '../security-events/security-event.service';

const MAX_MESSAGE_LENGTH_BYTES = 10 * 1024; // 10 KB
const BLOCKED_TYPED_DATA_PRIMARY_TYPES = new Set([
  'permit',
  'permitbatch',
  'permitsingle',
  'permittransferfrom',
  'permitbatchtransferfrom',
]);
const MAX_DOMAIN_NAME_LENGTH = 100;
const PRIVATE_KEY_PATTERN = /0x[0-9a-fA-F]{64}/;
const MNEMONIC_WORD_PATTERN = /^(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}$/;

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
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
};

@Injectable()
export class SigningPolicyService {
  private readonly logger = new Logger(SigningPolicyService.name);

  constructor(
    @Optional() private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * Validate a message signing request against the signing policy.
   *
   * Checks:
   * - Max message length (10 KB)
   * - Dangerous patterns (private keys, mnemonics)
   *
   * Records a `signing.message_allowed` SecurityEvent on success.
   * Records a `signing.policy_denied` SecurityEvent on denial and throws.
   */
  async assertMessageSigningPolicy(
    message: SignMessage,
    context: SigningPolicyContext,
  ): Promise<SigningPolicyResult> {
    const messageLength = this.getMessageLength(message);

    if (messageLength > MAX_MESSAGE_LENGTH_BYTES) {
      await this.reject('Message exceeds maximum allowed length', context, {
        messageLength,
        maxLength: MAX_MESSAGE_LENGTH_BYTES,
      });
    }

    if (this.containsPrivateKeyPattern(message)) {
      await this.reject('Message appears to contain a private key', context, {
        messageLength,
      });
    }

    if (this.containsMnemonicPattern(message)) {
      await this.reject('Message appears to contain a mnemonic phrase', context, {
        messageLength,
      });
    }

    await this.recordAllowedEvent('signing.message_allowed', context, {
      type: 'message',
      messageLength,
    });

    return {};
  }

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

    // Contract allowlist: if the API key defines allowedContracts, the
    // verifyingContract must be in the list.
    if (context.allowedContracts && context.allowedContracts.length > 0) {
      if (typeof verifyingContract !== 'string') {
        await this.reject(
          'typedData.domain.verifyingContract is required when API key allowed contracts are configured',
          context,
          {
            typedDataPrimaryType: primaryType,
            allowedContractCount: context.allowedContracts.length,
          },
        );
      }
      const normalizedContract = (verifyingContract as string).toLowerCase();
      if (!context.allowedContracts.some((c) => c.toLowerCase() === normalizedContract)) {
        await this.reject(
          'typedData.domain.verifyingContract is not in the API key allowed contracts',
          context,
          {
            typedDataPrimaryType: primaryType,
            verifyingContract: normalizedContract,
            allowedContractCount: context.allowedContracts.length,
          },
        );
      }
    }

    const result: SigningPolicyResult = {
      typedDataPrimaryType: primaryType,
      ...(typeof verifyingContract === 'string'
        ? { typedDataVerifyingContract: verifyingContract.toLowerCase() }
        : {}),
      ...(typeof domainName === 'string' ? { typedDataDomainName: domainName } : {}),
    };

    await this.recordAllowedEvent('signing.typed_data_allowed', context, {
      type: 'typed_data',
      primaryType,
      verifyingContract:
        typeof verifyingContract === 'string' ? verifyingContract : undefined,
      domainName: typeof domainName === 'string' ? domainName : undefined,
    });

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

  // ── Message Policy Helpers ────────────────────────────────────────

  /**
   * Compute the byte length of a message.
   * For raw hex data (SignMessage with `raw`), bytes are (hex.length - 2) / 2.
   */
  private getMessageLength(message: SignMessage): number {
    if (typeof message === 'string') {
      return Buffer.byteLength(message, 'utf-8');
    }
    return (message.raw.length - 2) / 2;
  }

  /**
   * Check if the message contains a hex string that looks like a private key
   * (0x followed by exactly 64 hex characters).
   */
  private containsPrivateKeyPattern(message: SignMessage): boolean {
    if (typeof message === 'string') {
      return PRIVATE_KEY_PATTERN.test(message);
    }
    return false;
  }

  /**
   * Check if the message appears to contain a mnemonic phrase
   * (12+ consecutive lowercase words of 3-8 letters separated by spaces).
   *
   * For raw hex data, attempts UTF-8 decoding before checking.
   */
  private containsMnemonicPattern(message: SignMessage): boolean {
    if (typeof message === 'string') {
      return MNEMONIC_WORD_PATTERN.test(message.trim());
    }
    try {
      const hex = message.raw.startsWith('0x') ? message.raw.slice(2) : message.raw;
      const bytes = Buffer.from(hex, 'hex');
      const decoded = bytes.toString('utf-8');
      return MNEMONIC_WORD_PATTERN.test(decoded.trim());
    } catch {
      return false;
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
