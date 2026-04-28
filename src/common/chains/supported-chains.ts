import { BadRequestException } from '@nestjs/common';
import type { Chain } from 'viem';
import { base, baseSepolia, mainnet, polygon, polygonAmoy, sepolia } from 'viem/chains';

export type SupportedChain = {
  chainId: number;
  name: string;
  chain: Chain;
  nativeCurrencySymbol: string;
  usdcAddress: `0x${string}`;
};

export const DEFAULT_CHAIN_ID = 84532;

export const SUPPORTED_CHAINS: Record<number, SupportedChain> = {
  84532: {
    chainId: 84532,
    name: 'Base Sepolia',
    chain: baseSepolia,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    chain: base,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  1: {
    chainId: 1,
    name: 'Ethereum',
    chain: mainnet,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  11155111: {
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    chain: sepolia,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  137: {
    chainId: 137,
    name: 'Polygon',
    chain: polygon,
    nativeCurrencySymbol: 'POL',
    usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  80002: {
    chainId: 80002,
    name: 'Polygon Amoy',
    chain: polygonAmoy,
    nativeCurrencySymbol: 'POL',
    usdcAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  },
};

export const SUPPORTED_CHAIN_IDS = Object.keys(SUPPORTED_CHAINS).map(Number);

export function getSupportedChain(chainId: number): SupportedChain {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) {
    throw new BadRequestException(`Chain ${chainId} is not supported`);
  }
  return chain;
}

export function assertAllowedApiKeyChain(
  apiKeyRecord: { allowedChains?: number[] } | undefined,
  chainId: number,
) {
  if (!apiKeyRecord) return;
  if (!apiKeyRecord.allowedChains?.includes(chainId)) {
    throw new BadRequestException(`API key is not allowed to use chain ${chainId}`);
  }
}
