import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PLANS, type BillingPlanConfig } from './billing-calculator';

type PlanVersion = Prisma.BillingPlanVersionGetPayload<Record<string, never>>;

/** Validate persisted plan terms without importing either billing service. */
export function validatePlanVersion(planVersion: PlanVersion): BillingPlanConfig {
  const code = planVersion.code;
  if (!Object.prototype.hasOwnProperty.call(PLANS, code)) {
    throw new ConflictException(`Plan code is not supported: ${String(code)}`);
  }
  const config = PLANS[code as keyof typeof PLANS];
  assertNonNegativeBigint(planVersion.apiOverageRateMicros, 'apiOverageRateMicros', code);
  assertNonNegativeBigint(planVersion.walletOverageRateMicros, 'walletOverageRateMicros', code);
  if (typeof planVersion.version !== 'number' || !Number.isSafeInteger(planVersion.version) || planVersion.version < 0) {
    throw new ConflictException(`Plan terms are invalid: ${code}.version`);
  }
  if (config.id === 'enterprise') {
    if (planVersion.monthlyFeeMicros !== null || planVersion.includedOutboundMicros !== null ||
        planVersion.includedWallets !== null || planVersion.includedApiCalls !== null) {
      throw new ConflictException('Enterprise plan terms are malformed');
    }
  } else {
    assertNonNegativeBigint(planVersion.monthlyFeeMicros, 'monthlyFeeMicros', code);
    assertNonNegativeBigint(planVersion.includedOutboundMicros, 'includedOutboundMicros', code);
    assertNonNegativeSafeInt(planVersion.includedWallets, 'includedWallets', code);
    assertNonNegativeBigint(planVersion.includedApiCalls, 'includedApiCalls', code);
    if (planVersion.includedApiCalls > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConflictException(`Plan terms are invalid: ${code}.includedApiCalls`);
    }
  }
  return config;
}

function assertNonNegativeBigint(value: unknown, field: string, code: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new ConflictException(`Plan terms are invalid: ${code}.${field}`);
}

function assertNonNegativeSafeInt(value: unknown, field: string, code: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConflictException(`Plan terms are invalid: ${code}.${field}`);
  }
}

export function validAssignmentWhere(at: Date): Prisma.BillingPlanAssignmentWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] };
}

export function isAssignmentEntitlementValid(
  assignment: { expiresAt: Date | null; source: string | null },
  plan: { monthlyFeeMicros: bigint | null; code: string } | null | undefined,
  at: Date,
): boolean {
  if (!plan) return false;
  const fee = plan.monthlyFeeMicros ?? 0n;
  if (assignment.expiresAt != null) return assignment.expiresAt.getTime() > at.getTime();
  // Open-ended (null expiresAt) is only allowed for zero-fee rows. Paid plans
  // without a bound never grant indefinite access. Zero-fee unknown codes are
  // still returned so callers can fail closed via validatePlanVersion.
  if (fee > 0n) return false;
  return true;
}
