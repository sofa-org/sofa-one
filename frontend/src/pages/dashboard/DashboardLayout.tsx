import { useState } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';
import { useOpenfort, useSignOut } from '@openfort/react';
import { AlertCircle, LogOut, Wallet, KeyRound, BookOpen, Loader2, Menu, X } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Wallet', icon: Wallet },
  { href: '/dashboard/api-keys', label: 'API Keys', icon: KeyRound },
  { href: '/dashboard/docs', label: 'API Docs', icon: BookOpen },
];

export default function DashboardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useOpenfort();
  const { signOut } = useSignOut();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [signOutLoading, setSignOutLoading] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const accountEmail = user?.email ?? null;

  const handleSignOut = async () => {
    if (signOutLoading) return;

    setMobileMenuOpen(false);
    setSignOutLoading(true);
    setSignOutError(null);

    try {
      await signOut();
      navigate('/sign-in', { replace: true });
    } catch (err: unknown) {
      setSignOutError(err instanceof Error ? err.message : 'Could not sign out. Please try again.');
    } finally {
      setSignOutLoading(false);
    }
  };

  const UserBadge = () => (
    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-accent/10 text-xs font-bold uppercase text-brand-accent">
      {(user?.email?.[0] ?? 'U').toUpperCase()}
    </div>
  );

  const NavLinks = () => (
    <>
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === '/dashboard'
            ? location.pathname === '/dashboard'
            : location.pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            onClick={() => {
              setMobileMenuOpen(false);
              setSignOutError(null);
            }}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? 'bg-brand-accent/10 text-brand-accent'
                : 'text-brand-muted hover:bg-brand-bg hover:text-brand-text'
            }`}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </>
  );

  const SignOutIcon = () =>
    signOutLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />;

  const SignOutError = () =>
    signOutError ? (
      <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{signOutError}</span>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signOutLoading}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2 py-1 font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <SignOutIcon />
          {signOutLoading ? 'Retrying…' : 'Retry sign out'}
        </button>
      </div>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col bg-brand-bg lg:h-screen lg:overflow-hidden lg:flex-row">
      {/* Mobile Top Bar */}
      <div className="flex lg:hidden items-center justify-between border-b border-brand-border bg-brand-surface px-4 py-3">
        <span className="text-lg font-bold font-serif tracking-tight text-brand-text">
          SOFA ONE
        </span>
        <div className="flex items-center gap-4">
          <UserBadge />
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="rounded-lg p-1.5 text-brand-muted transition-colors hover:bg-brand-bg hover:text-brand-text"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)} />
          <div className="relative flex w-64 flex-col bg-brand-surface shadow-xl h-full border-r border-brand-border animate-in slide-in-from-left-4 duration-200">
            <div className="flex items-center justify-between border-b border-brand-border px-6 py-4">
              <span className="text-lg font-bold font-serif tracking-tight text-brand-text">
                SOFA ONE
              </span>
              <button onClick={() => setMobileMenuOpen(false)} className="text-brand-muted p-1">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 px-3 py-4">
              <NavLinks />
            </nav>
            <div className="border-t border-brand-border px-4 py-4">
              <SignOutError />
              <div className="mb-3 flex min-w-0 items-center gap-2 rounded-lg bg-brand-bg px-3 py-2">
                <UserBadge />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-muted">
                    Signed in as
                  </p>
                  <p className="truncate text-sm font-medium text-brand-text">
                    {accountEmail ?? 'Openfort user'}
                  </p>
                </div>
                {accountEmail && <CopyButton text={accountEmail} className="h-7 w-7 shrink-0" />}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-brand-muted">
                  {signOutLoading ? 'Signing out…' : 'Sign out'}
                </span>
                <button
                  onClick={handleSignOut}
                  disabled={signOutLoading}
                  className="rounded-lg p-1.5 text-brand-muted transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="Sign out"
                >
                  <SignOutIcon />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop Sidebar */}
      <aside className="hidden w-60 flex-col border-r border-brand-border bg-brand-surface lg:flex lg:h-screen">
        <div className="flex items-center gap-2 border-b border-brand-border px-6 py-4">
          <span className="text-lg font-bold font-serif tracking-tight text-brand-text">
            SOFA ONE
          </span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          <NavLinks />
        </nav>
        <div className="border-t border-brand-border px-4 py-4">
          <SignOutError />
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <UserBadge />
              <span className="truncate text-xs font-medium text-brand-muted">
                {accountEmail ?? 'Openfort user'}
              </span>
              {accountEmail && <CopyButton text={accountEmail} className="h-7 w-7 shrink-0" />}
            </div>
            <button
              onClick={handleSignOut}
              disabled={signOutLoading}
              className="rounded-lg p-1.5 text-brand-muted transition-colors hover:bg-brand-bg hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Sign out"
            >
              <SignOutIcon />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-brand-bg p-4 sm:p-8 lg:h-screen">
        <Outlet />
      </main>
    </div>
  );
}
