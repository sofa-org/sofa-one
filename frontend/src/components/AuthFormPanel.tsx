import EmailOtpForm from '../pages/EmailOtpForm';
import OpenfortAuthProvider from './OpenfortAuthProvider';
import PublicOnlyRoute from './PublicOnlyRoute';

export default function AuthFormPanel() {
  return (
    <OpenfortAuthProvider>
      <PublicOnlyRoute>
        <EmailOtpForm />
      </PublicOnlyRoute>
    </OpenfortAuthProvider>
  );
}
