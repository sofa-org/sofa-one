import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  MAX_INTERACTION_CALLDATA_BYTES,
  MAX_TRANSACTION_INTERACTIONS,
  type ExecutionMode,
  type SendTransactionDto,
} from './dto/send-transaction.dto';

const MAX_TRANSACTION_CALLDATA_BYTES = 64 * 1024;
const MAX_DISTINCT_TARGETS = 5;
const ZERO_NATIVE_VALUE = 0n;
const MAX_UINT256 = (1n << 256n) - 1n;

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const ERC721_ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR = '0xa22cb465';
const BLOCKED_PERMIT_SELECTORS = new Set([
  '0xd505accf', // ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  '0x8fcbaf0c', // DAI-style permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)
  '0x2b67b570', // Permit2 permit(address,PermitSingle,bytes)
  '0xb7f13ed4', // Permit2 compact/single permit variant
  '0x002a3e3a', // Permit2 permitBatch(address,PermitBatch,bytes)
]);

type TransactionPolicyContext = {
  userId: string;
  chainId: number;
  executionMode: ExecutionMode;
  apiKeyPrefix?: string;
};

@Injectable()
export class TransactionPolicyService {
  private readonly logger = new Logger(TransactionPolicyService.name);

  assertAllowed(dto: SendTransactionDto, context: TransactionPolicyContext): void {
    if (dto.interactions.length > MAX_TRANSACTION_INTERACTIONS) {
      this.reject(
        `Transaction contains too many interactions; maximum is ${MAX_TRANSACTION_INTERACTIONS}`,
        context,
        { interactionCount: dto.interactions.length },
      );
    }

    const totalCalldataBytes = dto.interactions.reduce(
      (total, interaction) => total + this.getCalldataByteLength(interaction.data),
      0,
    );
    if (totalCalldataBytes > MAX_TRANSACTION_CALLDATA_BYTES) {
      this.reject('Transaction calldata exceeds maximum total size of 64 KB', context, {
        interactionCount: dto.interactions.length,
        totalCalldataBytes,
      });
    }

    const distinctTargets = new Set(dto.interactions.map((interaction) => interaction.to.toLowerCase()));
    if (distinctTargets.size > MAX_DISTINCT_TARGETS) {
      this.reject('Transaction targets too many distinct contracts', context, {
        interactionCount: dto.interactions.length,
        distinctTargetCount: distinctTargets.size,
      });
    }

    dto.interactions.forEach((interaction, index) => {
      const calldataBytes = this.getCalldataByteLength(interaction.data);
      if (calldataBytes > MAX_INTERACTION_CALLDATA_BYTES) {
        this.reject(`Interaction ${index + 1} calldata exceeds maximum size of 64 KB`, context, {
          interactionIndex: index,
          calldataBytes,
        });
      }

      const value = BigInt(interaction.value ?? '0');
      if (value !== ZERO_NATIVE_VALUE) {
        this.reject('Native value transfers are not allowed for API key transactions', context, {
          interactionIndex: index,
          hasNativeValue: true,
        });
      }

      if (interaction.data.length > 2 && interaction.data.length < 10) {
        this.reject(`Interaction ${index + 1} calldata is too short`, context, {
          interactionIndex: index,
          calldataLength: interaction.data.length,
        });
      }

      const selector = this.getFunctionSelector(interaction.data);
      if (!selector) return;

      if (BLOCKED_PERMIT_SELECTORS.has(selector)) {
        this.reject('Permit signatures are not allowed in transaction calldata', context, {
          interactionIndex: index,
          selector,
        });
      }

      if (selector === ERC20_APPROVE_SELECTOR && this.isMaxUint256Approval(interaction.data)) {
        this.reject('Infinite token approvals are not allowed', context, {
          interactionIndex: index,
          selector,
        });
      }

      if (
        selector === ERC721_ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR &&
        this.isApprovalForAllEnabled(interaction.data)
      ) {
        this.reject('NFT operator approvals are not allowed', context, {
          interactionIndex: index,
          selector,
        });
      }
    });
  }

  private reject(
    reason: string,
    context: TransactionPolicyContext,
    extra: Record<string, unknown> = {},
  ): never {
    this.logger.warn({
      event: 'security',
      message: 'Transaction policy rejected request',
      reason,
      ...context,
      ...extra,
    });
    throw new BadRequestException(reason);
  }

  private getFunctionSelector(data: string): string | null {
    if (data === '0x') return null;
    if (data.length < 10) return null;
    return data.slice(0, 10).toLowerCase();
  }

  private getCalldataByteLength(data: string): number {
    if (data === '0x') return 0;
    return Math.ceil((data.length - 2) / 2);
  }

  private isMaxUint256Approval(data: string): boolean {
    const amountWord = this.getAbiWord(data, 1);
    if (!amountWord) return false;
    return BigInt(`0x${amountWord}`) === MAX_UINT256;
  }

  private isApprovalForAllEnabled(data: string): boolean {
    const approvedWord = this.getAbiWord(data, 1);
    if (!approvedWord) return false;
    return BigInt(`0x${approvedWord}`) !== 0n;
  }

  private getAbiWord(data: string, wordIndex: number): string | null {
    const start = 10 + wordIndex * 64;
    const end = start + 64;
    if (data.length < end) return null;
    return data.slice(start, end);
  }
}
