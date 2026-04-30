import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { OpenfortUserGuard } from '../../common/guards/openfort-user.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PolicyService } from './policy.service';
import { CreatePolicyDto, UpdatePolicyDto, CreatePolicyRuleDto } from './dto/policy.dto';

@Controller('v1/policies')
@UseGuards(OpenfortUserGuard)
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  /** GET /v1/policies — list all policies */
  @Get()
  async list(@CurrentUser('id') userId: string) {
    return this.policyService.listPolicies(userId);
  }

  /** POST /v1/policies — create a policy */
  @Post()
  async create(@CurrentUser('id') userId: string, @Body() dto: CreatePolicyDto) {
    return this.policyService.createPolicy(userId, dto);
  }

  /** GET /v1/policies/:id — get a policy */
  @Get(':id')
  async get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.policyService.getPolicy(userId, id);
  }

  /** PATCH /v1/policies/:id — update a policy */
  @Patch(':id')
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePolicyDto,
  ) {
    return this.policyService.updatePolicy(userId, id, dto);
  }

  /** DELETE /v1/policies/:id — delete a policy */
  @Delete(':id')
  async delete(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.policyService.deletePolicy(userId, id);
  }

  /** POST /v1/policies/:id/enable — enable a policy */
  @Post(':id/enable')
  async enable(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.policyService.enablePolicy(userId, id);
  }

  /** POST /v1/policies/:id/disable — disable a policy */
  @Post(':id/disable')
  async disable(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.policyService.disablePolicy(userId, id);
  }

  /** GET /v1/policies/:id/rules — list policy rules */
  @Get(':id/rules')
  async listRules(@CurrentUser('id') userId: string, @Param('id') policyId: string) {
    return this.policyService.listPolicyRules(userId, policyId);
  }

  /** POST /v1/policies/:id/rules — create a policy rule */
  @Post(':id/rules')
  async createRule(
    @CurrentUser('id') userId: string,
    @Param('id') policyId: string,
    @Body() dto: CreatePolicyRuleDto,
  ) {
    return this.policyService.createPolicyRule(userId, policyId, dto);
  }

  /** DELETE /v1/policies/:id/rules/:ruleIndex — delete a policy rule by index */
  @Delete(':id/rules/:ruleIndex')
  async deleteRule(
    @CurrentUser('id') userId: string,
    @Param('id') policyId: string,
    @Param('ruleIndex') ruleIndex: string,
  ) {
    return this.policyService.deletePolicyRule(userId, policyId, parseInt(ruleIndex, 10));
  }
}
