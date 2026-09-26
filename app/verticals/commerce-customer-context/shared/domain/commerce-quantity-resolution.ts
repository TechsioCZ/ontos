/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, effect-native/no-sync-schema-codec, effect-native/no-unbranded-identifier-schema, effect-native/prefer-match-over-tag-switch, eslint/default-case, eslint/no-nested-ternary, eslint/prefer-destructuring, react-doctor/js-cache-property-access, react-doctor/js-combine-iterations, sonarjs/too-many-break-or-continue-in-loop, typescript/array-type, typescript/consistent-return, typescript/no-unsafe-type-assertion, unicorn/no-array-reduce, unicorn/no-array-sort, unicorn/switch-case-braces -- This pure, schema-validated resolver is the explicit policy decision table; tracked in: #333; remove-when: the resolver is generated from the approved quantity-policy contract. */
import { Schema } from 'effect';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import type {
  CurrentCommerceQuantityAssignment,
  CurrentCommerceQuantityPolicySet,
} from './customer-commerce-policy-administration.ts';
import type {
  CommerceQuantityBasis,
  CommerceQuantityPolicyScope,
  CommerceQuantitySelector,
  ExactPositiveCommerceQuantity,
  QuantityEnvelope,
} from './customer-commerce-policy.ts';
import {
  CommerceQuantityBasisSchema,
  CustomerCommercePolicyChannelIdSchema,
  CustomerCommercePolicyCommerceMarketIdSchema,
  CustomerCommercePolicyInstantSchema,
  CustomerCommercePolicySellingLegalEntityIdSchema,
  CustomerCommercePolicyStorefrontIdSchema,
  CustomerCommercePolicyTenantIdSchema,
  ExactPositiveCommerceQuantitySchema,
  QuantityEnvelopeSchema,
} from './customer-commerce-policy.ts';
import { CommerceQuantityCatalogLineRequestSchema } from './commerce-quantity-catalog-port.ts';
import type {
  CurrentCommerceQuantityCatalogLine,
  CurrentCommerceQuantityCatalogSelection,
} from './commerce-quantity-catalog-port.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const exactPositiveQuantity = Schema.decodeUnknownSync(ExactPositiveCommerceQuantitySchema);
const sameCatalogSelection = Schema.toEquivalence(CatalogSelectionSchema);

const CommerceQuantityPurchasingContextSchema = Schema.Struct({
  channelId: CustomerCommercePolicyChannelIdSchema,
  commerceMarketId: CustomerCommercePolicyCommerceMarketIdSchema,
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
  storefrontId: CustomerCommercePolicyStorefrontIdSchema,
  tenantId: CustomerCommercePolicyTenantIdSchema,
});
type CommerceQuantityPurchasingContext = typeof CommerceQuantityPurchasingContextSchema.Type;

const CommerceQuantityResolutionSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('GUEST') }),
  Schema.Struct({ kind: Schema.Literal('RETAIL'), profileRef: RetailCustomerProfileRefSchema }),
  Schema.Struct({ kind: Schema.Literal('COUNTERPARTY'), profileRef: CounterpartyPurchasingProfileRefSchema }),
]);
export type CommerceQuantityResolutionSubject = typeof CommerceQuantityResolutionSubjectSchema.Type;

