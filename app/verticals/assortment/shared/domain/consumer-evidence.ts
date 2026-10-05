import { Schema } from 'effect';

import {
  AssortmentDecisionSubjectSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentSetPurchaseCompositionSchema,
  AssortmentTrustedCommerceContextSchema,
  composeAssortmentPurchaseOutcome,
} from './decision-contracts.ts';
import type { AssortmentPurchaseConstituent, AssortmentSetPurchaseComposition } from './decision-contracts.ts';

const constituentEquivalence = Schema.toEquivalence(AssortmentPurchaseConstituentSchema);
const evidenceReferenceEquivalence = Schema.toEquivalence(AssortmentEvidenceReferenceSchema);

const AssortmentDecisionEvidenceReferenceSchema = AssortmentEvidenceReferenceSchema.check(
  Schema.makeFilter((reference) =>
    reference.ownerModuleId === 'commerce.assortment' &&
    reference.evidenceRef.moduleId === 'commerce.assortment' &&
    reference.evidenceRef.resourceType === 'commerce.assortment.decision-evidence'
      ? undefined
      : 'consumer evidence must reference immutable Assortment Decision Evidence',
  ),
);

export const AssortmentConsumerDecisionEvidenceReferenceSchema = AssortmentDecisionEvidenceReferenceSchema;
export type AssortmentConsumerDecisionEvidenceReference = typeof AssortmentConsumerDecisionEvidenceReferenceSchema.Type;

const EligibleConstituentEvidenceSchema = Schema.Struct({
  constituent: AssortmentPurchaseConstituentSchema,
  decisionEvidence: AssortmentDecisionEvidenceReferenceSchema,
  outcome: Schema.Literal('ELIGIBLE'),
});

const IneligibleConstituentEvidenceSchema = Schema.Struct({
  constituent: AssortmentPurchaseConstituentSchema,
  decisionEvidence: AssortmentDecisionEvidenceReferenceSchema,
  outcome: Schema.Literal('INELIGIBLE'),
  safeReasonCode: Schema.Literals(['BOUNDARY_EXCLUDED', 'RULE_DENIED']),
});

const IndeterminateConstituentEvidenceSchema = Schema.Union([
  Schema.Struct({
    constituent: AssortmentPurchaseConstituentSchema,
    outcome: Schema.Literal('INDETERMINATE'),
    retryable: Schema.Literal(true),
    safeReasonCode: Schema.Literals(['DEPENDENCY_UNAVAILABLE', 'CURRENTNESS_UNCERTAIN']),
  }),
  Schema.Struct({
    constituent: AssortmentPurchaseConstituentSchema,
    outcome: Schema.Literal('INDETERMINATE'),
    retryable: Schema.Literal(false),
    safeReasonCode: Schema.Literals(['CONFIGURATION_CONFLICT', 'MISSING_CONFIGURATION', 'RETRY_EXHAUSTED']),
  }),
]);

export const AssortmentConsumerConstituentEvidenceSchema = Schema.Union([
  EligibleConstituentEvidenceSchema,
  IneligibleConstituentEvidenceSchema,
  IndeterminateConstituentEvidenceSchema,
]);
export type AssortmentConsumerConstituentEvidence = typeof AssortmentConsumerConstituentEvidenceSchema.Type;

const expectedConstituents = (
  topLevel: AssortmentPurchaseConstituent,
  composition: AssortmentSetPurchaseComposition | undefined,
): readonly AssortmentPurchaseConstituent[] =>
  composition === undefined ? [topLevel] : [topLevel, ...composition.requiredComponents];

const isExpectedConstituent = (
  constituent: AssortmentPurchaseConstituent,
  expected: readonly AssortmentPurchaseConstituent[],
): boolean => expected.some((candidate) => constituentEquivalence(candidate, constituent));

const hasDuplicateConstituent = (evaluated: readonly AssortmentConsumerConstituentEvidence[]): boolean =>
  evaluated.some((item, index) =>
    evaluated.slice(0, index).some((previous) => constituentEquivalence(previous.constituent, item.constituent)),
  );

const hasDuplicateEvidenceReference = (evaluated: readonly AssortmentConsumerConstituentEvidence[]): boolean => {
  const authoritative = evaluated.filter(
    (item): item is typeof EligibleConstituentEvidenceSchema.Type | typeof IneligibleConstituentEvidenceSchema.Type =>
      item.outcome !== 'INDETERMINATE',
  );
  return authoritative.some((item, index) =>
    authoritative
      .slice(0, index)
      .some((previous) => evidenceReferenceEquivalence(previous.decisionEvidence, item.decisionEvidence)),
  );
};

