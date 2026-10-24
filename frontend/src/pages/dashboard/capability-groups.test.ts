import { describe, expect, it } from 'vitest';
import type { DefiCapability } from '@/lib/api';
import { capabilityGroupsForChain, validCapabilityGroupForChain } from './capability-groups';

const capability = (chainId: number, protocol: string): DefiCapability => ({
  capabilityId: `${chainId}:${protocol}`,
  type: 'contract_call',
  chainId,
  contract: '0x0000000000000000000000000000000000000001',
  label: 'execute',
  description: '',
  status: 'active',
  policy: { ref: 'test', version: 1 },
  protocol,
});

const catalog = [
  capability(1, 'Alpha'),
  capability(1, 'Shared'),
  capability(2, 'Beta'),
  capability(2, 'Shared'),
];

describe('capability groups by chain', () => {
  it('shows groups from all chains or only the selected chain', () => {
    expect(capabilityGroupsForChain(catalog, 'all')).toEqual(['Alpha', 'Beta', 'Shared']);
    expect(capabilityGroupsForChain(catalog, '1')).toEqual(['Alpha', 'Shared']);
    expect(capabilityGroupsForChain(catalog, '2')).toEqual(['Beta', 'Shared']);
  });

  it('resets a selected group unavailable on the newly selected chain', () => {
    expect(validCapabilityGroupForChain('Alpha', catalog, '2')).toBe('all');
    expect(validCapabilityGroupForChain('Shared', catalog, '2')).toBe('Shared');
  });

  it('preserves the selected group while All chains is selected', () => {
    expect(validCapabilityGroupForChain('Alpha', catalog, 'all')).toBe('Alpha');
  });
});
