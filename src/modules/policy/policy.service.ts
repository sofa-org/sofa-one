import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { CreatePolicyDto, UpdatePolicyDto, CreatePolicyRuleDto } from './dto/policy.dto';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly openfortService: OpenfortService,
    private readonly prisma: PrismaService,
  ) {}

  async listPolicies(userId: string) {
    try {
      const userPolicies = await this.prisma.userPolicy.findMany({
        where: { userId },
        select: { openfortPolicyId: true },
      });
      const policyIds = userPolicies.map((p) => p.openfortPolicyId);
      if (policyIds.length === 0) return { data: [] };
      const all = await this.openfortService.listPolicies();
      const data = (all.data ?? []).filter((p: any) => policyIds.includes(p.id));
      return { data };
    } catch (error: any) {
      this.logger.error('listPolicies failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async createPolicy(userId: string, dto: CreatePolicyDto) {
    if (dto.scope !== 'account') {
      throw new ForbiddenException('Only account-scoped policies are allowed');
    }

    if (!dto.rules || dto.rules.length === 0) {
      throw new BadRequestException('At least one rule is required');
    }

    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    try {
      const policy = await this.openfortService.createPolicy({
        scope: dto.scope,
        accountId: wallet.openfortAccountId,
        description: dto.description,
        enabled: dto.enabled,
        rules: dto.rules,
      });
      await this.prisma.userPolicy.create({
        data: { userId, openfortPolicyId: policy.id },
      });
      return policy;
    } catch (error: any) {
      this.logger.error('createPolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async getPolicy(userId: string, id: string) {
    await this.assertPolicyOwner(userId, id);
    try {
      return await this.openfortService.getPolicy(id);
    } catch (error: any) {
      this.logger.error('getPolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async updatePolicy(userId: string, id: string, dto: UpdatePolicyDto) {
    await this.assertPolicyOwner(userId, id);
    try {
      return await this.openfortService.updatePolicy(id, {
        description: dto.description,
        enabled: dto.enabled,
        rules: dto.rules,
      });
    } catch (error: any) {
      this.logger.error('updatePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async deletePolicy(userId: string, id: string) {
    await this.assertPolicyOwner(userId, id);
    try {
      const result = await this.openfortService.deletePolicy(id);
      await this.prisma.userPolicy.deleteMany({
        where: { userId, openfortPolicyId: id },
      });
      return result;
    } catch (error: any) {
      this.logger.error('deletePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async enablePolicy(userId: string, id: string) {
    await this.assertPolicyOwner(userId, id);
    try {
      return await this.openfortService.enablePolicy(id);
    } catch (error: any) {
      this.logger.error('enablePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async disablePolicy(userId: string, id: string) {
    await this.assertPolicyOwner(userId, id);
    try {
      return await this.openfortService.disablePolicy(id);
    } catch (error: any) {
      this.logger.error('disablePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async listPolicyRules(userId: string, policyId: string) {
    await this.assertPolicyOwner(userId, policyId);
    try {
      return await this.openfortService.listPolicyRules(policyId);
    } catch (error: any) {
      this.logger.error('listPolicyRules failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async createPolicyRule(userId: string, policyId: string, dto: CreatePolicyRuleDto) {
    await this.assertPolicyOwner(userId, policyId);
    try {
      return await this.openfortService.createPolicyRule(policyId, {
        action: dto.action,
        operation: dto.operation,
        criteria: dto.criteria,
      });
    } catch (error: any) {
      this.logger.error('createPolicyRule failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async deletePolicyRule(userId: string, policyId: string, ruleIndex: number) {
    if (isNaN(ruleIndex) || ruleIndex < 0) {
      throw new BadRequestException('ruleIndex must be a non-negative integer');
    }
    await this.assertPolicyOwner(userId, policyId);
    try {
      return await this.openfortService.deletePolicyRule(policyId, ruleIndex);
    } catch (error: any) {
      this.logger.error('deletePolicyRule failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  private async assertPolicyOwner(userId: string, openfortPolicyId: string) {
    const policy = await this.prisma.userPolicy.findUnique({
      where: {
        userId_openfortPolicyId: { userId, openfortPolicyId },
      },
    });

    if (!policy) {
      throw new NotFoundException('Policy not found');
    }
  }
}
