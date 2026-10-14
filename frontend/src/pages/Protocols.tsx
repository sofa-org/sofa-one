import { useMemo, useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SUPPORTED_PROTOCOLS } from './supported-protocols';

export default function ProtocolsPage() {
  const [query, setQuery] = useState('');
  const filteredProtocols = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return SUPPORTED_PROTOCOLS;
    return SUPPORTED_PROTOCOLS.filter((protocol) =>
      protocol.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  return (
    <div className="min-h-screen bg-brand-bg text-brand-text antialiased selection:bg-brand-accent selection:text-white">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
        <Link to="/" className="font-serif text-xl font-medium tracking-tight text-brand-text transition-colors hover:text-brand-accent">
          SOFA ONE
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-5 text-sm">
          <Link to="/pricing" className="font-medium text-brand-muted transition-colors hover:text-brand-text">Pricing</Link>
          <Link to="/sign-in" className="rounded-full bg-brand-text px-5 py-2 text-xs font-medium tracking-widest text-white transition-colors hover:bg-black/90">SIGN IN</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-20">
        <section className="relative isolate overflow-hidden rounded-[2rem] border border-brand-border bg-white px-6 py-12 shadow-sm sm:px-10 md:py-16">
          <div aria-hidden="true" className="absolute -right-24 -top-32 -z-10 h-80 w-80 rounded-full bg-brand-accent/10 blur-3xl" />
          <div className="absolute right-8 top-8 hidden font-mono text-xs tracking-[0.25em] text-brand-accent/70 sm:block">
            SOFA / NETWORKS
          </div>
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-brand-accent">Built to work across DeFi</p>
          <h1 className="mt-5 max-w-3xl font-serif text-4xl font-normal leading-tight tracking-tight text-brand-text sm:text-5xl md:text-6xl">
            One place for the <span className="italic text-brand-accent">protocols</span> we support.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-brand-muted sm:text-lg">
            Explore the DeFi protocols represented in SOFA ONE’s supported integrations. Visit each project’s official website to learn more.
          </p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <span className="font-serif text-3xl text-brand-text">{filteredProtocols.length}</span>
              <span className="text-sm text-brand-muted">{query ? 'matching protocols' : 'protocol integrations'}</span>
            </div>
            <label className="relative block w-full sm:max-w-sm">
              <span className="sr-only">Search protocols</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-muted" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search protocols"
                className="w-full rounded-full border border-brand-border bg-brand-bg/70 py-3 pl-11 pr-4 text-sm text-brand-text outline-none transition focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20"
              />
            </label>
          </div>
        </section>

        {filteredProtocols.length ? (
          <section aria-label="Supported protocols" className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredProtocols.map((protocol) => (
              <article
                key={protocol.name}
                className="group flex min-h-32 items-center justify-between gap-4 rounded-2xl border border-brand-border bg-white/80 p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-brand-accent/50 hover:shadow-md"
              >
                <div className="min-w-0">
                  <h2 className="font-serif text-xl font-medium text-brand-text">{protocol.name}</h2>
                  <p className="mt-2 truncate text-sm text-brand-muted">{protocol.website.replace('https://', '')}</p>
                </div>
                <a
                  href={protocol.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Visit ${protocol.name} website (opens in a new tab)`}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand-border text-brand-muted transition group-hover:border-brand-accent group-hover:bg-brand-accent group-hover:text-white focus:outline-none focus:ring-2 focus:ring-brand-accent focus:ring-offset-2"
                >
                  <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                </a>
              </article>
            ))}
          </section>
        ) : (
          <div className="mt-8 rounded-2xl border border-dashed border-brand-border bg-white/50 px-6 py-14 text-center">
            <p className="font-serif text-2xl text-brand-text">No protocols found</p>
            <p className="mt-2 text-sm text-brand-muted">Try another name or clear your search.</p>
            <button type="button" onClick={() => setQuery('')} className="mt-5 text-sm font-semibold text-brand-accent underline underline-offset-4 hover:text-brand-accent-hover">Clear search</button>
          </div>
        )}

        <aside className="mt-8 rounded-2xl border border-brand-border/80 bg-brand-surface/50 px-5 py-4 text-sm leading-6 text-brand-muted sm:px-6">
          <p><span className="font-semibold text-brand-text">A note on support:</span> Integrations cover specific reviewed functions only—not every feature a protocol offers. This directory is informational and is not an endorsement or financial advice. Always verify a project and its website before interacting.</p>
        </aside>

        <footer className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-brand-border pt-6 text-sm text-brand-muted sm:flex-row sm:items-center">
          <span>SOFA ONE · Protocol directory</span>
          <Link to="/" className="font-medium text-brand-text underline decoration-brand-border underline-offset-4 transition hover:decoration-brand-text">Back to SOFA ONE</Link>
        </footer>
      </main>
    </div>
  );
}
