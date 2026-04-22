import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { CreatePolicyDto, UpdatePolicyDto, CreatePolicyRuleDto } from './dto/policy.dto';

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(private readonly openfortService: OpenfortService) {}

  async listPolicies() {
    try {
      return await this.openfortService.listPolicies();
    } catch (error: any) {
      this.logger.error('listPolicies failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async createPolicy(dto: CreatePolicyDto) {
    try {
      return await this.openfortService.createPolicy(dto);
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
        name: dto.name,
        chainId: dto.chainId,
        sponsorSchema: dto.sponsorSchema,
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
        type: dto.type,
        contract: dto.contract,
        functionName: dto.functionName,
        wildcard: dto.wildcard,
        gasLimit: dto.gasLimit,
        countLimit: dto.countLimit,
        timeIntervalType: dto.timeIntervalType,
        timeIntervalValue: dto.timeIntervalValue,
      });
    } catch (error: any) {
      this.logger.error('createPolicyRule failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }

  async deletePolicyRule(policyId: string, ruleId: string) {
    try {
      return await this.openfortService.deletePolicyRule(policyId, ruleId);
    } catch (error: any) {
      this.logger.error('deletePolicyRule failed: ' + error.message);
      throw new BadGatewayException('Policy service temporarily unavailable');
    }
  }
}
