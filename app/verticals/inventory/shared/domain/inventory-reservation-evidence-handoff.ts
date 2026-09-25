import { DateTime, Effect, Match, Schema } from 'effect';

import {
  CatalogToStockBindingHistoryEntrySchema,
  CatalogToStockBindingSchema,
  PurchaseDemandOccurrenceIdSchema,
} from './catalog-to-stock-binding.ts';
import { CommitmentProtectionSchema } from './commitment-protection.ts';
import { ProvisionalInventoryReservationSchema } from './inventory-obligation.ts';
import { ReservationConfirmationSchema } from './reservation-confirmation.ts';
import { ReservationEvidenceIssuerSchema } from './reservation-authority.ts';
import { OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';

const boundedEvidenceRef = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * Inventory never owns or re-hashes the Order bundle. It retains only the exact
 * immutable owner binding that the Order Commitment Attempt already selected.
 */
export const OrderAcceptanceDecisionBundleBindingSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  bundleHash: boundedEvidenceRef,
  bundleSchemaVersion: boundedEvidenceRef,
  meaning: Schema.Literal('EXACT_PRE_ATTEMPT_PURCHASE'),
  tenantId: ProvisionalInventoryReservationSchema.fields.ref.fields.tenantId,
});
export type OrderAcceptanceDecisionBundleBinding = typeof OrderAcceptanceDecisionBundleBindingSchema.Type;

export const InventoryReservationRequirementBindingEvidenceSchema = Schema.Struct({
  acceptedBinding: CatalogToStockBindingSchema,
  acceptedBindingOwnerEvidenceRef: boundedEvidenceRef,
  currentCorrection: Schema.optionalKey(
    Schema.Struct({
      currentBinding: CatalogToStockBindingSchema,
      historyEntry: CatalogToStockBindingHistoryEntrySchema,
    }),
  ),
  purchaseDemandOccurrenceId: PurchaseDemandOccurrenceIdSchema,
});
export type InventoryReservationRequirementBindingEvidence =
  typeof InventoryReservationRequirementBindingEvidenceSchema.Type;

const SafeInventoryReservationOwnerReferencesSchema = Schema.Struct({
  confirmationEffectId: ReservationConfirmationSchema.fields.authorityEvidence.fields.effectId,
  confirmationOwnerEvidenceRef:
    ReservationConfirmationSchema.fields.authorityEvidence.fields.evidence.fields.ownerEvidenceRef,
  issuer: ReservationEvidenceIssuerSchema,
  protectionEffectId: CommitmentProtectionSchema.fields.authorityEvidence.fields.effectId,
  protectionOwnerEvidenceRef:
    CommitmentProtectionSchema.fields.authorityEvidence.fields.evidence.fields.ownerEvidenceRef,
});

/** The public handoff references its one top-level Current Confirmation instead of embedding a second copy. */
export const InventoryReservationProtectionHandoffEvidenceSchema = Schema.Struct({
  authorityEvidence: CommitmentProtectionSchema.fields.authorityEvidence,
  confirmationRef: ReservationConfirmationSchema.fields.ref,
  establishedAt: CommitmentProtectionSchema.fields.establishedAt,
  health: CommitmentProtectionSchema.fields.health,
  ref: CommitmentProtectionSchema.fields.ref,
  revision: CommitmentProtectionSchema.fields.revision,
});
export type InventoryReservationProtectionHandoffEvidence =
  typeof InventoryReservationProtectionHandoffEvidenceSchema.Type;

const InventoryReservationEvidenceHandoffBaseSchema = Schema.TaggedStruct('InventoryReservationEvidenceHandoff', {
  backendFallbackApplied: Schema.Literal(false),
  bundleBinding: OrderAcceptanceDecisionBundleBindingSchema,
  confirmation: ReservationConfirmationSchema,
  proofSetPlacement: Schema.Literal('ORDER_COMMITMENT_PROOF_SET'),
  protection: InventoryReservationProtectionHandoffEvidenceSchema,
  requirementBindingEvidence: Schema.Array(InventoryReservationRequirementBindingEvidenceSchema).check(
    Schema.isMinLength(1),
  ),
  reservation: ProvisionalInventoryReservationSchema,
  reservationConfirmationRenewalSupported: Schema.Literal(false),
  safeOwnerReferences: SafeInventoryReservationOwnerReferencesSchema,
});

