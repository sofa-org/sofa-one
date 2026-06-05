import { BadRequestException } from '@nestjs/common';
import type { Chain } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains';

export type SupportedChain = {
  chainId: number;
  name: string;
  chain: Chain;
  nativeCurrencySymbol: string;
  usdcAddress: `0x${string}`;
  usdtAddress?: `0x${string}`;
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
    usdtAddress: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
  1: {
    chainId: 1,
    name: 'Ethereum',
    chain: mainnet,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdtAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
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
    usdtAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  80002: {
    chainId: 80002,
    name: 'Polygon Amoy',
    chain: polygonAmoy,
    nativeCurrencySymbol: 'POL',
    usdcAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    chain: arbitrum,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    usdtAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
  421614: {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    chain: arbitrumSepolia,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  10: {
    chainId: 10,
    name: 'OP Mainnet',
    chain: optimism,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    usdtAddress: '0x94b008aD8B7A6d11aA617D2bC1864F3A5F71F5E9',
  },
  11155420: {
    chainId: 11155420,
    name: 'OP Sepolia',
    chain: optimismSepolia,
    nativeCurrencySymbol: 'ETH',
    usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  },
  56: {
    chainId: 56,
    name: 'BNB Smart Chain',
    chain: bsc,
    nativeCurrencySymbol: 'BNB',
    usdcAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    usdtAddress: '0x55d398326f99059fF775485246999027B3197955',
  },
  97: {
    chainId: 97,
    name: 'BNB Smart Chain Testnet',
    chain: bscTestnet,
    nativeCurrencySymbol: 'tBNB',
    usdcAddress: '0x64544969ed7EBf5f083679233325356EbE738930',
    usdtAddress: '0x7ef95a0Fee0FBDD40eD8b6C78740125E4A6Abe7f',
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
