import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

  async listPolicies() {
    try {
      return await this.openfortService.listPolicies();
    } catch (error: any) {
      this.logger.error('listPolicies failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async createPolicy(userId: string, dto: CreatePolicyDto) {
    if (!dto.rules || dto.rules.length === 0) {
      throw new BadRequestException('At least one rule is required');
    }
    let accountId: string | undefined;
    if (dto.scope === 'account') {
      const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }
      accountId = wallet.openfortAccountId;
    }
    try {
      return await this.openfortService.createPolicy({
        scope: dto.scope,
        accountId,
        description: dto.description,
        enabled: dto.enabled,
        rules: dto.rules,
      });
    } catch (error: any) {
      this.logger.error('createPolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async getPolicy(id: string) {
    try {
      return await this.openfortService.getPolicy(id);
    } catch (error: any) {
      this.logger.error('getPolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async updatePolicy(id: string, dto: UpdatePolicyDto) {
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

  async deletePolicy(id: string) {
    try {
      return await this.openfortService.deletePolicy(id);
    } catch (error: any) {
      this.logger.error('deletePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async enablePolicy(id: string) {
    try {
      return await this.openfortService.enablePolicy(id);
    } catch (error: any) {
      this.logger.error('enablePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async disablePolicy(id: string) {
    try {
      return await this.openfortService.disablePolicy(id);
    } catch (error: any) {
      this.logger.error('disablePolicy failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async listPolicyRules(policyId: string) {
    try {
      return await this.openfortService.listPolicyRules(policyId);
    } catch (error: any) {
      this.logger.error('listPolicyRules failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async createPolicyRule(policyId: string, dto: CreatePolicyRuleDto) {
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

  async deletePolicyRule(policyId: string, ruleIndex: number) {
    if (isNaN(ruleIndex) || ruleIndex < 0) {
      throw new BadRequestException('ruleIndex must be a non-negative integer');
    }
    try {
      return await this.openfortService.deletePolicyRule(policyId, ruleIndex);
    } catch (error: any) {
      this.logger.error('deletePolicyRule failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }
}