export class InventoryReservationEvidenceHandoffRejected extends Schema.TaggedError<InventoryReservationEvidenceHandoffRejected>()(
  'InventoryReservationEvidenceHandoffRejected',
  {
    code: Schema.Literal('inventory_reservation_evidence_handoff_rejected'),
    fallbackApplied: Schema.Literal(false),
    reason: Schema.Literals([
      'INVALID_HANDOFF',
      'TENANT_SCOPE_MISMATCH',
      'ATTEMPT_BUNDLE_MISMATCH',
      'RESERVATION_CONFIRMATION_MISMATCH',
      'CONFIRMATION_PROTECTION_MISMATCH',
      'AUTHORITY_SCOPE_MISMATCH',
      'PROTECTION_ESTABLISHMENT_OUTSIDE_CONFIRMATION',
      'BINDING_EVIDENCE_MISSING',
      'BINDING_EVIDENCE_MISMATCH',
      'CORRECTION_EVIDENCE_MISMATCH',
      'CORRECTION_HEALTH_MISMATCH',
      'CORRECTION_PROVENANCE_MISMATCH',
    ]),
  },
) {}

export const InventoryReservationEvidenceHandoffInputSchema = Schema.Struct({
  bundleBinding: OrderAcceptanceDecisionBundleBindingSchema,
  confirmation: ReservationConfirmationSchema,
  protection: CommitmentProtectionSchema,
  requirementBindingEvidence: Schema.Array(InventoryReservationRequirementBindingEvidenceSchema),
  reservation: ProvisionalInventoryReservationSchema,
});
export type InventoryReservationEvidenceHandoffInput = typeof InventoryReservationEvidenceHandoffInputSchema.Type;

const rejected = (reason: InventoryReservationEvidenceHandoffRejected['reason']) =>
  new InventoryReservationEvidenceHandoffRejected({
    code: 'inventory_reservation_evidence_handoff_rejected',
    fallbackApplied: false,
    reason,
  });

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameRequirements = Schema.toEquivalence(ProvisionalInventoryReservationSchema.fields.requirements);
const sameBackendConfiguration = Schema.toEquivalence(ProvisionalInventoryReservationSchema.fields.authority);
const sameBinding = Schema.toEquivalence(CatalogToStockBindingSchema);
const sameCatalogSelection = Schema.toEquivalence(CatalogToStockBindingSchema.fields.catalogSelection);
const sameSelectionMeaning = Schema.toEquivalence(CatalogToStockBindingSchema.fields.exactSelectionMeaning);
const sameConfirmationAuthorityEvidence = Schema.toEquivalence(ReservationConfirmationSchema.fields.authorityEvidence);
const sameConfirmationHealth = Schema.toEquivalence(ReservationConfirmationSchema.fields.health);
const sameIssuanceRank = Schema.toEquivalence(ReservationConfirmationSchema.fields.issuanceRank);
const sameAuthorityAllocations = Schema.toEquivalence(
  ReservationConfirmationSchema.fields.authorityEvidence.fields.evidence.fields.allocations,
);

const sameAuthority = (
  issuer: typeof ReservationEvidenceIssuerSchema.Type,
  expected: typeof ReservationEvidenceIssuerSchema.Type,
) =>
  issuer.backend === expected.backend && issuer.backendId === expected.backendId && issuer.origin === expected.origin;

const expectedIssuer = (
  reservation: typeof ProvisionalInventoryReservationSchema.Type,
): typeof ReservationEvidenceIssuerSchema.Type => ({
  backend: reservation.authority.selection.backend,
  backendId: reservation.authority.selection.backendId,
  origin:
    reservation.authority.selection.backend === 'external_business_system' ? 'EXTERNAL_BUSINESS_SYSTEM' : 'ONTOS_WMS',
});

interface HandoffLineage {
  readonly bundleBinding: OrderAcceptanceDecisionBundleBinding;
  readonly confirmation: typeof ReservationConfirmationSchema.Type;
  readonly protection: InventoryReservationProtectionHandoffEvidence;
  readonly reservation: typeof ProvisionalInventoryReservationSchema.Type;
}

const toProtectionHandoffEvidence = (
  protection: typeof CommitmentProtectionSchema.Type,
): InventoryReservationProtectionHandoffEvidence => ({
  authorityEvidence: protection.authorityEvidence,
  confirmationRef: protection.confirmation.ref,
  establishedAt: protection.establishedAt,
  health: protection.health,
  ref: protection.ref,
  revision: protection.revision,
});

