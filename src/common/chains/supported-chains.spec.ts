import { BadRequestException } from '@nestjs/common';
import {
  arbitrum,
  bsc,
  bscTestnet,
  monad,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';
import {
  getSupportedChain,
  SUPPORTED_CHAIN_IDS,
  SUPPORTED_CHAINS,
} from './supported-chains';

describe('supported chains', () => {
  it('includes Polygon mainnet with the canonical USDC contract', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(137);
    expect(getSupportedChain(137)).toEqual({
      chainId: 137,
      name: 'Polygon',
      chain: polygon,
      nativeCurrencySymbol: 'POL',
      usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      usdtAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    });
  });

  it('includes Polygon Amoy for testnet flows', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(80002);
    expect(getSupportedChain(80002)).toEqual({
      chainId: 80002,
      name: 'Polygon Amoy',
      chain: polygonAmoy,
      nativeCurrencySymbol: 'POL',
      usdcAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    });
  });

  it('includes Arbitrum mainnet', () => {
    expect(getSupportedChain(42161)).toEqual({
      chainId: 42161,
      name: 'Arbitrum One',
      chain: arbitrum,
      nativeCurrencySymbol: 'ETH',
      usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      usdtAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    });
  });

  it('includes OP mainnet and Sepolia', () => {
    expect(getSupportedChain(10)).toEqual({
      chainId: 10,
      name: 'OP Mainnet',
      chain: optimism,
      nativeCurrencySymbol: 'ETH',
      usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      usdtAddress: '0x94b008aD8B7A6d11aA617D2bC1864F3A5F71F5E9',
    });
    expect(getSupportedChain(11155420)).toEqual({
      chainId: 11155420,
      name: 'OP Sepolia',
      chain: optimismSepolia,
      nativeCurrencySymbol: 'ETH',
      usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    });
  });

  it('includes BNB Smart Chain mainnet and testnet', () => {
    expect(getSupportedChain(56)).toEqual({
      chainId: 56,
      name: 'BNB Smart Chain',
      chain: bsc,
      nativeCurrencySymbol: 'BNB',
      usdcAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      usdtAddress: '0x55d398326f99059fF775485246999027B3197955',
    });
    expect(getSupportedChain(97)).toEqual({
      chainId: 97,
      name: 'BNB Smart Chain Testnet',
      chain: bscTestnet,
      nativeCurrencySymbol: 'tBNB',
      usdcAddress: '0x64544969ed7EBf5f083679233325356EbE738930',
      usdtAddress: '0x7ef95a0Fee0FBDD40eD8b6C78740125E4A6Abe7f',
    });
  });

  it('includes Monad mainnet', () => {
    expect(getSupportedChain(143)).toEqual({
      chainId: 143,
      name: 'Monad',
      chain: monad,
      nativeCurrencySymbol: 'MON',
    });
  });

  it('rejects chains without Calibur deployment', () => {
    expect(() => getSupportedChain(421614)).toThrow(BadRequestException);
    expect(() => getSupportedChain(10143)).toThrow(BadRequestException);
  });

  it('keeps every configured chain reachable through SUPPORTED_CHAIN_IDS', () => {
    expect(SUPPORTED_CHAIN_IDS.sort((a, b) => a - b)).toEqual(
      Object.keys(SUPPORTED_CHAINS).map(Number).sort((a, b) => a - b),
    );
  });

  it('rejects unsupported chain IDs', () => {
    expect(() => getSupportedChain(999999)).toThrow(BadRequestException);
  });
});
