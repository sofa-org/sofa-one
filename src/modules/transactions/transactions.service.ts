import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import type { SendTransactionDto } from './dto/send-transaction.dto';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
  ) {}

  /** Send a raw transaction from the user's backend wallet. */
  async send(userId: string, dto: SendTransactionDto) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (wallet.status !== 'active') {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    const chainId = Number(wallet.chainId);

    // Idempotency guard
    if (dto.idempotencyKey) {
      const duplicate = await this.prisma.transaction.findFirst({
        where: {
          userId,
          status: 'pending',
          details: { path: ['idempotencyKey'], equals: dto.idempotencyKey },
        },
      });
      if (duplicate) {
        throw new ConflictException(
          `A pending transaction with idempotencyKey "${dto.idempotencyKey}" already exists (transactionId: ${duplicate.id})`,
        );
      }
    }

    const { transactionHash } = await this.openfort.sendTransaction({
      accountId: wallet.openfortAccountId,
      chainId,
      interactions: dto.interactions,
      policyId: dto.policyId,
    });

    const tx = await this.prisma.transaction.create({
      data: {
        userId,
        intentId: transactionHash ?? '',
        status: transactionHash ? 'confirmed' : 'pending',
        chainId: BigInt(chainId),
        walletAddress: wallet.walletAddress,
        details: {
          type: 'send',
          interactions: dto.interactions as unknown as Record<string, unknown>[],
          ...(dto.policyId ? { policyId: dto.policyId } : {}),
          ...(dto.idempotencyKey ? { idempotencyKey: dto.idempotencyKey } : {}),
        } as any,
      },
    });

    return {
      transactionId: tx.id,
      transactionHash,
      status: tx.status,
    };
  }
}
