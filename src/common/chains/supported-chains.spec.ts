import { BadRequestException } from '@nestjs/common';
import { polygon, polygonAmoy } from 'viem/chains';
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

  it('keeps every configured chain reachable through SUPPORTED_CHAIN_IDS', () => {
    expect(SUPPORTED_CHAIN_IDS.sort((a, b) => a - b)).toEqual(
      Object.keys(SUPPORTED_CHAINS).map(Number).sort((a, b) => a - b),
    );
  });

  it('rejects unsupported chain IDs', () => {
    expect(() => getSupportedChain(999999)).toThrow(BadRequestException);
  });
});