const revisionEquals = (
  left: AssortmentSetPurchaseComposition['setCompositionRevision'],
  right: AssortmentSetPurchaseComposition['setCompositionRevision'],
): boolean =>
  left.ownerModuleId === right.ownerModuleId &&
  left.revision === right.revision &&
  left.sourceRef.moduleId === right.sourceRef.moduleId &&
  left.sourceRef.resourceId === right.sourceRef.resourceId &&
  left.sourceRef.resourceType === right.sourceRef.resourceType &&
  left.sourceRef.tenantId === right.sourceRef.tenantId;

const constituentTenant = (constituent: AssortmentPurchaseConstituent): string =>
  constituent.catalogSelection.productRef.tenantId;

const evidenceReferencesUseTenant = (
  evaluated: readonly AssortmentConsumerConstituentEvidence[],
  tenantId: string,
): boolean =>
  evaluated.every(
    (item) =>
      constituentTenant(item.constituent) === tenantId &&
      (item.outcome === 'INDETERMINATE' ||
        (item.decisionEvidence.evidenceRef.tenantId === tenantId &&
          (item.decisionEvidence.sourceRevision === undefined ||
            item.decisionEvidence.sourceRevision.sourceRef.tenantId === tenantId))),
  );

const subjectUsesTenant = (subject: typeof AssortmentDecisionSubjectSchema.Type, tenantId: string): boolean => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return (
      subject.guestEvidence.evidenceRef.tenantId === tenantId &&
      (subject.guestEvidence.sourceRevision === undefined ||
        subject.guestEvidence.sourceRevision.sourceRef.tenantId === tenantId)
    );
  }
  return (
    (subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? subject.subject.profileRef : subject.subject.counterpartyRef)
      .tenantId === tenantId
  );
};

/**
 * Safe pre-attempt evidence for Cart, proposal, approval, Bundle, and accepted
 * history. Full Boundary, Candidate, Membership, and policy paths remain
 * owner-local behind the immutable Decision Evidence references.
 */
export const AssortmentProspectivePurchaseEvidenceSchema = Schema.Struct({
  composedOutcome: Schema.Literals(['ELIGIBLE', 'INELIGIBLE', 'INDETERMINATE']),
  evaluatedConstituents: Schema.Array(AssortmentConsumerConstituentEvidenceSchema).check(Schema.isMinLength(1)),
  setComposition: Schema.optionalKey(AssortmentSetPurchaseCompositionSchema),
  subject: AssortmentDecisionSubjectSchema,
  topLevelConstituent: AssortmentPurchaseConstituentSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
}).check(
  Schema.makeFilter((evidence) => {
    const isSet = evidence.topLevelConstituent.catalogSelection.variantKind === 'SET';
    if (evidence.topLevelConstituent.role !== 'TOP_LEVEL' || isSet !== (evidence.setComposition !== undefined)) {
      return 'consumer evidence must describe one top-level constituent and its pinned Set composition when applicable';
    }
    if (
      isSet &&
      evidence.setComposition !== undefined &&
      evidence.topLevelConstituent.catalogSelection.variantKind === 'SET' &&
      !revisionEquals(
        evidence.topLevelConstituent.catalogSelection.setCompositionRevision,
        evidence.setComposition.setCompositionRevision,
      )
    ) {
      return 'consumer evidence Set composition must match the top-level pinned revision';
    }
    const expected = expectedConstituents(evidence.topLevelConstituent, evidence.setComposition);
    if (
      hasDuplicateConstituent(evidence.evaluatedConstituents) ||
      hasDuplicateEvidenceReference(evidence.evaluatedConstituents) ||
      evidence.evaluatedConstituents.some((item) => !isExpectedConstituent(item.constituent, expected)) ||
      (evidence.composedOutcome !== 'INELIGIBLE' &&
        !evidence.evaluatedConstituents.some((item) =>
          constituentEquivalence(item.constituent, evidence.topLevelConstituent),
        )) ||
      !evidenceReferencesUseTenant(evidence.evaluatedConstituents, evidence.trustedContext.tenantId) ||
      constituentTenant(evidence.topLevelConstituent) !== evidence.trustedContext.tenantId ||
      !subjectUsesTenant(evidence.subject, evidence.trustedContext.tenantId)
    ) {
      return 'consumer evidence may retain each expected constituent and Decision Evidence reference at most once';
    }
    const composed = composeAssortmentPurchaseOutcome(evidence.evaluatedConstituents);
    if (composed !== evidence.composedOutcome) {
      return 'consumer evidence composed outcome must equal the actual evaluated constituent outcomes';
    }
    if (evidence.composedOutcome === 'ELIGIBLE' && evidence.evaluatedConstituents.length !== expected.length) {
      return 'positive Set evidence requires every pinned constituent';
    }
    return true;
  }),
);
export type AssortmentProspectivePurchaseEvidence = typeof AssortmentProspectivePurchaseEvidenceSchema.Type;

/** Attempt-bound confirmation identity is deliberately not part of this pre-attempt contract. */
export const AssortmentConsumerEvidenceContractVersionSchema = Schema.Literal('assortment.consumer-evidence.v1');
