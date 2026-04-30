import EmailOtpForm from '../pages/EmailOtpForm';
import OpenfortAuthProvider from './OpenfortAuthProvider';
import PublicOnlyRoute from './PublicOnlyRoute';

export default function AuthFormPanel({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  return (
    <OpenfortAuthProvider>
      <PublicOnlyRoute>
        <EmailOtpForm mode={mode} />
      </PublicOnlyRoute>
    </OpenfortAuthProvider>
  );
}
