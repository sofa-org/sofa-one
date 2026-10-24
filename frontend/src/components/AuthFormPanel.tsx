import EmailOtpForm from '../pages/EmailOtpForm';
import OpenfortAuthProvider from './OpenfortAuthProvider';
import PublicOnlyRoute from './PublicOnlyRoute';

export default function AuthFormPanel() {
  return (
    <PublicOnlyRoute>
      <OpenfortAuthProvider>
        <EmailOtpForm />
      </OpenfortAuthProvider>
    </PublicOnlyRoute>
  );
}
