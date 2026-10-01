import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('./wallet.service', () => ({
  WalletService: class WalletService {},
}));
jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));
jest.mock('../../common/guards/either-auth.guard', () => ({
  EitherAuthGuard: class EitherAuthGuard {},
}));
jest.mock('../../common/guards/api-key-auth.guard', () => ({
  ApiKeyAuthGuard: class ApiKeyAuthGuard {},
}));
jest.mock('../../common/guards/api-key-permission.guard', () => ({
  ApiKeyPermissionGuard: class ApiKeyPermissionGuard {},
}));
jest.mock('../../common/guards/frontend-only.guard', () => ({
  FrontendOnlyGuard: class FrontendOnlyGuard {},
}));
jest.mock('../../common/guards/step-up.guard', () => ({
  StepUpGuard: class StepUpGuard {},
}));

import { WalletController } from './wallet.controller';
import { ApiKeyAuthGuard } from '../../common/guards/api-key-auth.guard';
import { ApiKeyPermissionGuard } from '../../common/guards/api-key-permission.guard';
import { API_KEY_PERMISSION_KEY } from '../../common/decorators/api-key-permission.decorator';
import { FrontendOnlyGuard } from '../../common/guards/frontend-only.guard';
import { IS_FRONTEND_ONLY_KEY } from '../../common/decorators/frontend-only.decorator';
import { StepUpGuard } from '../../common/guards/step-up.guard';
import { STEP_UP_KEY } from '../../common/decorators/step-up.decorator';

describe('WalletController', () => {
  const walletService = {
    getBalances: jest.fn(),
    getDepositInfo: jest.fn(),
    sign: jest.fn(),
    withdraw: jest.fn(),
    listWithdrawalAddresses: jest.fn(),
    addWithdrawalAddress: jest.fn(),
    removeWithdrawalAddress: jest.fn(),
  };

  let controller: WalletController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WalletController(walletService as any);
  });

  describe('getBalances', () => {
    it('delegates to walletService.getBalances with numeric chainId', async () => {
      walletService.getBalances.mockResolvedValue({ eth: '1.0', usdc: '100.0' });

      const result = await controller.getBalances('user-1', { chainId: 84532 });

      expect(walletService.getBalances).toHaveBeenCalledWith('user-1', 84532, undefined);
      expect(result).toEqual({ eth: '1.0', usdc: '100.0' });
    });

    it('is frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.getBalances) ?? [];

      expect(guards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.getBalances)).toBe(true);
    });
  });

  describe('getDepositInfo', () => {
    it('delegates to walletService.getDepositInfo with numeric chainId', async () => {
      walletService.getDepositInfo.mockResolvedValue({ address: '0xabc', chainId: 84532 });

      const result = await controller.getDepositInfo('user-1', { chainId: 84532 });

      expect(walletService.getDepositInfo).toHaveBeenCalledWith('user-1', 84532, undefined);
      expect(result).toEqual({ address: '0xabc', chainId: 84532 });
    });

    it('is frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.getDepositInfo) ?? [];

      expect(guards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.getDepositInfo)).toBe(true);
    });
  });

  describe('sign', () => {
    it('delegates to walletService.sign with userId, dto, and apiKeyRecord', async () => {
      const dto = { message: '0xdeadbeef', chainId: 84532 };
      const apiKeyRecord = { id: 'key-1' };
      const req = { apiKeyRecord };
      walletService.sign.mockResolvedValue({ signature: '0xsig' });

      const result = await controller.sign('user-1', dto as any, req as any);

      expect(walletService.sign).toHaveBeenCalledWith('user-1', dto, apiKeyRecord);
      expect(result).toEqual({ signature: '0xsig' });
    });

    it('is public API-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.sign) ?? [];

      expect(guards).toContain(ApiKeyAuthGuard);
      expect(guards).toContain(ApiKeyPermissionGuard);
      expect(Reflect.getMetadata(API_KEY_PERMISSION_KEY, controller.sign)).toBe('canSign');
      expect(guards).not.toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.sign)).toBeUndefined();
    });
  });

  describe('withdraw', () => {
    it('delegates to walletService.withdraw with userId, dto, and stepUpVerified', async () => {
      const dto = { to: '0xrecipient', amount: '10.0', chainId: 84532 };
      const req = { stepUpVerified: true };
      walletService.withdraw.mockResolvedValue({ transactionHash: '0xhash' });

      const result = await controller.withdraw('user-1', dto as any, req as any);

      expect(walletService.withdraw).toHaveBeenCalledWith('user-1', dto, { stepUpVerified: true });
      expect(result).toEqual({ transactionHash: '0xhash' });
    });

    it('is frontend-only', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller.withdraw) ?? [];

      expect(guards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.withdraw)).toBe(true);
    });
  });

  describe('withdrawal addresses', () => {
    it('lists withdrawal addresses for the current user', async () => {
      walletService.listWithdrawalAddresses.mockResolvedValue({ addresses: [] });

      const result = await controller.listWithdrawalAddresses('user-1');

      expect(walletService.listWithdrawalAddresses).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ addresses: [] });
    });

    it('adds a withdrawal address for the current user', async () => {
      const dto = { address: '0x1111111111111111111111111111111111111111', label: 'Treasury' };
      walletService.addWithdrawalAddress.mockResolvedValue({ id: 'addr-1', ...dto });

      const result = await controller.addWithdrawalAddress('user-1', dto);

      expect(walletService.addWithdrawalAddress).toHaveBeenCalledWith('user-1', dto);
      expect(result).toEqual({ id: 'addr-1', ...dto });
    });

    it('removes a withdrawal address for the current user', async () => {
      walletService.removeWithdrawalAddress.mockResolvedValue({ success: true });

      const result = await controller.removeWithdrawalAddress('user-1', 'addr-1');

      expect(walletService.removeWithdrawalAddress).toHaveBeenCalledWith('user-1', 'addr-1');
      expect(result).toEqual({ success: true });
    });

    it('protects address mutations with frontend and step-up guards', () => {
      const listGuards = Reflect.getMetadata(GUARDS_METADATA, controller.listWithdrawalAddresses) ?? [];
      const addGuards = Reflect.getMetadata(GUARDS_METADATA, controller.addWithdrawalAddress) ?? [];
      const removeGuards = Reflect.getMetadata(GUARDS_METADATA, controller.removeWithdrawalAddress) ?? [];

      expect(listGuards).toContain(FrontendOnlyGuard);
      expect(Reflect.getMetadata(IS_FRONTEND_ONLY_KEY, controller.listWithdrawalAddresses)).toBe(true);
      expect(addGuards).toContain(FrontendOnlyGuard);
      expect(addGuards).toContain(StepUpGuard);
      expect(removeGuards).toContain(FrontendOnlyGuard);
      expect(removeGuards).toContain(StepUpGuard);
      expect(Reflect.getMetadata(STEP_UP_KEY, controller.addWithdrawalAddress)).toBe(true);
      expect(Reflect.getMetadata(STEP_UP_KEY, controller.removeWithdrawalAddress)).toBe(true);
    });
  });
});