export const CommerceQuantityResolutionRequestSchema = Schema.Struct({
  at: CustomerCommercePolicyInstantSchema,
  lines: Schema.Array(CommerceQuantityCatalogLineRequestSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  purchasingContext: CommerceQuantityPurchasingContextSchema,
  subject: CommerceQuantityResolutionSubjectSchema,
}).check(
  Schema.makeFilter(({ lines, purchasingContext, subject }) => {
    const lineTenantsMatch = lines.every(
      ({ selection }) => selection.productRef.tenantId === purchasingContext.tenantId,
    );
    const profileTenantMatches = subject.kind === 'GUEST' || subject.profileRef.tenantId === purchasingContext.tenantId;
    return lineTenantsMatch && profileTenantMatches
      ? undefined
      : 'Quantity request, Catalog Selections, and Profile must belong to the purchasing Tenant';
  }),
);
type CommerceQuantityResolutionRequest = typeof CommerceQuantityResolutionRequestSchema.Type;

const CommerceQuantityConstraintEvidenceSchema = Schema.Struct({
  envelope: QuantityEnvelopeSchema,
  ruleRevisionId: stableReference,
});

const CommerceQuantityLineEvidenceSchema = Schema.Struct({
  basis: CommerceQuantityBasisSchema,
  catalogCompleteness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  catalogHierarchyRevision: stableReference,
  catalogOwnerRevision: stableReference,
  constraints: Schema.Array(CommerceQuantityConstraintEvidenceSchema),
  equivalentSelectionKey: stableReference,
  lineIds: Schema.Array(stableReference),
  normalizedQuantity: ExactPositiveCommerceQuantitySchema,
  requestedQuantity: ExactPositiveCommerceQuantitySchema,
  winningEnvelope: QuantityEnvelopeSchema,
  winningRuleRevisionId: stableReference,
});

export const CommerceQuantityPermittedSchema = Schema.TaggedStruct('COMMERCE_QUANTITY_PERMITTED', {
  assignmentCompleteness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  lines: Schema.Array(CommerceQuantityLineEvidenceSchema),
  observedAt: CustomerCommercePolicyInstantSchema,
  ruleCompleteness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
});

const CommerceQuantityRejectedSchema = Schema.TaggedStruct('COMMERCE_QUANTITY_REJECTED', {
  actualQuantity: ExactPositiveCommerceQuantitySchema,
  limit: ExactPositiveCommerceQuantitySchema,
  lineIds: Schema.Array(stableReference),
  reason: Schema.Literals([
    'NORMALIZATION_REQUIRED',
    'BELOW_MINIMUM',
    'ABOVE_MAXIMUM',
    'NOT_MULTIPLE',
    'PHYSICAL_NOT_MULTIPLE',
  ]),
});

const CommerceQuantityMissingSchema = Schema.TaggedStruct('MISSING_COMMERCE_QUANTITY_POLICY', {
  equivalentSelectionKey: stableReference,
  lineIds: Schema.Array(stableReference),
});

const CommerceQuantityConflictingSchema = Schema.TaggedStruct('INCONSISTENT_COMMERCE_QUANTITY_POLICY', {
  equivalentSelectionKey: stableReference,
  ruleRevisionIds: Schema.Array(stableReference),
});

const CommerceQuantityBrokenAssignmentSchema = Schema.TaggedStruct('BROKEN_COMMERCE_QUANTITY_ASSIGNMENT', {
  assignmentId: stableReference,
  ruleRevisionId: stableReference,
});

const CommerceQuantityUnverifiableSchema = Schema.TaggedStruct('COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', {
  reason: Schema.Literals([
    'CATALOG_LINE_SET_MISMATCH',
    'CATALOG_SELECTION_MISMATCH',
    'CATALOG_EVIDENCE_STALE',
    'POLICY_EVIDENCE_STALE',
    'CATALOG_BASIS_STALE',
    'EQUIVALENT_SELECTION_BASIS_CONFLICT',
  ]),
});

export const CommerceQuantityResolutionOutcomeSchema = Schema.Union([
  CommerceQuantityPermittedSchema,
  CommerceQuantityRejectedSchema,
  CommerceQuantityMissingSchema,
  CommerceQuantityConflictingSchema,
  CommerceQuantityBrokenAssignmentSchema,
  CommerceQuantityUnverifiableSchema,
]);
export type CommerceQuantityResolutionOutcome = typeof CommerceQuantityResolutionOutcomeSchema.Type;

export interface CommerceQuantityResolutionInput {
  readonly catalogLines: readonly CurrentCommerceQuantityCatalogLine[];
  readonly policy: CurrentCommerceQuantityPolicySet;
  readonly request: CommerceQuantityResolutionRequest;
}

type RuleCandidate = CurrentCommerceQuantityPolicySet['ruleSet']['candidates'][number];
type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

const decimal = (value: string): Decimal => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const align = (left: Decimal, right: Decimal): readonly [bigint, bigint, number] => {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
};

const compare = (left: string, right: string): -1 | 0 | 1 => {
  const [scaledLeft, scaledRight] = align(decimal(left), decimal(right));
  return scaledLeft < scaledRight ? -1 : scaledLeft > scaledRight ? 1 : 0;
};

const add = (left: string, right: string): ExactPositiveCommerceQuantity => {
  const [scaledLeft, scaledRight, scale] = align(decimal(left), decimal(right));
  const coefficient = scaledLeft + scaledRight;
  if (scale === 0) {
    return coefficient.toString() as ExactPositiveCommerceQuantity;
  }
  const padded = coefficient.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  return (fraction.length === 0 ? integer : `${integer}.${fraction}`) as ExactPositiveCommerceQuantity;
};

const isMultiple = (value: string, multiple: string): boolean => {
  const [scaledValue, scaledMultiple] = align(decimal(value), decimal(multiple));
  return scaledValue % scaledMultiple === 0n;
};

const refEquals = (
  left: Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }>,
  right: Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }>,
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const selectorMatches = (
  selector: CommerceQuantitySelector,
  selection: CurrentCommerceQuantityCatalogSelection,
): boolean => {
  switch (selector.kind) {
    case 'ALL':
      return true;
    case 'PRODUCT':
      return refEquals(selector.productRef, selection.catalogSelection.productRef);
    case 'VARIANT':
      return refEquals(selector.variantRef, selection.catalogSelection.variantRef);
    case 'PACKAGE_OPTION':
      return (
        selection.catalogSelection.packageOption !== undefined &&
        refEquals(selector.packageOptionRef, selection.catalogSelection.packageOption.optionRef)
      );
  }
};

