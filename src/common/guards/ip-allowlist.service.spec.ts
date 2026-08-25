import { ForbiddenException } from '@nestjs/common';
import { IpAllowlistService } from './ip-allowlist.service';
import { SecurityEventService } from '../../modules/security-events/security-event.service';

describe('IpAllowlistService', () => {
  let service: IpAllowlistService;
  let securityEvents: { record: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    securityEvents = { record: jest.fn().mockResolvedValue(undefined) };
    service = new IpAllowlistService(securityEvents as unknown as SecurityEventService);
  });

  describe('assertIpAllowed', () => {
    it('allows all IPs when allowlist is empty', async () => {
      await expect(
        service.assertIpAllowed('1.2.3.4', [], {
          actorType: 'api_key',
          clientIp: '1.2.3.4',
        }),
      ).resolves.toBeUndefined();

      expect(securityEvents.record).not.toHaveBeenCalled();
    });

    it('allows IPs that are in the allowlist', async () => {
      await expect(
        service.assertIpAllowed('1.2.3.4', ['1.2.3.4', '5.6.7.8'], {
          actorType: 'api_key',
          apiKeyId: 'key-1',
          clientIp: '1.2.3.4',
        }),
      ).resolves.toBeUndefined();

      expect(securityEvents.record).not.toHaveBeenCalled();
    });

    it('rejects IPs not in the allowlist and records a SecurityEvent', async () => {
      await expect(
        service.assertIpAllowed('9.9.9.9', ['1.2.3.4', '5.6.7.8'], {
          actorType: 'api_key',
          apiKeyId: 'key-1',
          apiKeyPrefix: 'sk_abc',
          userId: 'user-1',
          clientIp: '9.9.9.9',
          userAgent: 'TestAgent/1.0',
          allowedIpCount: 2,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(securityEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'api_key',
          eventType: 'api_key.ip_rejected',
          apiKeyId: 'key-1',
          userId: 'user-1',
          riskLevel: 'high',
          result: 'denied',
          reason: 'ip_allowlist_rejected',
          ip: '9.9.9.9',
          userAgent: 'TestAgent/1.0',
        }),
      );
    });

    it('supports CIDR ranges in the allowlist', async () => {
      await expect(
        service.assertIpAllowed('1.2.3.100', ['1.2.3.0/24'], {
          actorType: 'api_key',
          clientIp: '1.2.3.100',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects IPs outside CIDR range', async () => {
      await expect(
        service.assertIpAllowed('1.2.4.1', ['1.2.3.0/24'], {
          actorType: 'api_key',
          apiKeyId: 'key-1',
          clientIp: '1.2.4.1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('handles missing SecurityEventService gracefully', async () => {
      const serviceWithoutEvents = new IpAllowlistService(undefined as any);

      await expect(
        serviceWithoutEvents.assertIpAllowed('9.9.9.9', ['1.2.3.4'], {
          actorType: 'api_key',
          clientIp: '9.9.9.9',
        }),
      ).rejects.toThrow(ForbiddenException);
      // No crash — SecurityEvent recording is optional
    });

    it('handles SecurityEvent recording failure gracefully', async () => {
      securityEvents.record.mockRejectedValue(new Error('DB error'));

      await expect(
        service.assertIpAllowed('9.9.9.9', ['1.2.3.4'], {
          actorType: 'api_key',
          apiKeyId: 'key-1',
          clientIp: '9.9.9.9',
        }),
      ).rejects.toThrow(ForbiddenException);
      // Should not throw from the event recording failure
    });
  });

  describe('isIpAllowed', () => {
    it('returns true when allowlist is empty', () => {
      expect(service.isIpAllowed('1.2.3.4', [])).toBe(true);
    });

    it('returns true when IP is in the allowlist', () => {
      expect(service.isIpAllowed('1.2.3.4', ['1.2.3.4'])).toBe(true);
    });

    it('returns false when IP is not in the allowlist', () => {
      expect(service.isIpAllowed('9.9.9.9', ['1.2.3.4'])).toBe(false);
    });
  });
});