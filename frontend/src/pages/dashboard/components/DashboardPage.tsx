import type { ReactNode } from 'react';

interface DashboardPageProps {
  title: string;
  description: string;
  tags?: ReactNode;
  children: ReactNode;
}

export function DashboardPage({ title, description, tags, children }: DashboardPageProps) {
  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <div className="border-b border-brand-border pb-6">
        {tags && <div className="mb-4 flex flex-wrap gap-2">{tags}</div>}
        <h1 className="text-3xl font-bold font-serif text-brand-text">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-muted">
          {description}
        </p>
      </div>
      {children}
    </div>
  );
}

export function DashboardCard({
  title,
  description,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-brand-border bg-white p-7 shadow-xl ring-1 ring-black/5 ${className}`}
    >
      <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-text" />
      {(title || description) && (
        <div className="mb-6">
          {title && <h2 className="text-xl font-bold font-serif text-brand-text">{title}</h2>}
          {description && <p className="mt-2 text-sm text-brand-muted">{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
