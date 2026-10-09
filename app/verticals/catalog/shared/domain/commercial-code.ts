import { Schema } from 'effect';

/** Commercial codes are not Product identity, physical serials, or external record IDs. */
export type SkuTarget =
  | { readonly kind: 'VARIANT'; readonly tenantId: string; readonly variantId: string }
  | { readonly kind: 'PACKAGE_OPTION'; readonly packageDefinitionId: string; readonly tenantId: string };

/** A package level can carry a GTIN without becoming a selectable Package Option. */
export type GtinTarget =
  | { readonly kind: 'VARIANT'; readonly tenantId: string; readonly variantId: string }
  | { readonly kind: 'PACKAGE_LEVEL'; readonly packageDefinitionId: string; readonly tenantId: string };

export interface SkuAssignment {
  /** Only a documented mistake can be corrected; it is never ordinary code reuse. */
  readonly attribution: 'LEGITIMATE' | 'DOCUMENTED_ERROR';
  readonly code: string;
  readonly state: 'CURRENT' | 'HISTORICAL';
  readonly target: SkuTarget;
}

export interface GtinAssignment {
  readonly attribution: 'CONFIRMED' | 'UNCONFIRMED' | 'DISPUTED';
  readonly code: string;
  readonly target: GtinTarget;
}

export type CodeDecision =
  | { readonly status: 'VALID' }
  | { readonly reason: string; readonly status: 'INVALID' }
  | { readonly reason: string; readonly status: 'CONFLICT' };

/**
 * Canonical SKU comparison uses ECMAScript trim and default Unicode uppercase.
 * The database must persist this result under bytewise collation; PostgreSQL
 * upper(btrim(code)) is not equivalent for whitespace or Unicode casing.
 * Interior characters and leading zeroes remain significant.
 */
export const normalizeSku = (code: string): string => code.trim().toUpperCase();

/** PostgreSQL length(text) counts Unicode code points, not UTF-16 code units. */
export const isValidSkuCode = (code: string): boolean => {
  const normalized = normalizeSku(code);
  const length = normalized.match(/[\s\S]/gu)?.length ?? 0;
  return length >= 1 && length <= 240;
};

/** Stable, collision-safe tenant/namespace key; callers must enforce it atomically at persistence. */
export const skuUniquenessKey = (tenantId: string, code: string): string => {
  const normalized = normalizeSku(code);
  return `${tenantId.length}:${tenantId}:SKU:${normalized.length}:${normalized}`;
};

const sameSkuTarget = (left: SkuTarget, right: SkuTarget): boolean => {
  if (left.tenantId !== right.tenantId || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'VARIANT' && right.kind === 'VARIANT') {
    return left.variantId === right.variantId;
  }
  if (left.kind === 'PACKAGE_OPTION' && right.kind === 'PACKAGE_OPTION') {
    return left.packageDefinitionId === right.packageDefinitionId;
  }
  return false;
};

const hasTargetId = (target: SkuTarget | GtinTarget): boolean =>
  (target.kind === 'VARIANT' ? target.variantId : target.packageDefinitionId).trim().length > 0;

/** Evaluate against all retained assignments, including retired targets and historical codes. */
export const assessSkuAssignment = (
  candidate: Pick<SkuAssignment, 'code' | 'target'>,
  retained: readonly SkuAssignment[],
): CodeDecision => {
  if (
    !isValidSkuCode(candidate.code) ||
    candidate.target.tenantId.trim().length === 0 ||
    !hasTargetId(candidate.target)
  ) {
    return { reason: 'SKU, Tenant, and exact target are required', status: 'INVALID' };
  }
  const key = skuUniquenessKey(candidate.target.tenantId, candidate.code);
  const candidateTenantId = candidate.target.tenantId;
  for (const assignment of retained) {
    const assignmentTenantId = assignment.target.tenantId;
    if (assignmentTenantId !== candidateTenantId) {
      continue;
    }
    if (
      assignment.state === 'CURRENT' &&
      sameSkuTarget(assignment.target, candidate.target) &&
      skuUniquenessKey(assignmentTenantId, assignment.code) !== key
    ) {
      return {
        reason: 'Target already has a Current SKU; change it by retaining the old code as historical',
        status: 'CONFLICT',
      };
    }
    if (
      skuUniquenessKey(assignmentTenantId, assignment.code) === key &&
      !sameSkuTarget(assignment.target, candidate.target)
    ) {
      return { reason: 'SKU is already retained for another target', status: 'CONFLICT' };
    }
  }
  return { status: 'VALID' };
};

/** A documented error needs evidence and historical preservation, never a silent reassignment. */
export const assessSkuCorrection = (
  previous: SkuAssignment,
  correctedTarget: SkuTarget,
  evidenceReference: string,
): CodeDecision => {
  if (previous.attribution !== 'DOCUMENTED_ERROR' || evidenceReference.trim().length === 0) {
    return { reason: 'Only a documented error with evidence can change the target', status: 'INVALID' };
  }
  if (previous.target.tenantId !== correctedTarget.tenantId) {
    return { reason: 'A correction cannot cross Tenants', status: 'INVALID' };
  }
  return { status: 'VALID' };
};

const GtinFormatSchema = Schema.Literals(['GTIN_8', 'GTIN_12', 'GTIN_13', 'GTIN_14']);
export type GtinFormat = typeof GtinFormatSchema.Type;

const gtinFormat = (length: number): GtinFormat | undefined => {
  switch (length) {
    case 8: {
      return 'GTIN_8';
    }
    case 12: {
      return 'GTIN_12';
    }
    case 13: {
      return 'GTIN_13';
    }
    case 14: {
      return 'GTIN_14';
    }
    default: {
      return undefined;
    }
  }
};

/**
 * GS1 General Specifications 26.0.0 (January 2026),
 * https://ref.gs1.org/standards/genspecs/: this Catalog boundary accepts only
 * GTIN-8, GTIN-12, GTIN-13, and GTIN-14 digit strings and checks their GS1
 * modulo-10 check digit. `commercial-code.test.ts` covers all four formats,
 * a bad check digit, surrounding whitespace, and non-digits. This formal
 * check does not prove attribution, allocation, or broader GS1 compliance.
 * No SKU trimming or case normalization applies here.
 */
export const validateGtin = (
  code: string,
):
  | { readonly format: GtinFormat; readonly status: 'VALID' }
  | {
      readonly reason: string;
      readonly status: 'INVALID';
    } => {
  const format = gtinFormat(code.length);
  if (format === undefined || !/^\d+$/u.test(code)) {
    return { reason: 'GTIN must contain exactly 8, 12, 13, or 14 digits', status: 'INVALID' };
  }
  let sum = 0;
  for (let index = code.length - 2, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[index]) * weight;
  }
  if ((10 - (sum % 10)) % 10 !== Number(code.at(-1))) {
    return { reason: 'GTIN check digit is invalid', status: 'INVALID' };
  }
  return { format, status: 'VALID' };
};

/** Formal validity cannot confirm which exact trade item or packaging level owns the number. */
export const assessGtinAssignment = (assignment: GtinAssignment): CodeDecision => {
  const format = validateGtin(assignment.code);
  if (format.status === 'INVALID') {
    return format;
  }
  if (assignment.target.tenantId.trim().length === 0 || !hasTargetId(assignment.target)) {
    return { reason: 'Tenant and exact target are required', status: 'INVALID' };
  }
  if (assignment.attribution !== 'CONFIRMED') {
    return { reason: 'The exact trade item or packaging level is not confirmed', status: 'INVALID' };
  }
  return { status: 'VALID' };
};
