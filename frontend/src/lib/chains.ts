export const SUPPORTED_CHAINS = [
  { id: 84532, name: 'Base Sepolia' },
  { id: 8453, name: 'Base' },
  { id: 1, name: 'Ethereum' },
  { id: 11155111, name: 'Ethereum Sepolia' },
  { id: 137, name: 'Polygon' },
  { id: 80002, name: 'Polygon Amoy' },
] as const;

export function formatChainName(chainId: number) {
  return SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.name ?? `Chain ${chainId}`;
}
