/**
 * Stripe Basil-compatible subscription period bounds.
 *
 * Prefer `items.data[0].current_period_start/end` (Basil item-scoped periods).
 * Fall back to top-level `current_period_start/end` for older payload shapes.
 *
 * Mid-month create with future `billing_cycle_anchor` + `proration_behavior:none`:
 * first item period is typically [create_time, anchor) — start is NOT the anchor.
 * The frozen auto-subscription effective window is the first full UTC month that
 * begins at the anchor; do not require item start === anchor.
 */

export type StripePeriodBounds = { startSec: number; endSec: number };

type PeriodCarrier = {
  current_period_start?: unknown;
  current_period_end?: unknown;
  items?: { data?: Array<PeriodCarrier> };
};

export function readStripeSubscriptionPeriodBounds(
  sub: PeriodCarrier | null | undefined,
): StripePeriodBounds | null {
  if (!sub) return null;
  const item = sub.items?.data?.[0];
  const fromItem = asPeriodPair(item?.current_period_start, item?.current_period_end);
  if (fromItem) return fromItem;
  return asPeriodPair(sub.current_period_start, sub.current_period_end);
}

export function stripePeriodBoundsToDates(
  bounds: StripePeriodBounds,
): { start: Date; end: Date } {
  return {
    start: new Date(bounds.startSec * 1000),
    end: new Date(bounds.endSec * 1000),
  };
}

function asPeriodPair(start: unknown, end: unknown): StripePeriodBounds | null {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    end <= start
  ) {
    return null;
  }
  return { startSec: start, endSec: end };
}
