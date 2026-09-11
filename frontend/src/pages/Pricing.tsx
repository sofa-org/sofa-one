import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useOpenfort } from '@openfort/react';
import { Activity, ArrowLeft, Check, Mail, Users, Wallet, Zap } from 'lucide-react';
import AuthProviders from '../components/AuthProviders';

type PlanId = 'free' | 'starter' | 'growth' | 'scale' | 'business' | 'enterprise';

interface PricingPlan {
  id: PlanId;
  name: string;
  price: string;
  priceUnit: string;
  audience: string;
  outbound: string;
  wallets: number | string;
  apiCalls: string;
  team: number | string;
  features: readonly string[];
  cta: string;
  ctaTo: string;
  external?: boolean;
  recommended?: boolean;
}

const PLANS: readonly PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    priceUnit: '/month',
    audience: 'Developers, hackathons, testnet projects',
    outbound: '$50K',
    wallets: 10,
    apiCalls: '10K',
    team: 1,
    features: [
      'Basic wallet creation & management',
      'Create, revoke, and rotate API keys',
      'Testnet-first with limited mainnet access',
      'Transaction status tracking',
      'Community & documentation support',
      'Standard rate limits',
    ],
    cta: 'Start for free',
    ctaTo: '/sign-in',
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$49',
    priceUnit: '/month',
    audience: 'Small apps entering production',
    outbound: '$250K',
    wallets: 100,
    apiCalls: '100K',
    team: 3,
    features: [
      'Full mainnet production use',
      'Higher wallet, API & outbound allowances',
      'Basic webhooks',
      'Basic audit logs',
      'Basic IP allowlist',
      'Email support',
    ],
    cta: 'Get Starter',
    ctaTo: '/sign-in',
  },
  {
    id: 'growth',
    name: 'Growth',
    price: '$199',
    priceUnit: '/month',
    audience: 'Apps with real users and steady volume',
    outbound: '$1M',
    wallets: '1,000',
    apiCalls: '1M',
    team: 5,
    features: [
      'Multi-project / environment management',
      'Granular API key permissions',
      'Webhook retries & failure logs',
      'Advanced transaction limits',
      'Freeze users, wallets & API keys',
      'Priority weekday support',
    ],
    cta: 'Get Growth',
    ctaTo: '/sign-in',
    recommended: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    price: '$799',
    priceUnit: '/month',
    audience: 'Growing wallets, agent platforms, protocol teams',
    outbound: '$5M',
    wallets: '5,000',
    apiCalls: '5M',
    team: 10,
    features: [
      'Advanced risk controls',
      'Higher API rate limits',
      'Security event filtering, export & alerts',
      'SIEM webhook / event forwarding',
      'Multi-chain production support',
      'Priority technical support',
    ],
    cta: 'Get Scale',
    ctaTo: '/sign-in',
  },
  {
    id: 'business',
    name: 'Business',
    price: '$1,999',
    priceUnit: '/month',
    audience: 'High-volume platforms & B2B infrastructure',
    outbound: '$25M',
    wallets: '25,000',
    apiCalls: '25M',
    team: 25,
    features: [
      'Custom rate limits',
      'Custom trading & risk thresholds',
      'Dedicated Slack / Telegram support',
      'Quarterly security & ops review',
      'Financial reconciliation & billing reports',
      'Production incident priority response + SLA options',
    ],
    cta: 'Get Business',
    ctaTo: '/sign-in',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    priceUnit: '',
    audience: 'Exchanges, large wallets, financial institutions',
    outbound: 'Custom',
    wallets: 'Custom',
    apiCalls: 'Custom',
    team: 'Custom',
    features: [
      'Custom outbound volume & rate terms',
      'Custom wallet, API, team & project limits',
      'Dedicated environment or private deployment',
      'Custom SLA & customer success coverage',
      'Custom chain support',
      'Compliance, audit & operations reporting',
    ],
    cta: 'Contact sales',
    ctaTo: 'mailto:sales@sofa.one?subject=SOFA%20ONE%20Enterprise%20pricing',
    external: true,
  },
];

const OPENFORT_KEY = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
const OPENFORT_SHIELD_KEY = import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY;
const HAS_OPENFORT_CONFIG = Boolean(OPENFORT_KEY && OPENFORT_SHIELD_KEY);