const selectorRank = (selector: CommerceQuantitySelector): number => {
  switch (selector.kind) {
    case 'ALL':
      return 1;
    case 'PRODUCT':
      return 2;
    case 'VARIANT':
      return 3;
    case 'PACKAGE_OPTION':
      return 4;
  }
};

const scopeMatches = (scope: CommerceQuantityPolicyScope, context: CommerceQuantityPurchasingContext): boolean => {
  if (scope.sellingLegalEntityId !== context.sellingLegalEntityId || scope.channelId !== context.channelId) {
    return false;
  }
  if (scope.kind === 'CHANNEL_SELLER') {
    return true;
  }
  if (scope.commerceMarketId !== context.commerceMarketId) {
    return false;
  }
  return scope.kind === 'MARKET_CHANNEL_SELLER' || scope.storefrontId === context.storefrontId;
};

const scopeRank = (scope: CommerceQuantityPolicyScope): number =>
  scope.kind === 'STOREFRONT_MARKET_CHANNEL_SELLER' ? 3 : scope.kind === 'MARKET_CHANNEL_SELLER' ? 2 : 1;

const profileMatches = (
  assignment: CurrentCommerceQuantityAssignment,
  subject: CommerceQuantityResolutionSubject,
): boolean =>
  subject.kind !== 'GUEST' &&
  assignment.profile.kind === subject.kind &&
  refEquals(assignment.profile.profileRef, subject.profileRef);

const basisEquals = (left: CommerceQuantityBasis, right: CommerceQuantityBasis): boolean =>
  left.targetDivisibilityRevision === right.targetDivisibilityRevision &&
  left.unitRuleRevision === right.unitRuleRevision &&
  refEquals(left.targetRef, right.targetRef) &&
  refEquals(left.unitRef, right.unitRef);

