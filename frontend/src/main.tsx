import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './index.css';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!CLERK_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable');
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
      <App />
    </ClerkProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppWithClerk />
    </BrowserRouter>
  </StrictMode>,
);
