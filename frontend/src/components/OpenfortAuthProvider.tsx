import type { ReactNode } from 'react';
import { AuthProvider, OpenfortProvider } from '@openfort/react';
import { OpenfortConfigError } from './OpenfortConfigError';

const OPENFORT_KEY = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;

export default function OpenfortAuthProvider({ children }: { children: ReactNode }) {
  if (!OPENFORT_KEY) {
    return <OpenfortConfigError missingVars={['VITE_OPENFORT_PUBLISHABLE_KEY']} />;
  }

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
