import { DateTime, Schema } from 'effect';
import type { Effect } from 'effect';

import {
  AssortmentCandidateSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
} from './decision-contracts.ts';
import type { AssortmentCandidate } from './decision-contracts.ts';
import type { AssortmentCommitmentConfirmationError as CommitmentConfirmationError } from './commitment-confirmation-errors/index.ts';

export {
  AssortmentCommitmentConfirmationErrorSchema,
  AssortmentCommitmentConfirmationExpired,
  AssortmentCommitmentConfirmationInvalid,
  AssortmentCommitmentConfirmationScopeMismatch,
  AssortmentCommitmentConfirmationUnavailable,
} from './commitment-confirmation-errors/index.ts';
export type { AssortmentCommitmentConfirmationError } from './commitment-confirmation-errors/index.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const AssortmentModuleId = 'commerce.assortment' as const;
const ConfirmationResourceType = 'commerce.assortment.commitment-confirmation' as const;

const AssortmentCommitmentConfirmationRefSchema = AssortmentOwnerResourceRefSchema.check(
  Schema.makeFilter((reference) =>
    reference.moduleId === AssortmentModuleId && reference.resourceType === ConfirmationResourceType
      ? true
      : 'confirmation reference must be owned by Assortment',
  ),
);

const candidateReferences = (candidate: AssortmentCandidate) => [
  candidate.bindingRef,
  candidate.commercialScope.channelRef,
  candidate.commercialScope.sellingLegalEntityRef,
  ...(candidate.commercialScope.commerceMarketRef === undefined ? [] : [candidate.commercialScope.commerceMarketRef]),
  ...(candidate.commercialScope.storefrontRef === undefined ? [] : [candidate.commercialScope.storefrontRef]),
  candidate.ruleRevision.sourceRef,
  ...(candidate.stableRuleRef === undefined ? [] : [candidate.stableRuleRef]),
  ...(candidate.audience.kind === 'COMMERCE_CUSTOMER_GROUP' ? [candidate.audience.groupRef] : []),
  ...(candidate.audience.kind === 'SUBJECT'
    ? [
        candidate.audience.subject.kind === 'COUNTERPARTY'
          ? candidate.audience.subject.counterpartyRef
          : candidate.audience.subject.profileRef,
      ]
    : []),
  ...(candidate.selector.kind === 'PRODUCT' ? [candidate.selector.productRef] : []),
  ...(candidate.selector.kind === 'VARIANT' ? [candidate.selector.variantRef] : []),
  ...(candidate.selector.kind === 'CATEGORY' ? [candidate.selector.categoryRef] : []),
  ...(candidate.selector.kind === 'PACKAGE_OPTION' ? [candidate.selector.packageOptionRef] : []),
];

const AssortmentPurchaseAllowCandidateSchema = AssortmentCandidateSchema.check(
  Schema.makeFilter((candidate) => {
    if (candidate.decisionPurpose !== 'PURCHASE' || candidate.effect !== 'ALLOW') {
      return 'confirmation candidate must be a PURCHASE ALLOW candidate';
    }
    const { tenantId } = candidate.commercialScope.sellingLegalEntityRef;
    return candidateReferences(candidate).every((reference) => reference.tenantId === tenantId)
      ? true
      : 'candidate references must share the commercial-scope tenant';
  }),
);

const AssortmentDecisionEvidenceReferenceSchema = AssortmentEvidenceReferenceSchema.check(
  Schema.makeFilter((reference) =>
    reference.ownerModuleId === AssortmentModuleId &&
    reference.evidenceRef.moduleId === AssortmentModuleId &&
    reference.evidenceRef.resourceType === 'commerce.assortment.decision-evidence'
      ? true
      : 'confirmation must reference immutable Assortment Decision Evidence',
  ),
);

export const AssortmentCommitmentConfirmationPayloadSchema = Schema.Struct({
  attemptRef: AssortmentOwnerResourceRefSchema,
  candidate: AssortmentPurchaseAllowCandidateSchema,
  constituent: AssortmentPurchaseConstituentSchema,
  decisionEvidenceRef: AssortmentDecisionEvidenceReferenceSchema,
  prospectivePurchaseMeaningRef: AssortmentOwnerResourceRefSchema,
}).check(
  Schema.makeFilter((payload) => {
    const { tenantId } = payload.attemptRef;
    const refs = [
      payload.prospectivePurchaseMeaningRef,
      payload.constituent.catalogSelection.productRef,
      payload.constituent.catalogSelection.variantRef,
      payload.decisionEvidenceRef.evidenceRef,
      ...(payload.decisionEvidenceRef.sourceRevision === undefined
        ? []
        : [payload.decisionEvidenceRef.sourceRevision.sourceRef]),
    ];
    return refs.every((reference) => reference.tenantId === tenantId) &&
      payload.candidate.commercialScope.sellingLegalEntityRef.tenantId === tenantId
      ? true
      : 'confirmation references must use one tenant';
  }),
);
export type AssortmentCommitmentConfirmationPayload = typeof AssortmentCommitmentConfirmationPayloadSchema.Type;

