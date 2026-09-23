import { Schema } from 'effect';

/** Purchase Quantity only. Attribute measurements and configuration values do not use this rule. */
export interface PurchaseUnitRule {
  readonly revision: number;
  readonly rounding: 'UP' | 'DOWN' | 'HALF_UP' | null;
  readonly step: string;
  readonly tenantId: string;
  readonly unitId: string;
}

export interface PurchaseQuantityRequest {
  readonly amount: string;
  readonly divisible: boolean;
  readonly targetId: string;
  readonly tenantId: string;
  readonly unitId: string;
}

const QuantityPhaseSchema = Schema.Literals(['PREPARE', 'APPROVED', 'COMMITTING']);
export type QuantityPhase = typeof QuantityPhaseSchema.Type;

export type QuantityNormalization =
  | {
      readonly changed: boolean;
      readonly notice: 'ROUNDED' | null;
      readonly requested: string;
      readonly resulting: string;
      readonly rounding: NonNullable<PurchaseUnitRule['rounding']>;
      readonly status: 'VALID';
      readonly step: string;
      readonly targetId: string;
      readonly tenantId: string;
      readonly unitId: string;
      readonly unitRuleRevision: number;
    }
  | {
      readonly reason: string;
      readonly status: 'INVALID' | 'UNVERIFIABLE' | 'REPREPARE_REQUIRED';
    };

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

const parsePositiveDecimal = (value: string): Decimal | null => {
  if (!decimalPattern.test(value)) {
    return null;
  }
  const [whole = '', fraction = ''] = value.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (scale === 0) {
    return coefficient.toString();
  }
  const padded = coefficient.toString().padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
};

const roundedIncrementCount = (
  quotient: bigint,
  remainder: bigint,
  increment: bigint,
  rounding: 'UP' | 'DOWN' | 'HALF_UP',
): bigint => {
  if (rounding === 'UP') {
    return quotient + 1n;
  }
  if (rounding === 'DOWN') {
    return quotient;
  }
  return quotient + (remainder * 2n >= increment ? 1n : 0n);
};

const hasQuantityIdentity = (request: PurchaseQuantityRequest): boolean =>
  request.tenantId.length > 0 && request.unitId.length > 0 && request.targetId.length > 0;

const hasValidRule = (rule: PurchaseUnitRule, step: Decimal | null): boolean =>
  step !== null &&
  Number.isSafeInteger(rule.revision) &&
  rule.revision > 0 &&
  (rule.rounding === 'UP' || rule.rounding === 'DOWN' || rule.rounding === 'HALF_UP');

/** Exact integer arithmetic: no binary floating-point conversion or implicit rounding. */
export const normalizePurchaseQuantity = (
  request: PurchaseQuantityRequest,
  rule: PurchaseUnitRule,
  phase: QuantityPhase,
): QuantityNormalization => {
  const amount = parsePositiveDecimal(request.amount);
  if (amount === null) {
    return { reason: 'Purchase quantity must be a positive finite decimal', status: 'INVALID' };
  }
  if (!hasQuantityIdentity(request)) {
    return { reason: 'Quantity requires Tenant, Unit, and target identity', status: 'INVALID' };
  }
  if (request.tenantId !== rule.tenantId || request.unitId !== rule.unitId) {
    return { reason: 'Unit rule does not identify the requested Tenant and Unit', status: 'UNVERIFIABLE' };
  }
  const step = parsePositiveDecimal(rule.step);
  const { rounding } = rule;
  if (!hasValidRule(rule, step) || step === null || rounding === null) {
    return { reason: 'A valid versioned Unit step and rounding rule are required', status: 'UNVERIFIABLE' };
  }
  if (!request.divisible && amount.scale !== 0 && amount.coefficient % 10n ** BigInt(amount.scale) !== 0n) {
    return { reason: 'An indivisible target requires a whole quantity', status: 'INVALID' };
  }

  const scale = Math.max(amount.scale, step.scale);
  const requested = amount.coefficient * 10n ** BigInt(scale - amount.scale);
  const increment = step.coefficient * 10n ** BigInt(scale - step.scale);
  const quotient = requested / increment;
  const remainder = requested % increment;
  let resulting = requested;
  if (remainder !== 0n) {
    if (!request.divisible) {
      return { reason: 'An indivisible target is off its Unit step', status: 'INVALID' };
    }
    resulting = roundedIncrementCount(quotient, remainder, increment, rounding) * increment;
  }
  if (resulting <= 0n) {
    return { reason: 'Normalization would remove the purchase line', status: 'INVALID' };
  }
  if (resulting !== requested && phase !== 'PREPARE') {
    return { reason: 'Approved or committing quantity cannot be changed in place', status: 'REPREPARE_REQUIRED' };
  }
  return {
    changed: resulting !== requested,
    notice: resulting === requested ? null : 'ROUNDED',
    requested: formatDecimal(requested, scale),
    resulting: formatDecimal(resulting, scale),
    rounding,
    status: 'VALID',
    step: formatDecimal(step.coefficient, step.scale),
    targetId: request.targetId,
    tenantId: request.tenantId,
    unitId: request.unitId,
    unitRuleRevision: rule.revision,
  };
};