const completenessCurrentAt = (
  evidence: CurrentCommerceQuantityPolicySet['ruleSet']['completeness'],
  at: string,
): boolean =>
  evidence.observedAt <= at &&
  (evidence.nextApplicabilityBoundary === undefined || at < evidence.nextApplicabilityBoundary);

const basisKey = (basis: CommerceQuantityBasis): string =>
  [
    basis.targetRef.moduleId,
    basis.targetRef.resourceType,
    basis.targetRef.resourceId,
    basis.targetDivisibilityRevision,
    basis.unitRef.moduleId,
    basis.unitRef.resourceType,
    basis.unitRef.resourceId,
    basis.unitRuleRevision,
  ].join('|');

const candidateAssignments = (
  candidate: RuleCandidate,
  assignments: readonly CurrentCommerceQuantityAssignment[],
): readonly CurrentCommerceQuantityAssignment[] =>
  assignments.filter(({ ruleRevisionRef }) => ruleRevisionRef.resourceId === candidate.policyRevisionId);

const candidateVisibleTo = (
  candidate: RuleCandidate,
  assignments: readonly CurrentCommerceQuantityAssignment[],
  subject: CommerceQuantityResolutionSubject,
): boolean => {
  const assigned = candidateAssignments(candidate, assignments);
  return assigned.length === 0 || assigned.some((assignment) => profileMatches(assignment, subject));
};

const assignmentRank = (
  candidate: RuleCandidate,
  assignments: readonly CurrentCommerceQuantityAssignment[],
  subject: CommerceQuantityResolutionSubject,
): number =>
  candidateAssignments(candidate, assignments).some((assignment) => profileMatches(assignment, subject)) ? 1 : 0;

const candidateRank = (
  candidate: RuleCandidate,
  assignments: readonly CurrentCommerceQuantityAssignment[],
  subject: CommerceQuantityResolutionSubject,
): readonly [number, number, number] => [
  selectorRank(candidate.value.selector),
  assignmentRank(candidate, assignments, subject),
  scopeRank(candidate.scope),
];

