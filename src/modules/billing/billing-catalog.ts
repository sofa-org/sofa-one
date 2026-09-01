import type { PlanId } from './billing-calculator';

/**
 * Plan catalog metadata (description + features) sourced from PRICING.md
 * section 5. Monetary values and allowances live in the calculator's PLANS;
 * this file only carries the human-facing marketing copy.
 *
 * Resource overage rates are the accepted Phase 1 values: API calls at
 * $0.001/call and active wallets at $0.01/wallet/month (PRICING.md §7).
 */
export interface PlanCatalogEntry {
  readonly description: string;
  readonly features: readonly string[];
}

const OVERAGE_NOTE_API = 'API overage rate: $0.001/call';
const OVERAGE_NOTE_WALLET = 'Wallet overage rate: $0.01/wallet/month';

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
      OVERAGE_NOTE_API,
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
      OVERAGE_NOTE_API,
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
      OVERAGE_NOTE_API,
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
      OVERAGE_NOTE_API,
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
      OVERAGE_NOTE_API,
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
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
};
