import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { assertAllowedApiKeyChain, getSupportedChain } from '../../common/chains/supported-chains';
import { hashRequest } from '../../common/utils/request-hash';
import type { SendTransactionDto } from './dto/send-transaction.dto';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
  ) {}

  /** Send a raw transaction from the user's backend wallet. */
  async send(userId: string, dto: SendTransactionDto, apiKeyRecord?: { allowedChains: number[] }) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (wallet.status !== 'active') {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    const chainId = dto.chainId;
    getSupportedChain(chainId);
    assertAllowedApiKeyChain(apiKeyRecord, chainId);

    if (dto.policyId) {
      const policy = await this.prisma.userPolicy.findUnique({
        where: {
          userId_openfortPolicyId: {
            userId,
            openfortPolicyId: dto.policyId,
          },
        },
      });
      if (!policy) throw new NotFoundException('Policy not found');
    }

    const requestHash = hashRequest({
      operationType: 'send',
      chainId,
      interactions: dto.interactions,
      policyId: dto.policyId ?? null,
    });

    const tx = await this.createPendingOrReturnExisting(userId, {
      operationType: 'send',
      idempotencyKey: dto.idempotencyKey!,
      chainId,
      requestHash,
      walletAddress: wallet.walletAddress,
      details: {
        type: 'send',
        interactions: dto.interactions as unknown as Record<string, unknown>[],
        ...(dto.policyId ? { policyId: dto.policyId } : {}),
        idempotencyKey: dto.idempotencyKey,
        requestHash,
      },
    });

    if (tx.intentId || tx.txHash || tx.status !== 'submitting') {
      return {
        transactionId: tx.id,
        transactionHash: tx.txHash ?? tx.intentId,
        status: tx.status,
      };
    }

    try {
      const { transactionHash } = await this.openfort.sendTransaction({
        accountId: wallet.openfortAccountId,
        chainId,
        interactions: dto.interactions,
        policyId: dto.policyId,
      });

      const updated = await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          intentId: transactionHash ?? null,
          txHash: transactionHash ?? null,
          status: transactionHash ? 'confirmed' : 'pending',
        },
      });

      return {
        transactionId: updated.id,
        transactionHash,
        status: updated.status,
      };
    } catch (error) {
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { status: 'unknown' },
      });
      throw error;
    }
  }

  private async createPendingOrReturnExisting(
    userId: string,
    params: {
      operationType: string;
      idempotencyKey: string;
      chainId: number;
      requestHash: string;
      walletAddress: string;
      details: Record<string, unknown>;
    },
  ) {
    try {
      return await this.prisma.transaction.create({
        data: {
          userId,
          intentId: null,
          status: 'submitting',
          chainId: BigInt(params.chainId),
          walletAddress: params.walletAddress,
          operationType: params.operationType,
          idempotencyKey: params.idempotencyKey,
          requestHash: params.requestHash,
          details: params.details as any,
        },
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;

      const existing = await this.prisma.transaction.findFirst({
        where: {
          userId,
          operationType: params.operationType,
          chainId: BigInt(params.chainId),
          idempotencyKey: params.idempotencyKey,
        },
      });
      if (!existing) throw error;
      if (existing.requestHash && existing.requestHash !== params.requestHash) {
        throw new BadRequestException('Idempotency key was already used for a different request');
      }
      return existing;
    }
  }
}
