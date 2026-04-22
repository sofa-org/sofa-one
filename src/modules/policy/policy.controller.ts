import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { EitherAuthGuard } from '../../common/guards/either-auth.guard';
import { PolicyService } from './policy.service';
import { CreatePolicyDto, UpdatePolicyDto, CreatePolicyRuleDto } from './dto/policy.dto';

@Controller('v1/policies')
@UseGuards(EitherAuthGuard)
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  /** GET /v1/policies — list all policies */
  @Get()
  async list() {
    return this.policyService.listPolicies();
  }

  /** POST /v1/policies — create a policy */
  @Post()
  async create(@Body() dto: CreatePolicyDto) {
    return this.policyService.createPolicy(dto);
  }

  /** GET /v1/policies/:id — get a policy */
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.policyService.getPolicy(id);
  }

  /** PATCH /v1/policies/:id — update a policy */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdatePolicyDto) {
    return this.policyService.updatePolicy(id, dto);
  }

  /** DELETE /v1/policies/:id — delete a policy */
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.policyService.deletePolicy(id);
  }

  /** POST /v1/policies/:id/enable — enable a policy */
  @Post(':id/enable')
  async enable(@Param('id') id: string) {
    return this.policyService.enablePolicy(id);
  }

  /** POST /v1/policies/:id/disable — disable a policy */
  @Post(':id/disable')
  async disable(@Param('id') id: string) {
    return this.policyService.disablePolicy(id);
  }

  /** GET /v1/policies/:id/rules — list policy rules */
  @Get(':id/rules')
  async listRules(@Param('id') policyId: string) {
    return this.policyService.listPolicyRules(policyId);
  }

  /** POST /v1/policies/:id/rules — create a policy rule */
  @Post(':id/rules')
  async createRule(
    @Param('id') policyId: string,
    @Body() dto: CreatePolicyRuleDto,
  ) {
    return this.policyService.createPolicyRule(policyId, dto);
  }

  /** DELETE /v1/policies/:id/rules/:ruleId — delete a policy rule */
  @Delete(':id/rules/:ruleId')
  async deleteRule(
    @Param('id') policyId: string,
    @Param('ruleId') ruleId: string,
  ) {
    return this.policyService.deletePolicyRule(policyId, ruleId);
  }
}
