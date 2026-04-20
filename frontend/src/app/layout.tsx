import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Inter, Newsreader } from 'next/font/google';
import './globals.css';

const inter = Inter({ 
  subsets: ['latin'], 
  variable: '--font-inter',
  display: 'swap',
});

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  style: ['normal', 'italic'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SOFA Agent Wallet',
  description: 'Server-side automated blockchain signing for your AI agents',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: '#2D2B2A',
          colorText: '#2D2B2A',
          colorBackground: '#FFFFFF',
          colorInputBackground: '#FAF9F6',
          colorInputText: '#2D2B2A',
          fontFamily: 'var(--font-inter)',
          borderRadius: '0.75rem',
        },
        elements: {
          card: 'shadow-sm border border-[#E8E2D9] rounded-2xl bg-[#FFFFFF] p-8',
          headerTitle: 'font-serif text-2xl text-[#2D2B2A] tracking-tight',
          headerSubtitle: 'text-[#6B6560]',
          socialButtonsBlockButton: 'border border-[#E8E2D9] hover:bg-[#FAF9F6] text-[#2D2B2A] bg-white transition-colors',
          formButtonPrimary: 'bg-[#2D2B2A] hover:bg-[#1a1a1a] text-white transition-colors',
          formFieldInput: 'border-[#E8E2D9] focus:ring-[#C4956A] focus:border-[#C4956A]',
          dividerLine: 'bg-[#E8E2D9]',
          dividerText: 'text-[#6B6560] bg-[#FFFFFF]',
          footerActionLink: 'text-[#2D2B2A] hover:text-[#C4956A] font-medium',
        }
      }}
    >
      <html lang="en" className={`${inter.variable} ${newsreader.variable}`} suppressHydrationWarning>
        <body className="min-h-screen bg-brand-bg text-brand-text font-sans antialiased selection:bg-brand-accent selection:text-white" suppressHydrationWarning>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
