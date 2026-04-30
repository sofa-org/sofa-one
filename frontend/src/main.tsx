import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import {
  AuthProvider,
  ChainTypeEnum,
  OpenfortProvider,
  RecoveryMethod,
  ThirdPartyOAuthProvider,
} from '@openfort/react';
import { getDefaultConfig, OpenfortWagmiBridge } from '@openfort/react/wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, WagmiProvider } from 'wagmi';
import { base, baseSepolia, mainnet, polygon, polygonAmoy, sepolia } from 'viem/chains';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DEFAULT_CHAIN_ID } from './lib/api';
import './index.css';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
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

if (!CLERK_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable');
}

if (!OPENFORT_KEY) {
  throw new Error('Missing VITE_OPENFORT_PUBLISHABLE_KEY environment variable');
}

if (!OPENFORT_SHIELD_KEY) {
  throw new Error('Missing VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY environment variable');
}

function AppWithOpenfort() {
  const { getToken } = useAuth();

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <OpenfortWagmiBridge>
          <OpenfortProvider
            publishableKey={OPENFORT_KEY}
            thirdPartyAuth={{
              provider: ThirdPartyOAuthProvider.CUSTOM,
              getAccessToken: getToken,
            }}
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
            <App />
          </OpenfortProvider>
        </OpenfortWagmiBridge>
      </WagmiProvider>
    </QueryClientProvider>
  );
}

function AppWithClerk() {
  const navigate = useNavigate();
  return (
    <ClerkProvider
      publishableKey={CLERK_KEY}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      appearance={{
        variables: {
          colorPrimary: '#C4956A',
          colorText: '#2D2B2A',
          colorBackground: '#FFFFFF',
          colorInputBackground: '#FAF9F6',
          colorInputText: '#2D2B2A',
          fontFamily: "'Inter', sans-serif",
          borderRadius: '0.75rem',
        },
        elements: {
          card: 'shadow-2xl shadow-[#E8E2D9]/40 border border-[#E8E2D9]/60 rounded-2xl bg-white',
          headerTitle: "font-serif text-2xl text-[#2D2B2A] tracking-tight",
          headerSubtitle: 'text-[#6B6560] text-sm',
          socialButtonsBlockButton:
            'border border-[#E8E2D9] hover:bg-[#FAF9F6] text-[#2D2B2A] bg-white transition-all duration-300',
          formButtonPrimary:
            'bg-[#2D2B2A] hover:bg-[#1a1a1a] text-white transition-all duration-300 shadow-none',
          formFieldInput:
            'border-[#E8E2D9] bg-[#FAF9F6]/50 focus:bg-white focus:ring-[#C4956A] focus:border-[#C4956A] transition-all duration-300',
          dividerLine: 'bg-[#E8E2D9]',
          dividerText: 'text-[#6B6560] text-xs bg-white',
          footerActionLink: 'text-[#C4956A] hover:text-[#B38459] font-medium transition-colors duration-300',
          identityPreviewEditButton: 'text-[#C4956A] hover:text-[#B38459]',
        },
      }}
    >
      <AppWithOpenfort />
    </ClerkProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AppWithClerk />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
