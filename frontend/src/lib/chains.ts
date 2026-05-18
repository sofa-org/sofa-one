export const SUPPORTED_CHAINS = [
  {
    id: 84532,
    name: 'Base Sepolia',
    explorerBaseUrl: 'https://sepolia.basescan.org',
  },
  { id: 8453, name: 'Base', explorerBaseUrl: 'https://basescan.org' },
  { id: 1, name: 'Ethereum', explorerBaseUrl: 'https://etherscan.io' },
  {
    id: 11155111,
    name: 'Ethereum Sepolia',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
  },
  { id: 137, name: 'Polygon', explorerBaseUrl: 'https://polygonscan.com' },
  {
    id: 80002,
    name: 'Polygon Amoy',
    explorerBaseUrl: 'https://amoy.polygonscan.com',
  },
] as const;

function getSupportedChain(chainId: number) {
  return SUPPORTED_CHAINS.find((chain) => chain.id === chainId);
}

export function formatChainName(chainId: number) {
  return getSupportedChain(chainId)?.name ?? `Chain ${chainId}`;
}

export function getExplorerAddressUrl(chainId: number, address?: string | null) {
  const explorerBaseUrl = getSupportedChain(chainId)?.explorerBaseUrl;
  if (!explorerBaseUrl || !address) return null;
  return `${explorerBaseUrl}/address/${address}`;
}

export function getExplorerTransactionUrl(chainId: number, txHash?: string | null) {
  const explorerBaseUrl = getSupportedChain(chainId)?.explorerBaseUrl;
  if (!explorerBaseUrl || !txHash) return null;
  return `${explorerBaseUrl}/tx/${txHash}`;
}