const OUTBOUND_TIERS: readonly { range: string; rate: string }[] = [
  { range: '$0 – $500K', rate: '0.0100%' },
  { range: '$500K – $2M', rate: '0.0075%' },
  { range: '$2M – $10M', rate: '0.0050%' },
  { range: '$10M – $50M', rate: '0.0025%' },
  { range: '$50M – $200M', rate: '0.0015%' },
  { range: '$200M+', rate: '0.0010% and up' },
];

function formatCount(value: number | string): string {
  if (typeof value === 'string') return value;
  return value.toLocaleString('en-US');
}

function HeaderAuthAction() {
  const { isLoading, user } = useOpenfort();

  if (isLoading) {
    return (
      <span
        className="invisible rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-medium tracking-widest text-brand-text"
        aria-hidden="true"
      >
        SIGN IN
      </span>
    );
  }

  if (user) {
    return null;
  }

  return (
    <Link
      to="/sign-in"
      className="rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-medium tracking-widest text-brand-text transition-all hover:border-brand-text hover:bg-brand-surface"
    >
      SIGN IN
    </Link>
  );
}

function PlanCard({ plan }: { plan: PricingPlan }) {
  const isRecommended = plan.recommended === true;
  const isEnterprise = plan.id === 'enterprise';

  const cardClasses = [
    'relative flex flex-col rounded-3xl border p-6 transition-all duration-200',
    'bg-white/80 backdrop-blur-sm',
    isRecommended
      ? 'border-brand-accent shadow-xl ring-1 ring-brand-accent'
      : 'border-brand-border hover:border-brand-accent/60 hover:shadow-lg',
  ].join(' ');

  const ctaClasses = [
    'mt-6 inline-flex w-full items-center justify-center rounded-full px-6 py-3 text-sm font-medium tracking-widest transition-all',
    'bg-brand-text text-white hover:bg-black/90',
    'focus:outline-none focus:ring-2 focus:ring-brand-accent focus:ring-offset-2',
  ].join(' ');

  const ctaContent = (
    <>
      {isEnterprise && <Mail className="mr-2 h-4 w-4" aria-hidden="true" />}
      {plan.cta}
    </>
  );

  return (
    <article className={cardClasses}>
      {isRecommended && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-accent px-4 py-1 text-xs font-semibold tracking-wide text-white shadow-sm">
          Most popular
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-serif text-2xl font-medium text-brand-text">{plan.name}</h3>
          <p className="mt-1 text-sm leading-relaxed text-brand-muted">{plan.audience}</p>
        </div>
        <div className="text-right">
          <p className="font-serif text-3xl font-medium text-brand-text">{plan.price}</p>
          {plan.priceUnit && (
            <p className="text-xs font-medium text-brand-muted">{plan.priceUnit}</p>
          )}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-brand-border bg-brand-bg/60 p-3">
          <Zap className="h-4 w-4 text-brand-accent" aria-hidden="true" />
          <p className="mt-2 text-xs font-bold uppercase tracking-wider text-brand-muted">
            Outbound
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold text-brand-text">{plan.outbound}</p>
          <p className="text-[10px] text-brand-muted">/mo</p>
        </div>
        <div className="rounded-2xl border border-brand-border bg-brand-bg/60 p-3">
          <Wallet className="h-4 w-4 text-brand-accent" aria-hidden="true" />
          <p className="mt-2 text-xs font-bold uppercase tracking-wider text-brand-muted">
            Wallets
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold text-brand-text">
            {formatCount(plan.wallets)}
          </p>
          <p className="text-[10px] text-brand-muted">active</p>
        </div>
        <div className="rounded-2xl border border-brand-border bg-brand-bg/60 p-3">
          <Activity className="h-4 w-4 text-brand-accent" aria-hidden="true" />
          <p className="mt-2 text-xs font-bold uppercase tracking-wider text-brand-muted">API</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-brand-text">
            {formatCount(plan.apiCalls)}
          </p>
          <p className="text-[10px] text-brand-muted">calls/mo</p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-brand-muted">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Team seats: {formatCount(plan.team)}</span>
      </div>

      <ul className="mt-5 flex-1 space-y-2.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-brand-text">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
            <span className="leading-snug">{feature}</span>
          </li>
        ))}
      </ul>

      {plan.external ? (
        <a
          href={plan.ctaTo}
          className={ctaClasses}
          aria-label={`${plan.cta} for SOFA ONE Enterprise`}
        >
          {ctaContent}
        </a>
      ) : (
        <Link to={plan.ctaTo} className={ctaClasses} aria-label={`${plan.cta} on SOFA ONE`}>
          {ctaContent}
        </Link>
      )}
    </article>
  );
}

