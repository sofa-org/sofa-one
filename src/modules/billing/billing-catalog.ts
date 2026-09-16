import type { PlanId } from './billing-calculator';

/**
 * Plan catalog metadata (description + features) sourced from PRICING.md
 * section 5. Monetary values and allowances live in the calculator's PLANS;
 * this file only carries the human-facing marketing copy and the published
 * per-plan API overage rates (PRICING.md §7).
 *
 * API calls beyond the included monthly allowance continue to succeed and are
 * billed at the plan's per-call overage rate. Infrastructure throttling can
 * still return HTTP 429 independently of billing overage. Active wallets remain
 * overage-billed at $0.01/wallet/month.
 */
export interface PlanCatalogEntry {
  readonly description: string;
  readonly features: readonly string[];
}

/** Per-call API overage rates in microdollars (PRICING.md §7). Enterprise is custom. */
export const PLAN_API_OVERAGE_RATE_MICROS: Readonly<
  Record<Exclude<PlanId, 'enterprise'>, bigint>
> = {
  free: 2_000n, // $0.002 / call
  starter: 1_500n, // $0.0015 / call
  growth: 1_000n, // $0.001 / call
  scale: 750n, // $0.00075 / call
  business: 500n, // $0.0005 / call
};

const OVERAGE_NOTE_WALLET = 'Wallet overage rate: $0.01/wallet/month';

function apiOverageNote(planId: Exclude<PlanId, 'enterprise'>): string {
  const micros = PLAN_API_OVERAGE_RATE_MICROS[planId];
  // 1_000_000 micros = $1; rates are whole microdollars so format without float math.
  const dollars = Number(micros) / 1_000_000;
  const rendered =
    dollars >= 0.01 ? dollars.toFixed(2) : dollars.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return `API overage rate: $${rendered}/call (requests beyond the included allowance continue and are charged)`;
}

export const PLAN_CATALOG: Record<PlanId, PlanCatalogEntry> = {
  free: {
    description: 'For individual developers, hackathons, testnet projects, and early demos.',
    features: [
      'Basic wallet creation and management',
      'Basic API key creation, revocation, and rotation',
      'Testnet-first, with limited mainnet access',
      'Basic transaction status queries',
      'Community or documentation support',
      'Standard rate limits',
      apiOverageNote('free'),
      OVERAGE_NOTE_WALLET,
    ],
  },
  starter: {
    description: 'For small applications moving into production.',
    features: [
      'Mainnet production use',
      'Higher wallet, API, and outbound volume allowances',
      'Basic webhooks',
      'Basic audit logs',
      'Basic IP allowlist',
      'Email support',
      'Standard security event logging',
      apiOverageNote('starter'),
      OVERAGE_NOTE_WALLET,
    ],
  },
  growth: {
    description: 'For applications with real users that need stable operations.',
    features: [
      'Multi-project / multi-environment management',
      'More comprehensive API key permission configuration',
      'Webhook retries and failure records',
      'Advanced transaction limit configuration',
      'User, wallet, and API key freeze controls',
      'Longer audit log retention',
      'Priority support during business hours',
      apiOverageNote('growth'),
      OVERAGE_NOTE_WALLET,
    ],
  },
  scale: {
    description: 'For growing wallets, protocol teams, and agent platforms.',
    features: [
      'Advanced risk-control rules',
      'Higher API rate limits',
      'Security event filtering, export, and alerts',
      'SIEM webhook or security-event forwarding',
      'Multi-chain production support',
      'Longer idempotency windows and transaction tracking',
      'Priority technical support',
      apiOverageNote('scale'),
      OVERAGE_NOTE_WALLET,
    ],
  },
  business: {
    description:
      'For high-volume platforms, B2B wallet infrastructure customers, and treasury management use cases.',
    features: [
      'Custom rate limits',
      'Custom transaction strategies and risk-control thresholds',
      'Dedicated Slack / Telegram support',
      'Regular security and operations reviews',
      'Longer audit log retention',
      'Financial reconciliation and billing report support',
      'Priority response to production incidents',
      'SLA options',
      apiOverageNote('business'),
      OVERAGE_NOTE_WALLET,
    ],
  },
  enterprise: {
    description:
      'For exchanges, large wallets, payment platforms, financial institutions, and organizations requiring dedicated compliance support.',
    features: [
      'Custom outbound volume allowances and rates',
      'Custom wallet, API, team member, and project allowances',
      'Dedicated environment or private deployment',
      'Dedicated SLA',
      'Dedicated customer success and security response window',
      'Custom chain support',
      'Security audit support',
      'Compliance, financial, and operational reports',
      'Dedicated risk-control strategies and approval workflows',
      'API overage rate: custom (requests beyond the included allowance continue and are charged)',
      OVERAGE_NOTE_WALLET,
    ],
  },
};
