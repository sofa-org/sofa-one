import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './index.css';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!CLERK_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={CLERK_KEY}
      appearance={{
        variables: {
          colorPrimary: '#2D2B2A',
          colorText: '#2D2B2A',
          colorBackground: '#FFFFFF',
          colorInputBackground: '#FAF9F6',
          colorInputText: '#2D2B2A',
          fontFamily: "'Inter', sans-serif",
          borderRadius: '0.75rem',
        },
        elements: {
          card: 'shadow-sm border border-[#E8E2D9] rounded-2xl bg-[#FFFFFF] p-8',
          headerTitle: 'font-serif text-2xl text-[#2D2B2A] tracking-tight',
          headerSubtitle: 'text-[#6B6560]',
          socialButtonsBlockButton:
            'border border-[#E8E2D9] hover:bg-[#FAF9F6] text-[#2D2B2A] bg-white transition-colors',
          formButtonPrimary:
            'bg-[#2D2B2A] hover:bg-[#1a1a1a] text-white transition-colors',
          formFieldInput:
            'border-[#E8E2D9] focus:ring-[#C4956A] focus:border-[#C4956A]',
          dividerLine: 'bg-[#E8E2D9]',
          dividerText: 'text-[#6B6560] bg-[#FFFFFF]',
          footerActionLink:
            'text-[#2D2B2A] hover:text-[#C4956A] font-medium',
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  </StrictMode>,
);