const protectionProofMatchesLineage = (
  protection: InventoryReservationProtectionHandoffEvidence,
  confirmation: typeof ReservationConfirmationSchema.Type,
  reservation: typeof ProvisionalInventoryReservationSchema.Type,
) => {
  const proof = protection.authorityEvidence;
  return (
    proof.operation === 'COMMITMENT_PROTECTION' &&
    String(proof.evidence.tenantId) === String(reservation.ref.tenantId) &&
    proof.evidence.reservationId === reservation.ref.resourceId &&
    proof.evidence.attemptId === reservation.origin.attemptId &&
    sameAuthorityAllocations(proof.evidence.allocations, confirmation.authorityEvidence.evidence.allocations)
  );
};

const validateHandoffLineage = (
  input: HandoffLineage,
): InventoryReservationEvidenceHandoffRejected['reason'] | undefined => {
  const { bundleBinding, confirmation, protection, reservation } = input;
  const {
    ref: { tenantId },
  } = reservation;
  if (
    bundleBinding.tenantId !== tenantId ||
    confirmation.ref.tenantId !== tenantId ||
    protection.ref.tenantId !== tenantId
  ) {
    return 'TENANT_SCOPE_MISMATCH';
  }
  if (bundleBinding.attemptId !== reservation.origin.attemptId) {
    return 'ATTEMPT_BUNDLE_MISMATCH';
  }
  if (
    !sameRef(confirmation.reservation.ref, reservation.ref) ||
    confirmation.reservation.origin.attemptId !== reservation.origin.attemptId ||
    confirmation.reservation.establishedAt !== reservation.establishedAt ||
    !sameRequirements(confirmation.reservation.requirements, reservation.requirements) ||
    !sameBackendConfiguration(confirmation.reservation.authority, reservation.authority)
  ) {
    return 'RESERVATION_CONFIRMATION_MISMATCH';
  }
  if (!sameRef(protection.confirmationRef, confirmation.ref)) {
    return 'CONFIRMATION_PROTECTION_MISMATCH';
  }
  if (!protectionProofMatchesLineage(protection, confirmation, reservation)) {
    return 'CONFIRMATION_PROTECTION_MISMATCH';
  }
  const issuer = expectedIssuer(reservation);
  if (
    !sameAuthority(confirmation.authorityEvidence.issuer, issuer) ||
    !sameAuthority(protection.authorityEvidence.issuer, issuer) ||
    confirmation.authorityEvidence.evidence.customerConfigurationId !== reservation.authority.customerConfigurationId ||
    protection.authorityEvidence.evidence.customerConfigurationId !== reservation.authority.customerConfigurationId
  ) {
    return 'AUTHORITY_SCOPE_MISMATCH';
  }
  const establishedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(protection.establishedAt));
  const issuedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.issuedAt));
  const expiresAt = DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.expiresAt));
  if (establishedAt < issuedAt || establishedAt >= expiresAt) {
    return 'PROTECTION_ESTABLISHMENT_OUTSIDE_CONFIRMATION';
  }
  return undefined;
};

const validateInputLineage = (
  input: InventoryReservationEvidenceHandoffInput,
): InventoryReservationEvidenceHandoffRejected['reason'] | undefined => {
  const handoffFailure = validateHandoffLineage({
    ...input,
    protection: toProtectionHandoffEvidence(input.protection),
  });
  if (handoffFailure !== undefined) {
    return handoffFailure;
  }
  const { confirmation, protection, reservation } = input;
  const protectedConfirmation = protection.confirmation;
  return !sameRef(protectedConfirmation.ref, confirmation.ref) ||
    !sameRef(protectedConfirmation.reservation.ref, reservation.ref) ||
    protectedConfirmation.reservation.origin.attemptId !== reservation.origin.attemptId ||
    protectedConfirmation.reservation.establishedAt !== reservation.establishedAt ||
    !sameRequirements(protectedConfirmation.reservation.requirements, reservation.requirements) ||
    !sameBackendConfiguration(protectedConfirmation.reservation.authority, reservation.authority) ||
    !sameConfirmationAuthorityEvidence(protectedConfirmation.authorityEvidence, confirmation.authorityEvidence) ||
    !sameIssuanceRank(protectedConfirmation.issuanceRank, confirmation.issuanceRank) ||
    protectedConfirmation.issuedAt !== confirmation.issuedAt ||
    protectedConfirmation.expiresAt !== confirmation.expiresAt ||
    protectedConfirmation.revision > confirmation.revision ||
    (protectedConfirmation.revision === confirmation.revision &&
      !sameConfirmationHealth(protectedConfirmation.health, confirmation.health))
    ? 'CONFIRMATION_PROTECTION_MISMATCH'
    : undefined;
};

