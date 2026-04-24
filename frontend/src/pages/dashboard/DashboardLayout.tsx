import { useState } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';
import { UserButton, useClerk } from '@clerk/clerk-react';
import { LogOut, Wallet, ShieldCheck, KeyRound, BookOpen, Menu, X } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Wallet', icon: Wallet },
  { href: '/dashboard/policies', label: 'Policies', icon: ShieldCheck },
  { href: '/dashboard/api-keys', label: 'API Keys', icon: KeyRound },
  { href: '/dashboard/docs', label: 'API Docs', icon: BookOpen },
];

export default function DashboardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut(() => navigate('/'));
  };

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
            onClick={() => setMobileMenuOpen(false)}
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

  return (
    <div className="flex min-h-screen bg-brand-bg flex-col lg:flex-row">
      {/* Mobile Top Bar */}
      <div className="flex lg:hidden items-center justify-between border-b border-brand-border bg-brand-surface px-4 py-3">
        <span className="text-lg font-bold font-serif tracking-tight text-brand-text">
          SOFA ONE
        </span>
        <div className="flex items-center gap-4">
          <UserButton />
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
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-brand-muted">Sign out</span>
                <button
                  onClick={handleSignOut}
                  className="rounded-lg p-1.5 text-brand-muted transition-colors hover:bg-red-50 hover:text-red-600"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-60 flex-col border-r border-brand-border bg-brand-surface">
        <div className="flex items-center gap-2 border-b border-brand-border px-6 py-4">
          <span className="text-lg font-bold font-serif tracking-tight text-brand-text">
            SOFA ONE
          </span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          <NavLinks />
        </nav>
        <div className="border-t border-brand-border px-4 py-4">
          <div className="flex items-center justify-between">
            <UserButton />
            <button
              onClick={handleSignOut}
              className="rounded-lg p-1.5 text-brand-muted transition-colors hover:bg-brand-bg hover:text-brand-text"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-brand-bg p-4 sm:p-8">
        <Outlet />
      </main>
    </div>
  );
}
