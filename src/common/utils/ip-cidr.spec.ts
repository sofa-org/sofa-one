import { isIpAllowed } from './ip-cidr';

describe('isIpAllowed', () => {
  describe('exact IP matching', () => {
    it('allows an exact match', () => {
      expect(isIpAllowed('192.168.1.1', ['192.168.1.1'])).toBe(true);
    });

    it('rejects a non-matching IP', () => {
      expect(isIpAllowed('192.168.1.2', ['192.168.1.1'])).toBe(false);
    });

    it('allows when one of several entries matches', () => {
      expect(isIpAllowed('10.0.0.1', ['192.168.1.1', '10.0.0.1'])).toBe(true);
    });
  });

  describe('CIDR matching', () => {
    it('allows an IP inside a /24 range', () => {
      expect(isIpAllowed('10.0.0.100', ['10.0.0.0/24'])).toBe(true);
    });

    it('rejects an IP outside a /24 range', () => {
      expect(isIpAllowed('10.0.1.1', ['10.0.0.0/24'])).toBe(false);
    });

    it('0.0.0.0/0 matches every valid IPv4', () => {
      expect(isIpAllowed('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
      expect(isIpAllowed('255.255.255.255', ['0.0.0.0/0'])).toBe(true);
    });

    it('/32 matches only the exact host', () => {
      expect(isIpAllowed('172.16.0.1', ['172.16.0.1/32'])).toBe(true);
      expect(isIpAllowed('172.16.0.2', ['172.16.0.1/32'])).toBe(false);
    });

    it('allows the network address itself', () => {
      expect(isIpAllowed('192.168.0.0', ['192.168.0.0/16'])).toBe(true);
    });

    it('allows the broadcast address', () => {
      expect(isIpAllowed('192.168.255.255', ['192.168.0.0/16'])).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('returns false for an invalid prefix length', () => {
      expect(isIpAllowed('10.0.0.1', ['10.0.0.0/33'])).toBe(false);
    });

    it('returns false for a non-numeric prefix', () => {
      expect(isIpAllowed('10.0.0.1', ['10.0.0.0/xx'])).toBe(false);
    });

    it('returns false when the client IP is not a valid IPv4', () => {
      expect(isIpAllowed('not-an-ip', ['10.0.0.0/8'])).toBe(false);
    });

    it('returns false for an empty allowlist', () => {
      expect(isIpAllowed('10.0.0.1', [])).toBe(false);
    });
  });
});