const validateCorrectionEvidence = (
  accepted: typeof CatalogToStockBindingSchema.Type,
  evidence: InventoryReservationRequirementBindingEvidence,
): InventoryReservationEvidenceHandoffRejected['reason'] | undefined => {
  const correction = evidence.currentCorrection;
  if (correction === undefined) {
    return undefined;
  }
  const { currentBinding, historyEntry } = correction;
  const acceptedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(accepted.effectiveFrom));
  const correctedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(currentBinding.effectiveFrom));
  return historyEntry.transition !== 'CORRECTED' ||
    !sameBinding(historyEntry.binding, accepted) ||
    historyEntry.endedAt !== currentBinding.effectiveFrom ||
    correctedAt <= acceptedAt ||
    !sameRef(currentBinding.bindingRef, accepted.bindingRef) ||
    currentBinding.revision <= accepted.revision ||
    sameRef(currentBinding.stockItemRef, accepted.stockItemRef) ||
    !sameRef(currentBinding.unitRef, accepted.unitRef) ||
    !sameCatalogSelection(currentBinding.catalogSelection, accepted.catalogSelection) ||
    !sameSelectionMeaning(currentBinding.exactSelectionMeaning, accepted.exactSelectionMeaning)
    ? 'CORRECTION_EVIDENCE_MISMATCH'
    : undefined;
};

type BindingEvidenceValidationInput = Pick<
  InventoryReservationEvidenceHandoffInput,
  'confirmation' | 'requirementBindingEvidence' | 'reservation'
> & {
  readonly protection: Pick<InventoryReservationProtectionHandoffEvidence, 'health'>;
};

const bindingCorrectionObservation = (
  observation:
    | (typeof ReservationConfirmationSchema.Type)['health']['observation']
    | InventoryReservationProtectionHandoffEvidence['health']['observation'],
) =>
  Match.value(observation).pipe(
    Match.tag('BINDING_CORRECTION', ({ correctionEvidenceRef, effectiveAt }) => ({
      correctionEvidenceRef,
      effectiveAt,
    })),
    Match.orElse(() => null),
  );

const validateCorrectionProvenance = (
  input: BindingEvidenceValidationInput,
  evidence: InventoryReservationRequirementBindingEvidence,
): InventoryReservationEvidenceHandoffRejected['reason'] | undefined => {
  const correction = evidence.currentCorrection;
  if (correction === undefined) {
    return undefined;
  }
  const confirmationObservation = bindingCorrectionObservation(input.confirmation.health.observation);
  const protectionObservation = bindingCorrectionObservation(input.protection.health.observation);
  const { historyEntry } = correction;
  return confirmationObservation === null ||
    protectionObservation === null ||
    confirmationObservation.correctionEvidenceRef !== historyEntry.ownerEvidenceRef ||
    protectionObservation.correctionEvidenceRef !== historyEntry.ownerEvidenceRef ||
    confirmationObservation.effectiveAt !== historyEntry.endedAt ||
    protectionObservation.effectiveAt !== historyEntry.endedAt
    ? 'CORRECTION_PROVENANCE_MISMATCH'
    : undefined;
};

