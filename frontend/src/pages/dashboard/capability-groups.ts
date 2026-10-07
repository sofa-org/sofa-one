import type { DefiCapability } from '@/lib/api';

export function capabilityCategory(capability: DefiCapability): string {
  const terms = `${capability.protocol ?? ''} ${capability.operation ?? ''} ${capability.label}`.toLowerCase();
  if (/approv|permit/.test(terms)) return 'Approvals';
  if (/swap|exchange|trade|router|pool/.test(terms)) return 'Swaps';
  if (/lend|borrow|repay|collateral|supply|withdraw/.test(terms)) return 'Lending';
  if (/stake|unstake|validator|restake/.test(terms)) return 'Staking';
  if (/vault|deposit|redeem|yield/.test(terms)) return 'Vaults';
  return capability.protocol || 'Other functions';
}

export function capabilityGroupsForChain(capabilities: readonly DefiCapability[], chainFilter: string): string[] {
  const chainCapabilities = chainFilter === 'all'
    ? capabilities
    : capabilities.filter((capability) => String(capability.chainId) === chainFilter);
  return [...new Set(chainCapabilities.map(capabilityCategory))].sort();
}

export function validCapabilityGroupForChain(
  group: string, capabilities: readonly DefiCapability[], chainFilter: string,
): string {
  return group === 'all' || capabilityGroupsForChain(capabilities, chainFilter).includes(group) ? group : 'all';
}
