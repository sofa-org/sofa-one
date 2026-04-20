'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton, useClerk } from '@clerk/nextjs';


const NAV_ITEMS = [
  { href: '/dashboard', label: 'Wallet' },
  { href: '/dashboard/api-keys', label: 'API Keys' },
  { href: '/dashboard/transactions', label: 'Transactions' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { signOut } = useClerk();

  const handleSignOut = async () => {
    await signOut({ redirectUrl: '/' });
  };

  return (
    <div className="flex min-h-screen bg-brand-bg">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r border-brand-border bg-brand-surface">
        <div className="flex items-center gap-2 border-b border-brand-border px-6 py-4">
          <span className="text-lg font-bold font-serif tracking-tight text-brand-text">SOFA Agent Wallet</span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand-accent/10 text-brand-accent'
                    : 'text-brand-muted hover:bg-brand-bg hover:text-brand-text'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-brand-border px-4 py-4">
          <div className="flex items-center justify-between">
            <UserButton />
            <button
              onClick={handleSignOut}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-muted transition-colors hover:bg-brand-bg hover:text-brand-text"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-brand-bg p-8">{children}</main>
    </div>
  );
}
