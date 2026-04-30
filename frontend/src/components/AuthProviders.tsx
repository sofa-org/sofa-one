import type { ReactNode } from 'react';
import { AuthProvider, ChainTypeEnum, OpenfortProvider, RecoveryMethod } from '@openfort/react';
import { getDefaultConfig, OpenfortWagmiBridge } from '@openfort/react/wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, WagmiProvider } from 'wagmi';
import { base, baseSepolia, mainnet, polygon, polygonAmoy, sepolia } from 'viem/chains';
import { DEFAULT_CHAIN_ID } from '../lib/api';

const OPENFORT_KEY = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
const OPENFORT_SHIELD_KEY = import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY;

const queryClient = new QueryClient();
const supportedChains = [baseSepolia, base, mainnet, sepolia, polygon, polygonAmoy] as const;
const wagmiConfig = createConfig(
  getDefaultConfig({
    appName: 'SOFA ONE',
    chains: supportedChains,
    ssr: false,
  }),
);

if (!OPENFORT_KEY) {
  throw new Error('Missing VITE_OPENFORT_PUBLISHABLE_KEY environment variable');
}

if (!OPENFORT_SHIELD_KEY) {
  throw new Error('Missing VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY environment variable');
}

export default function AuthProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <OpenfortWagmiBridge>
          <OpenfortProvider
            publishableKey={OPENFORT_KEY}
            walletConfig={{
              chainType: ChainTypeEnum.EVM,
              shieldPublishableKey: OPENFORT_SHIELD_KEY,
              ethereum: { chainId: DEFAULT_CHAIN_ID },
              connectOnLogin: false,
            }}
            uiConfig={{
              appName: 'SOFA ONE',
              authProviders: [AuthProvider.EMAIL_OTP],
              walletRecovery: { defaultMethod: RecoveryMethod.PASSWORD },
            }}
          >
            {children}
          </OpenfortProvider>
        </OpenfortWagmiBridge>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
