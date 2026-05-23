import { isIP } from 'net';

type ParsedIp = {
  version: 4 | 6;
  value: bigint;
};

/** Returns true if `ip` is within any of the given CIDR ranges or matches exactly. */
export function isIpAllowed(ip: string, allowedEntries: string[]): boolean {
  const parsedIp = parseIp(ip);
  if (!parsedIp) return false;

  return allowedEntries.some((entry) => {
    if (entry.includes('/')) return isIpInCidr(parsedIp, entry);

    const allowedIp = parseIp(entry);
    return allowedIp?.version === parsedIp.version && allowedIp.value === parsedIp.value;
  });
}

export function isIpOrCidr(value: string): boolean {
  if (!value.includes('/')) return parseIp(value) !== null;
  return isValidCidr(value);
}

function isIpInCidr(ip: ParsedIp, cidr: string): boolean {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const [network, prefixStr] = parts;
  if (!/^\d+$/.test(prefixStr)) return false;
  const prefix = parseInt(prefixStr, 10);
  const parsedNetwork = parseIp(network);
  if (!parsedNetwork || parsedNetwork.version !== ip.version) return false;

  const maxPrefix = ip.version === 4 ? 32 : 128;
  if (isNaN(prefix) || prefix < 0 || prefix > maxPrefix) return false;

  const hostBits = BigInt(maxPrefix - prefix);
  return (ip.value >> hostBits) === (parsedNetwork.value >> hostBits);
}

function isValidCidr(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [network, prefixStr] = parts;
  if (!/^\d+$/.test(prefixStr)) return false;
  const parsedNetwork = parseIp(network);
  if (!parsedNetwork) return false;

  const prefix = parseInt(prefixStr, 10);
  const maxPrefix = parsedNetwork.version === 4 ? 32 : 128;
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= maxPrefix;
}

function parseIp(ip: string): ParsedIp | null {
  if (isIP(ip) === 4) {
    const value = ipv4ToNumber(ip);
    return value === null ? null : { version: 4, value: BigInt(value) };
  }

  if (isIP(ip) === 6) {
    const value = ipv6ToBigInt(ip);
    return value === null ? null : { version: 6, value };
  }

  return null;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes('%')) return null;

  const normalized = normalizeIpv4EmbeddedIpv6(ip.toLowerCase());
  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) return null;

  const left = splitIpv6Groups(doubleColonParts[0]);
  const right = doubleColonParts.length === 2 ? splitIpv6Groups(doubleColonParts[1]) : [];
  if (!left || !right) return null;

  const missingGroupCount = 8 - left.length - right.length;
  if (doubleColonParts.length === 1 && missingGroupCount !== 0) return null;
  if (doubleColonParts.length === 2 && missingGroupCount < 0) return null;

  const groups = [...left, ...Array(missingGroupCount).fill('0'), ...right];
  if (groups.length !== 8) return null;

  return groups.reduce((result, group) => (result << 16n) + BigInt(parseInt(group, 16)), 0n);
}

function normalizeIpv4EmbeddedIpv6(ip: string): string {
  const lastColonIndex = ip.lastIndexOf(':');
  if (lastColonIndex === -1) return ip;

  const maybeIpv4 = ip.slice(lastColonIndex + 1);
  if (!maybeIpv4.includes('.')) return ip;

  const ipv4 = ipv4ToNumber(maybeIpv4);
  if (ipv4 === null) return ip;

  const high = ((ipv4 >>> 16) & 0xffff).toString(16);
  const low = (ipv4 & 0xffff).toString(16);
  return `${ip.slice(0, lastColonIndex)}:${high}:${low}`;
}

function splitIpv6Groups(value: string): string[] | null {
  if (value === '') return [];

  const groups = value.split(':');
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups : null;
}
