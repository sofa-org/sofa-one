import type { ReactNode } from 'react';
import { AuthProvider, OpenfortProvider } from '@openfort/react';

const OPENFORT_KEY = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;

if (!OPENFORT_KEY) {
  throw new Error('Missing VITE_OPENFORT_PUBLISHABLE_KEY environment variable');
}

export default function OpenfortAuthProvider({ children }: { children: ReactNode }) {
  return (
    <OpenfortProvider
      publishableKey={OPENFORT_KEY}
      uiConfig={{
        appName: 'SOFA ONE',
        authProviders: [AuthProvider.EMAIL_OTP],
      }}
    >
      {children}
    </OpenfortProvider>
  );
}
