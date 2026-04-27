import { ForbiddenException, NotFoundException } from '@nestjs/common';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { PolicyService } from './policy.service';
import type { OpenfortService } from '../../core/openfort/openfort.service';
import type { PrismaService } from '../../core/database/prisma.service';

describe('PolicyService ownership', () => {
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
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    userWallet: { findUnique: jest.fn() },
  } as any as PrismaService;

  let service: PolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PolicyService(openfort, prisma);
    (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue({ id: 'link-1' });
    (prisma.userWallet.findUnique as jest.Mock).mockResolvedValue({ openfortAccountId: 'acc-1' });
    openfort.getPolicy.mockResolvedValue({ id: 'pol-1' } as any);
    openfort.updatePolicy.mockResolvedValue({ id: 'pol-1' } as any);
    openfort.createPolicy.mockResolvedValue({ id: 'pol-1' } as any);
  });

  it('requires ownership before reading a policy', async () => {
    await service.getPolicy('user-1', 'pol-1');

    expect(prisma.userPolicy.findUnique).toHaveBeenCalledWith({
      where: { userId_openfortPolicyId: { userId: 'user-1', openfortPolicyId: 'pol-1' } },
    });
    expect(openfort.getPolicy).toHaveBeenCalledWith('pol-1');
  });

  it('rejects cross-user policy access', async () => {
    (prisma.userPolicy.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(service.updatePolicy('user-1', 'pol-2', {})).rejects.toThrow(NotFoundException);
    expect(openfort.updatePolicy).not.toHaveBeenCalled();
  });

  it('only allows account-scoped policy creation', async () => {
    await expect(
      service.createPolicy('user-1', { scope: 'project' as any, rules: [{ action: 'accept', operation: 'signEvmMessage' as any }] }),
    ).rejects.toThrow(ForbiddenException);
  });
});
