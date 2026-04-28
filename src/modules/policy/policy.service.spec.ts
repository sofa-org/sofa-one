import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { PolicyService } from './policy.service';
import type { OpenfortService } from '../../core/openfort/openfort.service';
import type { PrismaService } from '../../core/database/prisma.service';

const POLICY_ID = 'pol-1';
const USER_ID = 'user-1';

describe('PolicyService', () => {
  const openfort = {
    getPolicy: jest.fn(),
    updatePolicy: jest.fn(),
    deletePolicy: jest.fn(),
    enablePolicy: jest.fn(),
    disablePolicy: jest.fn(),
    listPolicyRules: jest.fn(),
    createPolicyRule: jest.fn(),
    deletePolicyRule: jest.fn(),
    createPolicy: jest.fn(),
  } as unknown as jest.Mocked<OpenfortService>;

  const prisma = {
    userPolicy: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    userWallet: { findUnique: jest.fn() },
  } as any as PrismaService;

  let service: PolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PolicyService(openfort, prisma);
    (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue({
      id: 'link-1',
      userId: USER_ID,
      openfortPolicyId: POLICY_ID,
    });
    (prisma.userWallet.findUnique as jest.Mock).mockResolvedValue({
      openfortAccountId: 'acc-1',
      status: 'active',
    });
    openfort.getPolicy.mockResolvedValue({ id: POLICY_ID } as any);
    openfort.updatePolicy.mockResolvedValue({ id: POLICY_ID } as any);
    openfort.createPolicy.mockResolvedValue({ id: POLICY_ID } as any);
    openfort.deletePolicy.mockResolvedValue({ id: POLICY_ID } as any);
    openfort.enablePolicy.mockResolvedValue({ id: POLICY_ID } as any);
    openfort.disablePolicy.mockResolvedValue({ id: POLICY_ID } as any);
    openfort.listPolicyRules.mockResolvedValue([]);
    openfort.createPolicyRule.mockResolvedValue({ id: 'rule-1' } as any);
    openfort.deletePolicyRule.mockResolvedValue({} as any);
  });

  // ─── listPolicies ────────────────────────────────────────────────────────────

  describe('listPolicies', () => {
    it('returns empty list when user has no policies', async () => {
      (prisma.userPolicy.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.listPolicies(USER_ID);

      expect(result).toEqual({ data: [] });
      expect(openfort.getPolicy).not.toHaveBeenCalled();
    });

    it('fetches each owned policy individually', async () => {
      (prisma.userPolicy.findMany as jest.Mock).mockResolvedValue([
        { openfortPolicyId: 'pol-1' },
        { openfortPolicyId: 'pol-2' },
      ]);
      openfort.getPolicy
        .mockResolvedValueOnce({ id: 'pol-1' } as any)
        .mockResolvedValueOnce({ id: 'pol-2' } as any);

      const result = await service.listPolicies(USER_ID);

      expect(openfort.getPolicy).toHaveBeenCalledTimes(2);
      expect(result.data).toHaveLength(2);
    });

    it('wraps Openfort errors in BadGatewayException', async () => {
      (prisma.userPolicy.findMany as jest.Mock).mockResolvedValue([
        { openfortPolicyId: 'pol-1' },
      ]);
      openfort.getPolicy.mockRejectedValue(new Error('Openfort down'));

      await expect(service.listPolicies(USER_ID)).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  // ─── createPolicy ────────────────────────────────────────────────────────────

  describe('createPolicy', () => {
    const validDto = {
      scope: 'account' as const,
      rules: [{ action: 'accept' as const, operation: 'signEvmMessage' as any }],
    };

    it('creates policy and stores ownership link', async () => {
      (prisma.userPolicy.create as jest.Mock).mockResolvedValue({ id: 'link-1' });

      const result = await service.createPolicy(USER_ID, validDto);

      expect(openfort.createPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acc-1', scope: 'account' }),
      );
      expect(prisma.userPolicy.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, openfortPolicyId: POLICY_ID },
      });
      expect(result).toEqual({ id: POLICY_ID });
    });

    it('rejects non-account scoped policies', async () => {
      await expect(
        service.createPolicy(USER_ID, { scope: 'project' as any, rules: [validDto.rules[0]] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when no rules are provided', async () => {
      await expect(
        service.createPolicy(USER_ID, { scope: 'account', rules: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when wallet not found', async () => {
      (prisma.userWallet.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.createPolicy(USER_ID, validDto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects when wallet is not active', async () => {
      (prisma.userWallet.findUnique as jest.Mock).mockResolvedValue({
        openfortAccountId: 'acc-1',
        status: 'provisioning',
      });

      await expect(service.createPolicy(USER_ID, validDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('wraps Openfort errors in BadGatewayException', async () => {
      openfort.createPolicy.mockRejectedValue(new Error('Openfort down'));

      await expect(service.createPolicy(USER_ID, validDto)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  // ─── assertPolicyOwner (getPolicy / updatePolicy / deletePolicy etc.) ────────

  describe('ownership enforcement', () => {
    it('allows reading a policy the user owns', async () => {
      await service.getPolicy(USER_ID, POLICY_ID);

      expect(prisma.userPolicy.findUnique).toHaveBeenCalledWith({
        where: { userId_openfortPolicyId: { userId: USER_ID, openfortPolicyId: POLICY_ID } },
      });
      expect(openfort.getPolicy).toHaveBeenCalledWith(POLICY_ID);
    });

    it('throws NotFoundException for cross-user policy access', async () => {
      (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getPolicy(USER_ID, 'other-pol')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(openfort.getPolicy).not.toHaveBeenCalled();
    });

    it('enforces ownership before update', async () => {
      (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.updatePolicy(USER_ID, POLICY_ID, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(openfort.updatePolicy).not.toHaveBeenCalled();
    });

    it('enforces ownership before delete', async () => {
      (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deletePolicy(USER_ID, POLICY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(openfort.deletePolicy).not.toHaveBeenCalled();
    });

    it('enforces ownership before enable', async () => {
      (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.enablePolicy(USER_ID, POLICY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(openfort.enablePolicy).not.toHaveBeenCalled();
    });

    it('enforces ownership before disable', async () => {
      (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.disablePolicy(USER_ID, POLICY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(openfort.disablePolicy).not.toHaveBeenCalled();
    });
  });

  // ─── deletePolicy ────────────────────────────────────────────────────────────

  describe('deletePolicy', () => {
    it('deletes the Openfort policy and the ownership link', async () => {
      (prisma.userPolicy.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.deletePolicy(USER_ID, POLICY_ID);

      expect(openfort.deletePolicy).toHaveBeenCalledWith(POLICY_ID);
      expect(prisma.userPolicy.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, openfortPolicyId: POLICY_ID },
      });
    });

    it('wraps Openfort errors in BadGatewayException', async () => {
      openfort.deletePolicy.mockRejectedValue(new Error('Openfort down'));

      await expect(service.deletePolicy(USER_ID, POLICY_ID)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  // ─── enablePolicy / disablePolicy ────────────────────────────────────────────

  describe('enablePolicy', () => {
    it('delegates to openfort and returns result', async () => {
      const result = await service.enablePolicy(USER_ID, POLICY_ID);

      expect(openfort.enablePolicy).toHaveBeenCalledWith(POLICY_ID);
      expect(result).toEqual({ id: POLICY_ID });
    });
  });

  describe('disablePolicy', () => {
    it('delegates to openfort and returns result', async () => {
      const result = await service.disablePolicy(USER_ID, POLICY_ID);

      expect(openfort.disablePolicy).toHaveBeenCalledWith(POLICY_ID);
      expect(result).toEqual({ id: POLICY_ID });
    });
  });

  // ─── listPolicyRules ─────────────────────────────────────────────────────────

  describe('listPolicyRules', () => {
    it('enforces ownership then delegates to openfort', async () => {
      await service.listPolicyRules(USER_ID, POLICY_ID);

      expect(prisma.userPolicy.findUnique).toHaveBeenCalled();
      expect(openfort.listPolicyRules).toHaveBeenCalledWith(POLICY_ID);
    });
  });

  // ─── createPolicyRule ────────────────────────────────────────────────────────

  describe('createPolicyRule', () => {
    const ruleDto = { action: 'accept' as const, operation: 'signEvmMessage' as any };

    it('creates rule after ownership check', async () => {
      await service.createPolicyRule(USER_ID, POLICY_ID, ruleDto);

      expect(openfort.createPolicyRule).toHaveBeenCalledWith(
        POLICY_ID,
        expect.objectContaining({ action: 'accept' }),
      );
    });
  });

  // ─── deletePolicyRule ────────────────────────────────────────────────────────

  describe('deletePolicyRule', () => {
    it('deletes rule at valid index after ownership check', async () => {
      await service.deletePolicyRule(USER_ID, POLICY_ID, 0);

      expect(openfort.deletePolicyRule).toHaveBeenCalledWith(POLICY_ID, 0);
    });

    it('rejects negative ruleIndex', async () => {
      await expect(service.deletePolicyRule(USER_ID, POLICY_ID, -1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(openfort.deletePolicyRule).not.toHaveBeenCalled();
    });

    it('rejects NaN ruleIndex', async () => {
      await expect(service.deletePolicyRule(USER_ID, POLICY_ID, NaN)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