export default function PricingPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const fromBilling = location.state?.fromBilling === true;

  return (
    <div className="min-h-screen bg-brand-bg text-brand-text antialiased selection:bg-brand-accent selection:text-white">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
        <Link
          to="/"
          className="font-serif text-xl font-medium tracking-tight text-brand-text transition-colors hover:text-brand-accent"
        >
          SOFA ONE
        </Link>
        <div className="flex items-center gap-4">
          {fromBilling && (
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-text transition-colors hover:text-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent focus:ring-offset-2"
              aria-label="Back to Billing"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </button>
          )}
          {HAS_OPENFORT_CONFIG ? (
            <AuthProviders>
              <HeaderAuthAction />
            </AuthProviders>
          ) : (
            <Link
              to="/sign-in"
              className="rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-medium tracking-widest text-brand-text transition-all hover:border-brand-text hover:bg-brand-surface"
            >
              SIGN IN
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-20">
        <section className="py-12 text-center md:py-16">
          <h1 className="mx-auto max-w-3xl font-serif text-4xl font-normal leading-tight tracking-tight text-brand-text md:text-5xl">
            Simple pricing for secure, <br className="hidden md:block" />
            <span className="italic text-brand-accent">server-side signing</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg font-light leading-relaxed text-brand-muted">
            Low monthly subscription + generous free outbound volume. Pay only for what you use
            beyond your plan, with marginal rates that drop as volume grows.
          </p>
        </section>

        <section aria-label="Pricing plans" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </section>

        <section className="mt-16 grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl border border-brand-border bg-white/80 p-6 backdrop-blur-sm sm:p-8">
            <h2 className="font-serif text-2xl font-medium text-brand-text">
              Usage billing at a glance
            </h2>
            <p className="mt-3 text-sm leading-7 text-brand-muted">
              Your monthly bill starts with the plan fee. Outbound volume beyond the included
              allowance is charged using the marginal tiers on this page — each tier only applies to
              volume inside that band, so scaling up never raises your whole bill retroactively.
            </p>
            <p className="mt-3 text-sm leading-7 text-brand-muted">
              Each plan includes a fixed monthly API request limit. Requests that reach or exceed
              the limit are rejected with HTTP 429 — there is no per-call overage. Active wallets
              over the plan limit are billed at $0.01 per wallet per month. Team member seats beyond
              the included count are billed on Enterprise custom terms.
            </p>
          </div>

          <div className="rounded-3xl border border-brand-border bg-white/80 p-6 backdrop-blur-sm sm:p-8">
            <h2 className="font-serif text-2xl font-medium text-brand-text">
              Outbound overage tiers
            </h2>
            <p className="mt-3 text-sm text-brand-muted">
              Applied to billable outbound volume after your plan allowance.
            </p>
            <div className="mt-5 overflow-hidden rounded-2xl border border-brand-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-brand-bg">
                  <tr className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                    <th className="px-4 py-3">Billable outbound / month</th>
                    <th className="px-4 py-3 text-right">Marginal rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-border">
                  {OUTBOUND_TIERS.map((tier) => (
                    <tr key={tier.range} className="transition-colors hover:bg-brand-bg/50">
                      <td className="px-4 py-3 text-brand-text">{tier.range}</td>
                      <td className="px-4 py-3 text-right font-mono text-brand-muted">
                        {tier.rate}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="mt-12 text-center">
          <p className="text-sm text-brand-muted">
            Questions?{' '}
            <a
              href="mailto:sales@sofa.one?subject=SOFA%20ONE%20pricing%20question"
              className="font-medium text-brand-accent underline underline-offset-4 transition-colors hover:text-brand-accent-hover"
            >
              Contact our sales team
            </a>{' '}
            for Enterprise terms or volume commitments.
          </p>
        </section>
      </main>
    </div>
  );
}
