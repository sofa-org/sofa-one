export const SUPPORTED_CHAINS = [
  {
    id: 84532,
    name: 'Base Sepolia',
    nativeCurrencySymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.basescan.org',
    gasHelpUrl: 'https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet',
  },
  { id: 8453, name: 'Base', nativeCurrencySymbol: 'ETH', explorerBaseUrl: 'https://basescan.org' },
  { id: 1, name: 'Ethereum', nativeCurrencySymbol: 'ETH', explorerBaseUrl: 'https://etherscan.io' },
  {
    id: 11155111,
    name: 'Ethereum Sepolia',
    nativeCurrencySymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
    gasHelpUrl: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
  },
  { id: 137, name: 'Polygon', nativeCurrencySymbol: 'POL', explorerBaseUrl: 'https://polygonscan.com' },
  {
    id: 80002,
    name: 'Polygon Amoy',
    nativeCurrencySymbol: 'POL',
    explorerBaseUrl: 'https://amoy.polygonscan.com',
    gasHelpUrl: 'https://faucet.polygon.technology/',
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

export function getChainGasHelpUrl(chainId: number) {
  const chain = getSupportedChain(chainId);
  return chain && 'gasHelpUrl' in chain ? chain.gasHelpUrl : null;
}

export function getNativeCurrencySymbol(chainId: number) {
  return getSupportedChain(chainId)?.nativeCurrencySymbol ?? 'Native';
}
