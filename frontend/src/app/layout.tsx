import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Wallet',
  description: 'Server-side automated blockchain signing for your AI agents',
};

// Clerk requires NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY at build time.
// Force dynamic rendering so static generation doesn't fail without it.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
