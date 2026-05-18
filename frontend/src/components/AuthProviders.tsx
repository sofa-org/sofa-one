import type { ReactNode } from 'react';
import { AccountTypeEnum, AuthProvider, ChainTypeEnum, OpenfortProvider, RecoveryMethod } from '@openfort/react';
import { getDefaultConfig, OpenfortWagmiBridge } from '@openfort/react/wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { base, baseSepolia, mainnet, polygon, polygonAmoy, sepolia } from 'viem/chains';
import { DEFAULT_CHAIN_ID } from '../lib/api';
import { OpenfortConfigError } from './OpenfortConfigError';

const OPENFORT_KEY = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
const OPENFORT_SHIELD_KEY = import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY;

const queryClient = new QueryClient();
const supportedChains = [baseSepolia, base, mainnet, sepolia, polygon, polygonAmoy] as const;
const wagmiConfig = createConfig(
  getDefaultConfig({
    appName: 'SOFA ONE',
    chains: supportedChains,
    transports: {
      [baseSepolia.id]: http(
        import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
      ),
      [base.id]: http(import.meta.env.VITE_BASE_RPC_URL ?? 'https://mainnet.base.org'),
      [mainnet.id]: http(
        import.meta.env.VITE_ETHEREUM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
      ),
      [sepolia.id]: http(
        import.meta.env.VITE_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      ),
      [polygon.id]: http(
        import.meta.env.VITE_POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
      ),
      [polygonAmoy.id]: http(
        import.meta.env.VITE_POLYGON_AMOY_RPC_URL ?? 'https://polygon-amoy-bor-rpc.publicnode.com',
      ),
    },
    ssr: false,
  }),
);

export default function AuthProviders({ children }: { children: ReactNode }) {
  const missingVars = [
    !OPENFORT_KEY && 'VITE_OPENFORT_PUBLISHABLE_KEY',
    !OPENFORT_SHIELD_KEY && 'VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY',
  ].filter((name): name is string => Boolean(name));

  if (missingVars.length > 0) {
    return <OpenfortConfigError missingVars={missingVars} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <OpenfortWagmiBridge>
          <OpenfortProvider
            publishableKey={OPENFORT_KEY}
            walletConfig={{
              chainType: ChainTypeEnum.EVM,
              shieldPublishableKey: OPENFORT_SHIELD_KEY,
              ethereum: { chainId: DEFAULT_CHAIN_ID, accountType: AccountTypeEnum.EOA },
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