export const AssortmentCommitmentConfirmationResultSchema = Schema.Struct({
  attemptRef: AssortmentOwnerResourceRefSchema,
  candidate: AssortmentPurchaseAllowCandidateSchema,
  confirmationRef: AssortmentCommitmentConfirmationRefSchema,
  constituent: AssortmentPurchaseConstituentSchema,
  decisionEvidenceRef: AssortmentDecisionEvidenceReferenceSchema,
  expiresAt: InstantSchema,
  issuedAt: InstantSchema,
  prospectivePurchaseMeaningRef: AssortmentOwnerResourceRefSchema,
}).check(
  Schema.makeFilter((confirmation) => {
    if (DateTime.toEpochMillis(confirmation.expiresAt) <= DateTime.toEpochMillis(confirmation.issuedAt)) {
      return 'confirmation expiry must be after issuance';
    }
    if (DateTime.toEpochMillis(confirmation.expiresAt) - DateTime.toEpochMillis(confirmation.issuedAt) > 30_000) {
      return 'confirmation validity may not exceed thirty seconds';
    }
    const { tenantId } = confirmation.attemptRef;
    return confirmation.prospectivePurchaseMeaningRef.tenantId !== tenantId ||
      confirmation.constituent.catalogSelection.productRef.tenantId !== tenantId ||
      confirmation.decisionEvidenceRef.evidenceRef.tenantId !== tenantId ||
      confirmation.candidate.commercialScope.sellingLegalEntityRef.tenantId !== tenantId ||
      (confirmation.decisionEvidenceRef.sourceRevision !== undefined &&
        confirmation.decisionEvidenceRef.sourceRevision.sourceRef.tenantId !== tenantId) ||
      confirmation.confirmationRef.tenantId !== tenantId
      ? 'confirmation references must use one tenant'
      : true;
  }),
);
export type AssortmentCommitmentConfirmationResult = typeof AssortmentCommitmentConfirmationResultSchema.Type;

const confirmationRefEquivalence = Schema.toEquivalence(AssortmentOwnerResourceRefSchema);
const confirmationCandidateEquivalence = Schema.toEquivalence(AssortmentPurchaseAllowCandidateSchema);
const confirmationConstituentEquivalence = Schema.toEquivalence(AssortmentPurchaseConstituentSchema);
const confirmationEvidenceEquivalence = Schema.toEquivalence(AssortmentDecisionEvidenceReferenceSchema);

export const isAssortmentCommitmentConfirmationValidAt = (
  confirmation: Pick<AssortmentCommitmentConfirmationResult, 'issuedAt' | 'expiresAt'>,
  at: DateTime.Utc,
): boolean =>
  DateTime.toEpochMillis(at) >= DateTime.toEpochMillis(confirmation.issuedAt) &&
  DateTime.toEpochMillis(at) < DateTime.toEpochMillis(confirmation.expiresAt);

export const assortmentCommitmentConfirmationMatchesExactScope = (
  confirmation: AssortmentCommitmentConfirmationResult,
  expected: Pick<
    AssortmentCommitmentConfirmationPayload,
    'attemptRef' | 'candidate' | 'constituent' | 'decisionEvidenceRef' | 'prospectivePurchaseMeaningRef'
  >,
  at: DateTime.Utc,
): boolean =>
  isAssortmentCommitmentConfirmationValidAt(confirmation, at) &&
  confirmationRefEquivalence(confirmation.attemptRef, expected.attemptRef) &&
  confirmationRefEquivalence(confirmation.prospectivePurchaseMeaningRef, expected.prospectivePurchaseMeaningRef) &&
  confirmationCandidateEquivalence(confirmation.candidate, expected.candidate) &&
  confirmationConstituentEquivalence(confirmation.constituent, expected.constituent) &&
  confirmationEvidenceEquivalence(confirmation.decisionEvidenceRef, expected.decisionEvidenceRef);

export const commitmentConfirmationRef = (tenantId: string, resourceId: string) => ({
  moduleId: AssortmentModuleId,
  resourceId,
  resourceType: ConfirmationResourceType,
  tenantId,
});

export interface AssortmentCommitmentConfirmationIssuer {
  readonly issue: (
    payload: AssortmentCommitmentConfirmationPayload,
    metadata: Readonly<{ readonly actionInvocationId: string; readonly actorPrincipalId: string }>,
  ) => Effect.Effect<AssortmentCommitmentConfirmationResult, CommitmentConfirmationError>;
}