const compareRank = (left: readonly number[], right: readonly number[]): number => {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const lineSetMatches = (input: CommerceQuantityResolutionInput): boolean => {
  if (input.catalogLines.length !== input.request.lines.length) {
    return false;
  }
  return input.request.lines.every((requestLine) =>
    input.catalogLines.some(
      (catalogLine) =>
        catalogLine.lineId === requestLine.lineId &&
        sameCatalogSelection(catalogLine.selection.catalogSelection, requestLine.selection) &&
        catalogLine.selection.requestedQuantity === requestLine.requestedQuantity,
    ),
  );
};

const firstBrokenAssignment = (
  policy: CurrentCommerceQuantityPolicySet,
  subject: CommerceQuantityResolutionSubject,
): CurrentCommerceQuantityAssignment | undefined =>
  policy.assignmentSet.assignments.find(
    (assignment) =>
      profileMatches(assignment, subject) &&
      !policy.ruleSet.candidates.some(
        ({ policyRevisionId }) => policyRevisionId === assignment.ruleRevisionRef.resourceId,
      ),
  );

const applicableCandidates = (
  input: CommerceQuantityResolutionInput,
  selection: CurrentCommerceQuantityCatalogSelection,
): readonly RuleCandidate[] =>
  input.policy.ruleSet.candidates.filter(
    (candidate) =>
      candidateVisibleTo(candidate, input.policy.assignmentSet.assignments, input.request.subject) &&
      selectorMatches(candidate.value.selector, selection) &&
      scopeMatches(candidate.scope, input.request.purchasingContext),
  );

const violation = (
  quantity: ExactPositiveCommerceQuantity,
  envelope: QuantityEnvelope,
):
  | {
      readonly limit: ExactPositiveCommerceQuantity;
      readonly reason: 'ABOVE_MAXIMUM' | 'BELOW_MINIMUM' | 'NOT_MULTIPLE';
    }
  | undefined => {
  if (envelope.kind === 'NO_COMMERCIAL_QUANTITY_RESTRICTION') {
    return undefined;
  }
  if (envelope.minimum !== null && compare(quantity, envelope.minimum) < 0) {
    return { limit: exactPositiveQuantity(envelope.minimum), reason: 'BELOW_MINIMUM' };
  }
  if (envelope.maximum !== null && compare(quantity, envelope.maximum) > 0) {
    return { limit: exactPositiveQuantity(envelope.maximum), reason: 'ABOVE_MAXIMUM' };
  }
  return envelope.multiple !== null && !isMultiple(quantity, envelope.multiple)
    ? { limit: exactPositiveQuantity(envelope.multiple), reason: 'NOT_MULTIPLE' }
    : undefined;
};

/**
 * Resolves Current quantity rules only. Accepted Order history stores this returned evidence and
 * never calls this function again to reinterpret a prior decision.
 */
// oxlint-disable-next-line eslint/complexity -- Explicit fail-closed rule table; tracked in: #333; remove-when: generated from the approved quantity-policy contract.
export const resolveCommerceQuantity = (input: CommerceQuantityResolutionInput): CommerceQuantityResolutionOutcome => {
  if (!lineSetMatches(input)) {
    return { _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', reason: 'CATALOG_LINE_SET_MISMATCH' };
  }
  if (
    !completenessCurrentAt(input.policy.ruleSet.completeness, input.request.at) ||
    !completenessCurrentAt(input.policy.assignmentSet.completeness, input.request.at)
  ) {
    return { _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', reason: 'POLICY_EVIDENCE_STALE' };
  }
  const brokenAssignment = firstBrokenAssignment(input.policy, input.request.subject);
  if (brokenAssignment !== undefined) {
    return {
      _tag: 'BROKEN_COMMERCE_QUANTITY_ASSIGNMENT',
      assignmentId: brokenAssignment.assignmentId,
      ruleRevisionId: brokenAssignment.ruleRevisionRef.resourceId,
    };
  }

  const equivalentBasis = new Map<string, string>();
  for (const { selection } of input.catalogLines) {
    if (!completenessCurrentAt(selection.completeness, input.request.at)) {
      return { _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', reason: 'CATALOG_EVIDENCE_STALE' };
    }
    const knownBasis = equivalentBasis.get(selection.equivalentSelectionKey);
    const currentBasis = basisKey(selection.basis);
    if (knownBasis !== undefined && knownBasis !== currentBasis) {
      return { _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', reason: 'EQUIVALENT_SELECTION_BASIS_CONFLICT' };
    }
    equivalentBasis.set(selection.equivalentSelectionKey, currentBasis);
  }

  const groups = new Map<string, CurrentCommerceQuantityCatalogLine[]>();
  for (const line of input.catalogLines) {
    const current = groups.get(line.selection.equivalentSelectionKey) ?? [];
    current.push(line);
    groups.set(line.selection.equivalentSelectionKey, current);
  }
  const resolvedLines: Array<typeof CommerceQuantityLineEvidenceSchema.Type> = [];
  for (const [equivalentSelectionKey, lines] of groups) {
    const representative = lines[0];
    if (representative === undefined) {
      continue;
    }
    const candidates = applicableCandidates(input, representative.selection);
    if (candidates.some((candidate) => !basisEquals(candidate.value.basis, representative.selection.basis))) {
      return { _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', reason: 'CATALOG_BASIS_STALE' };
    }
    const compatible = candidates.filter((candidate) =>
      basisEquals(candidate.value.basis, representative.selection.basis),
    );
    const envelopes = compatible.filter(({ value }) => value.constraintMode === 'REPLACEABLE_ENVELOPE');
    if (envelopes.length === 0) {
      return {
        _tag: 'MISSING_COMMERCE_QUANTITY_POLICY',
        equivalentSelectionKey,
        lineIds: lines.map(({ lineId }) => lineId),
      };
    }
    const ranked = envelopes.map((candidate) => ({
      candidate,
      rank: candidateRank(candidate, input.policy.assignmentSet.assignments, input.request.subject),
    }));
    const winningRank = ranked.reduce(
      (best, candidate) => (compareRank(candidate.rank, best) > 0 ? candidate.rank : best),
      ranked[0]?.rank ?? [0, 0, 0],
    );
    const winners = ranked.filter(({ rank }) => compareRank(rank, winningRank) === 0).map(({ candidate }) => candidate);
    if (winners.length !== 1) {
      return {
        _tag: 'INCONSISTENT_COMMERCE_QUANTITY_POLICY',
        equivalentSelectionKey,
        ruleRevisionIds: winners.map(({ policyRevisionId }) => policyRevisionId).sort(),
      };
    }
    const winner = winners[0];
    if (winner === undefined) {
      return { _tag: 'MISSING_COMMERCE_QUANTITY_POLICY', equivalentSelectionKey, lineIds: [] };
    }
    let total = lines[0]?.selection.normalizedQuantity;
    if (total === undefined) {
      continue;
    }
    for (const line of lines) {
      const requestedSelection = input.request.lines.find(({ lineId }) => lineId === line.lineId)?.selection;
      if (
        requestedSelection === undefined ||
        !sameCatalogSelection(line.selection.catalogSelection, requestedSelection)
      ) {
        return { _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE', reason: 'CATALOG_SELECTION_MISMATCH' };
      }
      if (line.selection.requestedQuantity !== line.selection.normalizedQuantity) {
        return {
          _tag: 'COMMERCE_QUANTITY_REJECTED',
          actualQuantity: line.selection.requestedQuantity,
          limit: line.selection.normalizedQuantity,
          lineIds: [line.lineId],
          reason: 'NORMALIZATION_REQUIRED',
        };
      }
    }
    for (const line of lines.slice(1)) {
      total = add(total, line.selection.normalizedQuantity);
    }
    if (!isMultiple(total, representative.selection.physicalMultiple)) {
      return {
        _tag: 'COMMERCE_QUANTITY_REJECTED',
        actualQuantity: total,
        limit: representative.selection.physicalMultiple,
        lineIds: lines.map(({ lineId }) => lineId),
        reason: 'PHYSICAL_NOT_MULTIPLE',
      };
    }
    const constraints = compatible.filter(({ value }) => value.constraintMode === 'NON_RELAXABLE_CONSTRAINT');
    const allEnvelopes = [winner, ...constraints];
    for (const candidate of allEnvelopes) {
      const failed = violation(total, candidate.value.envelope);
      if (failed !== undefined) {
        return {
          _tag: 'COMMERCE_QUANTITY_REJECTED',
          actualQuantity: total,
          limit: failed.limit,
          lineIds: lines.map(({ lineId }) => lineId),
          reason: failed.reason,
        };
      }
    }
    resolvedLines.push({
      basis: representative.selection.basis,
      catalogCompleteness: representative.selection.completeness,
      catalogHierarchyRevision: representative.selection.hierarchyRevision,
      catalogOwnerRevision: representative.selection.ownerRevision,
      constraints: constraints.map(({ policyRevisionId, value }) => ({
        envelope: value.envelope,
        ruleRevisionId: policyRevisionId,
      })),
      equivalentSelectionKey,
      lineIds: lines.map(({ lineId }) => lineId),
      normalizedQuantity: total,
      requestedQuantity: lines.map(({ selection }) => selection.requestedQuantity).reduce(add),
      winningEnvelope: winner.value.envelope,
      winningRuleRevisionId: winner.policyRevisionId,
    });
  }
  return {
    _tag: 'COMMERCE_QUANTITY_PERMITTED',
    assignmentCompleteness: input.policy.assignmentSet.completeness,
    lines: resolvedLines,
    observedAt: input.request.at,
    ruleCompleteness: input.policy.ruleSet.completeness,
  };
};