const validateBindingEvidence = (
  input: BindingEvidenceValidationInput,
): InventoryReservationEvidenceHandoffRejected['reason'] | undefined => {
  const evidenceByOccurrence = new Map(
    input.requirementBindingEvidence.map((evidence) => [String(evidence.purchaseDemandOccurrenceId), evidence]),
  );
  if (
    evidenceByOccurrence.size !== input.requirementBindingEvidence.length ||
    evidenceByOccurrence.size !== input.reservation.requirements.length
  ) {
    return 'BINDING_EVIDENCE_MISSING';
  }
  let hasCorrection = false;
  for (const requirement of input.reservation.requirements) {
    const evidence = evidenceByOccurrence.get(String(requirement.purchaseDemandOccurrenceId));
    if (evidence === undefined) {
      return 'BINDING_EVIDENCE_MISSING';
    }
    const accepted = evidence.acceptedBinding;
    if (
      !sameRef(accepted.bindingRef, requirement.bindingRef) ||
      !sameRef(accepted.stockItemRef, requirement.stockItem.stockItemRef) ||
      !sameRef(accepted.unitRef, requirement.unitRef) ||
      !sameCatalogSelection(accepted.catalogSelection, requirement.catalogSelection) ||
      !sameSelectionMeaning(accepted.exactSelectionMeaning, requirement.exactSelectionMeaning)
    ) {
      return 'BINDING_EVIDENCE_MISMATCH';
    }
    if (evidence.currentCorrection === undefined) {
      continue;
    }
    hasCorrection = true;
    const correctionFailure = validateCorrectionEvidence(accepted, evidence);
    if (correctionFailure !== undefined) {
      return correctionFailure;
    }
    const provenanceFailure = validateCorrectionProvenance(input, evidence);
    if (provenanceFailure !== undefined) {
      return provenanceFailure;
    }
  }
  return hasCorrection &&
    (input.protection.health.state !== 'AT_RISK' || !input.protection.health.reconciliationRequired)
    ? 'CORRECTION_HEALTH_MISMATCH'
    : undefined;
};

const validateSafeOwnerReferences = (
  handoff: Pick<HandoffLineage, 'confirmation' | 'protection'> & {
    readonly safeOwnerReferences: typeof SafeInventoryReservationOwnerReferencesSchema.Type;
  },
): InventoryReservationEvidenceHandoffRejected['reason'] | undefined => {
  const { confirmation, protection, safeOwnerReferences } = handoff;
  return safeOwnerReferences.confirmationEffectId !== confirmation.authorityEvidence.effectId ||
    safeOwnerReferences.confirmationOwnerEvidenceRef !== confirmation.authorityEvidence.evidence.ownerEvidenceRef ||
    safeOwnerReferences.protectionEffectId !== protection.authorityEvidence.effectId ||
    safeOwnerReferences.protectionOwnerEvidenceRef !== protection.authorityEvidence.evidence.ownerEvidenceRef ||
    !sameAuthority(safeOwnerReferences.issuer, confirmation.authorityEvidence.issuer)
    ? 'AUTHORITY_SCOPE_MISMATCH'
    : undefined;
};

export const InventoryReservationEvidenceHandoffSchema = InventoryReservationEvidenceHandoffBaseSchema.check(
  Schema.makeFilter((handoff) => {
    const failure =
      validateHandoffLineage(handoff) ?? validateBindingEvidence(handoff) ?? validateSafeOwnerReferences(handoff);
    return failure === undefined ? undefined : `Invalid Inventory Reservation evidence handoff: ${failure}`;
  }),
);
export type InventoryReservationEvidenceHandoff = typeof InventoryReservationEvidenceHandoffSchema.Type;

/**
 * Builds the Inventory-owned proof-set handoff without importing Order-private
 * code. The returned value keeps the actual historical Reservation lineage;
 * Current corrections are explanatory evidence and never retarget that lineage.
 */
export const createInventoryReservationEvidenceHandoff = Effect.fn('InventoryReservationEvidenceHandoff.create')(
  function* createHandoff(input: InventoryReservationEvidenceHandoffInput) {
    const invariantFailure = validateInputLineage(input) ?? validateBindingEvidence(input);
    if (invariantFailure !== undefined) {
      return yield* rejected(invariantFailure);
    }
    return yield* Schema.decodeEffect(InventoryReservationEvidenceHandoffSchema)({
      _tag: 'InventoryReservationEvidenceHandoff',
      backendFallbackApplied: false,
      ...input,
      proofSetPlacement: 'ORDER_COMMITMENT_PROOF_SET',
      protection: toProtectionHandoffEvidence(input.protection),
      reservationConfirmationRenewalSupported: false,
      safeOwnerReferences: {
        confirmationEffectId: input.confirmation.authorityEvidence.effectId,
        confirmationOwnerEvidenceRef: input.confirmation.authorityEvidence.evidence.ownerEvidenceRef,
        issuer: input.confirmation.authorityEvidence.issuer,
        protectionEffectId: input.protection.authorityEvidence.effectId,
        protectionOwnerEvidenceRef: input.protection.authorityEvidence.evidence.ownerEvidenceRef,
      },
    }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_HANDOFF'), { cause })));
  },
);
