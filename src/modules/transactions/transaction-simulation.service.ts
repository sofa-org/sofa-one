import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createPublicClient, getAddress, http, type Hex, type PublicClient } from 'viem';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { getErrorText, sanitizeErrorMessage } from '../../common/utils/sanitize';
import { SecurityEventService } from '../security-events/security-event.service';
import type { ExecutionMode, SendTransactionDto } from './dto/send-transaction.dto';

type TransactionSimulationContext = {
  userId: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  chainId: number;
  executionMode: ExecutionMode;
  from: string;
};

@Injectable()
export class TransactionSimulationService {
  private readonly logger = new Logger(TransactionSimulationService.name);
  private readonly publicClients = new Map<number, PublicClient>();

  constructor(private readonly securityEvents?: SecurityEventService) {}

  async assertSimulatable(
    dto: SendTransactionDto,
    context: TransactionSimulationContext,
  ): Promise<void> {
    const client = this.getPublicClient(context.chainId);
    const account = getAddress(context.from);

    for (const [index, interaction] of dto.interactions.entries()) {
      try {
        await client.call({
          account,
          to: getAddress(interaction.to),
          data: interaction.data as Hex,
          value: BigInt(interaction.value ?? '0'),
        });
      } catch (error) {
        await this.rejectSimulation(error, context, index);
      }
    }

    await this.securityEvents?.record({
      actorType: 'api_key',
      eventType: 'transaction.simulation_allowed',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: 'low',
      result: 'allowed',
      reason: 'simulation_passed',
      metadata: {
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        interactionCount: dto.interactions.length,
      },
    });
  }

  private getPublicClient(chainId: number): PublicClient {
    const existing = this.publicClients.get(chainId);
    if (existing) return existing;
    const { chain } = getSupportedChain(chainId);
    const client = createPublicClient({ chain, transport: http() });
    this.publicClients.set(chainId, client);
    return client;
  }

  private async rejectSimulation(
    error: unknown,
    context: TransactionSimulationContext,
    interactionIndex: number,
  ): Promise<never> {
    const reason = sanitizeErrorMessage(getErrorText(error), 240);
    this.logger.warn({
      event: 'security',
      message: 'Transaction simulation rejected request',
      reason: reason || 'simulation_failed',
      userId: context.userId,
      apiKeyId: context.apiKeyId,
      apiKeyPrefix: context.apiKeyPrefix,
      chainId: context.chainId,
      executionMode: context.executionMode,
      interactionIndex,
    });

    await this.securityEvents?.record({
      actorType: 'api_key',
      eventType: 'transaction.simulation_denied',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: 'high',
      result: 'denied',
      reason: reason || 'simulation_failed',
      metadata: {
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        interactionIndex,
      },
    });

    throw new BadRequestException('Transaction simulation failed. Check target contract calldata and permissions.');
  }
}
