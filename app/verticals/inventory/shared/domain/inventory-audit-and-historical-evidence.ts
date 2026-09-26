import { DateTime, Effect, Match, Schema } from 'effect';

import { CatalogToStockBindingHistoryEntrySchema, CatalogToStockBindingSchema } from './catalog-to-stock-binding.ts';
import { CommitmentProtectionSchema } from './commitment-protection.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import type { InventoryEffectLedgerResolutionSchema } from './inventory-effect-ledger.ts';
import { InventoryEffectLedgerRecordSchema } from './inventory-effect-ledger.ts';
import {
  ImportedCommittedObligationSchema,
  InventoryObligationRequirementSchema,
  InventoryStockAllocationSchema,
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from './inventory-obligation.ts';
import { InventorySourceAssertionSchema } from './inventory-source-assertion.ts';
import { ReservationReleaseEffectSchema } from './inventory-reservation-release.ts';
import { PhysicalStockEffectRecordSchema } from './physical-stock-effect.ts';
import { ReservationConfirmationSchema, advanceReservationConfirmationHealth } from './reservation-confirmation.ts';
import {
  ReservationShortageImpactEvaluationSchema,
  ReservationShortageImpactInputSchema,
  evaluateReservationShortageImpact,
} from './reservation-shortage-impact.ts';
import { StockCorrectionRecordSchema } from './stock-correction.ts';

const boundedAuditReference = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const auditInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const HistoricalIssuedObservationSchema = Schema.TaggedStruct('ISSUED', {
  effectiveAt: auditInstant,
  ownerEvidenceRef: boundedAuditReference,
});
const InventoryAuditActorIdSchema = boundedAuditReference.pipe(Schema.brand('InventoryAuditActorId'));
const InventoryAuditPrincipalIdSchema = boundedAuditReference.pipe(Schema.brand('InventoryAuditPrincipalId'));
const InventoryAuditEffectCorrelationIdSchema = boundedAuditReference.pipe(
  Schema.brand('InventoryAuditEffectCorrelationId'),
);

export const InventoryAuditActorContextSchema = Schema.Struct({
  actorId: InventoryAuditActorIdSchema,
  authorizationEvidenceRef: boundedAuditReference,
  permission: boundedAuditReference,
  policyEvidenceRef: Schema.optionalKey(boundedAuditReference),
  principalId: InventoryAuditPrincipalIdSchema,
});

export const InventoryHistoricalRequirementEvidenceSchema = Schema.Struct({
  acceptedBinding: CatalogToStockBindingSchema,
  allocations: Schema.Array(InventoryStockAllocationSchema).check(Schema.isMinLength(1)),
  currentCorrection: Schema.optionalKey(
    Schema.Struct({
      currentBinding: CatalogToStockBindingSchema,
      historyEntry: CatalogToStockBindingHistoryEntrySchema,
    }),
  ),
  purchaseDemandOccurrenceId: InventoryObligationRequirementSchema.fields.purchaseDemandOccurrenceId,
  quantity: InventoryObligationRequirementSchema.fields.quantity,
  unitRef: InventoryObligationRequirementSchema.fields.unitRef,
});
export type InventoryHistoricalRequirementEvidence = typeof InventoryHistoricalRequirementEvidenceSchema.Type;

export const InventoryHistoricalShortageDecisionSchema = Schema.Struct({
  decidedAt: auditInstant,
  evaluation: ReservationShortageImpactEvaluationSchema,
  input: ReservationShortageImpactInputSchema,
});

export const InventoryHistoricalBackendTransitionSchema = Schema.Struct({
  effectiveBoundary: auditInstant,
  ownerEvidenceRef: boundedAuditReference,
  postCutoverConfiguration: InventoryBackendConfigurationSchema,
  preCutoverConfiguration: InventoryBackendConfigurationSchema,
  purpose: Schema.Literal('PLANNED_BACKEND_REPLACEMENT_NOT_OUTAGE_RECOVERY'),
});

export const InventoryHistoricalEvidenceCorrelationSchema = Schema.Struct({
  allocationIds: Schema.Array(InventoryStockAllocationSchema.fields.allocationId).check(Schema.isMinLength(1)),
  attemptId: ProvisionalInventoryReservationSchema.fields.origin.fields.attemptId,
  authority: InventoryBackendConfigurationSchema,
  effectId: InventoryAuditEffectCorrelationIdSchema,
  positionRefs: Schema.Array(InventoryStockAllocationSchema.fields.positionRef).check(Schema.isMinLength(1)),
  reservationRef: ProvisionalInventoryReservationSchema.fields.ref,
});

const relatedEvidence = <Tag extends string, Value extends Schema.Top>(tag: Tag, value: Value) =>
  Schema.TaggedStruct(tag, { correlation: InventoryHistoricalEvidenceCorrelationSchema, value });

const InventoryHistoricalEffectLedgerEvidenceSchema = relatedEvidence(
  'EFFECT_LEDGER',
  InventoryEffectLedgerRecordSchema,
);

export const InventoryHistoricalRelatedEvidenceSchema = Schema.Union([
  relatedEvidence('COMMITMENT_PROTECTION', CommitmentProtectionSchema),
  InventoryHistoricalEffectLedgerEvidenceSchema,
  relatedEvidence('PHYSICAL_STOCK_EFFECT', PhysicalStockEffectRecordSchema),
  relatedEvidence('RESERVATION_RELEASE', ReservationReleaseEffectSchema),
  relatedEvidence('SOURCE_ASSERTION', InventorySourceAssertionSchema),
  relatedEvidence('STOCK_CORRECTION', StockCorrectionRecordSchema),
]);
export type InventoryHistoricalRelatedEvidence = typeof InventoryHistoricalRelatedEvidenceSchema.Type;

export const InventoryHistoricalCommittedLineageSchema = Schema.Union([
  Schema.TaggedStruct('RUNTIME_COMMITTED', { obligation: RuntimeCommittedInventoryObligationSchema }),
  Schema.TaggedStruct('IMPORTED_COMMITTED', { obligation: ImportedCommittedObligationSchema }),
]);

export const InventoryHistoricalReconciliationIntervalSchema = Schema.Struct({
  attemptId: ProvisionalInventoryReservationSchema.fields.origin.fields.attemptId,
  effectId: InventoryEffectLedgerRecordSchema.fields.effectId,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- Historical reconciliation evidence explicitly distinguishes an open interval from a final authoritative resolution; expires: 2027-03-31.
  finalResolution: Schema.NullOr(
    Schema.Struct({
      ownerEvidenceRef: boundedAuditReference,
      resolvedAt: auditInstant,
      state: Schema.Literals(['SUCCEEDED', 'REJECTED']),
    }),
  ),
  indeterminateFrom: auditInstant,
  possiblePartialEffectIds: Schema.Array(InventoryEffectLedgerRecordSchema.fields.effectId),
});

export const CompileInventoryHistoricalEvidenceInputSchema = Schema.Struct({
  actorContext: Schema.optionalKey(InventoryAuditActorContextSchema),
  assembledAt: auditInstant,
  backendTransitions: Schema.Array(InventoryHistoricalBackendTransitionSchema),
  committedLineage: Schema.Array(InventoryHistoricalCommittedLineageSchema),
  confirmationHistory: Schema.Array(ReservationConfirmationSchema),
  reconciliationIntervals: Schema.Array(InventoryHistoricalReconciliationIntervalSchema),
  relatedEvidence: Schema.Array(InventoryHistoricalRelatedEvidenceSchema),
  requirementEvidence: Schema.Array(InventoryHistoricalRequirementEvidenceSchema).check(Schema.isMinLength(1)),
  reservation: ProvisionalInventoryReservationSchema,
  shortageDecisions: Schema.Array(InventoryHistoricalShortageDecisionSchema),
});
export type CompileInventoryHistoricalEvidenceInput = typeof CompileInventoryHistoricalEvidenceInputSchema.Type;

const InventoryHistoricalEvidencePacketBaseSchema = Schema.TaggedStruct('InventoryHistoricalEvidencePacket', {
  ...CompileInventoryHistoricalEvidenceInputSchema.fields,
  authorityRewriteApplied: Schema.Literal(false),
  currentAuthority: InventoryBackendConfigurationSchema,
  historicalAllocationSubstitutionApplied: Schema.Literal(false),
  historicalAuthority: InventoryBackendConfigurationSchema,
  rawProviderPayloadRetained: Schema.Literal(false),
});

export const InventoryHistoricalEvidencePacketSchema = InventoryHistoricalEvidencePacketBaseSchema;
export type InventoryHistoricalEvidencePacket = typeof InventoryHistoricalEvidencePacketSchema.Type;

export class InventoryHistoricalEvidenceRejected extends Schema.TaggedError<InventoryHistoricalEvidenceRejected>()(
  'InventoryHistoricalEvidenceRejected',
  {
    code: Schema.Literal('inventory_historical_evidence_rejected'),
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'REQUIREMENT_EVIDENCE_MISSING',
      'REQUIREMENT_EVIDENCE_MISMATCH',
      'BINDING_CORRECTION_MISMATCH',
      'CONFIRMATION_LINEAGE_MISMATCH',
      'CONFIRMATION_IDENTITY_CONFLICT',
      'CONFIRMATION_RANK_REWRITTEN',
      'CONFIRMATION_HISTORY_INVALID',
      'SHORTAGE_RANK_MISMATCH',
      'BACKEND_LINEAGE_MISMATCH',
      'RELATED_EVIDENCE_SCOPE_MISMATCH',
      'COMMITTED_LINEAGE_MISMATCH',
      'RECONCILIATION_LINEAGE_MISMATCH',
      'INVALID_HISTORICAL_EVIDENCE',
    ]),
  },
) {}

const rejected = (reason: InventoryHistoricalEvidenceRejected['reason']) =>
  new InventoryHistoricalEvidenceRejected({ code: 'inventory_historical_evidence_rejected', reason });

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

const sameMeaning = (
  left: { readonly id: string; readonly kind: string },
  right: { readonly id: string; readonly kind: string },
) => left.id === right.id && left.kind === right.kind;

const sameConfiguration = Schema.toEquivalence(InventoryBackendConfigurationSchema);
const sameRequirements = Schema.toEquivalence(ProvisionalInventoryReservationSchema.fields.requirements);
const sameRank = Schema.toEquivalence(ReservationConfirmationSchema.fields.issuanceRank);
const sameIssuer = Schema.toEquivalence(ReservationConfirmationSchema.fields.authorityEvidence.fields.issuer);
const sameAllocations = Schema.toEquivalence(Schema.Array(InventoryStockAllocationSchema));
const sameBinding = Schema.toEquivalence(CatalogToStockBindingSchema);
const sameCatalogSelection = Schema.toEquivalence(CatalogToStockBindingSchema.fields.catalogSelection);
const sameConfirmation = Schema.toEquivalence(ReservationConfirmationSchema);
const sameShortageEvaluation = Schema.toEquivalence(ReservationShortageImpactEvaluationSchema);

const correctionEvidenceMatches = (
  accepted: typeof CatalogToStockBindingSchema.Type,
  correction: NonNullable<InventoryHistoricalRequirementEvidence['currentCorrection']>,
) => {
  const { currentBinding, historyEntry } = correction;
  return (
    historyEntry.transition === 'CORRECTED' &&
    sameBinding(historyEntry.binding, accepted) &&
    historyEntry.endedAt === currentBinding.effectiveFrom &&
    sameRef(currentBinding.bindingRef, accepted.bindingRef) &&
    sameRef(currentBinding.unitRef, accepted.unitRef) &&
    sameCatalogSelection(currentBinding.catalogSelection, accepted.catalogSelection) &&
    sameMeaning(currentBinding.exactSelectionMeaning, accepted.exactSelectionMeaning) &&
    !sameRef(currentBinding.stockItemRef, accepted.stockItemRef) &&
    currentBinding.revision > accepted.revision
  );
};

const validateRequirementEvidence = (
  input: CompileInventoryHistoricalEvidenceInput,
): InventoryHistoricalEvidenceRejected['reason'] | undefined => {
  const byOccurrence = new Map(
    input.requirementEvidence.map((evidence) => [String(evidence.purchaseDemandOccurrenceId), evidence]),
  );
  if (
    byOccurrence.size !== input.requirementEvidence.length ||
    byOccurrence.size !== input.reservation.requirements.length
  ) {
    return 'REQUIREMENT_EVIDENCE_MISSING';
  }
  for (const requirement of input.reservation.requirements) {
    const evidence = byOccurrence.get(String(requirement.purchaseDemandOccurrenceId));
    if (evidence === undefined) {
      return 'REQUIREMENT_EVIDENCE_MISSING';
    }
    const accepted = evidence.acceptedBinding;
    if (
      evidence.quantity !== requirement.quantity ||
      !sameRef(evidence.unitRef, requirement.unitRef) ||
      !sameAllocations(evidence.allocations, requirement.allocations) ||
      !sameRef(accepted.bindingRef, requirement.bindingRef) ||
      !sameRef(accepted.stockItemRef, requirement.stockItem.stockItemRef) ||
      !sameRef(accepted.unitRef, requirement.unitRef) ||
      !sameCatalogSelection(accepted.catalogSelection, requirement.catalogSelection) ||
      !sameMeaning(accepted.exactSelectionMeaning, requirement.exactSelectionMeaning)
    ) {
      return 'REQUIREMENT_EVIDENCE_MISMATCH';
    }
    const correction = evidence.currentCorrection;
    if (correction !== undefined && !correctionEvidenceMatches(accepted, correction)) {
      return 'BINDING_CORRECTION_MISMATCH';
    }
  }
  return undefined;
};

const confirmationGroupKey = (confirmation: typeof ReservationConfirmationSchema.Type) =>
  `${confirmation.ref.tenantId}:${confirmation.reservation.ref.resourceId}:${confirmation.reservation.origin.attemptId}`;

const validateConfirmationHistory = (
  input: CompileInventoryHistoricalEvidenceInput,
): InventoryHistoricalEvidenceRejected['reason'] | undefined => {
  const groups = new Map<string, typeof input.confirmationHistory>();
  for (const confirmation of input.confirmationHistory) {
    if (confirmation.ref.tenantId !== input.reservation.ref.tenantId) {
      return 'TENANT_SCOPE_MISMATCH';
    }
    const key = confirmationGroupKey(confirmation);
    groups.set(key, [...(groups.get(key) ?? []), confirmation]);
  }
  for (const history of groups.values()) {
    const [first] = history.toSorted((left, right) => left.revision - right.revision);
    if (first === undefined) {
      continue;
    }
    const revisions = new Set<number>();
    for (const confirmation of history) {
      if (
        !sameRef(confirmation.ref, first.ref) ||
        !sameRef(confirmation.reservation.ref, first.reservation.ref) ||
        confirmation.reservation.origin.attemptId !== first.reservation.origin.attemptId
      ) {
        return 'CONFIRMATION_IDENTITY_CONFLICT';
      }
      if (revisions.has(confirmation.revision)) {
        return 'CONFIRMATION_IDENTITY_CONFLICT';
      }
      revisions.add(confirmation.revision);
      if (
        confirmation.issuedAt !== first.issuedAt ||
        confirmation.expiresAt !== first.expiresAt ||
        !sameRank(confirmation.issuanceRank, first.issuanceRank) ||
        !sameIssuer(confirmation.authorityEvidence.issuer, first.authorityEvidence.issuer) ||
        confirmation.authorityEvidence.effectId !== first.authorityEvidence.effectId
      ) {
        return 'CONFIRMATION_RANK_REWRITTEN';
      }
    }
  }
  const subject = input.confirmationHistory.filter(
    (confirmation) =>
      sameRef(confirmation.reservation.ref, input.reservation.ref) &&
      confirmation.reservation.origin.attemptId === input.reservation.origin.attemptId,
  );
  return subject.some(
    (confirmation) =>
      !sameRequirements(confirmation.reservation.requirements, input.reservation.requirements) ||
      !sameConfiguration(confirmation.reservation.authority, input.reservation.authority),
  )
    ? 'CONFIRMATION_LINEAGE_MISMATCH'
    : undefined;
};

const validateConfirmationTransitions = Effect.fn('InventoryHistoricalEvidence.validateConfirmationTransitions')(
  function* validateTransitions(input: CompileInventoryHistoricalEvidenceInput) {
    const groups = Map.groupBy(input.confirmationHistory, confirmationGroupKey);
    yield* Effect.forEach(
      groups.values(),
      (history) => {
        const ordered = history.toSorted((left, right) => left.revision - right.revision);
        const [first, ...rest] = ordered;
        if (
          first === undefined ||
          first.revision !== 1 ||
          !Schema.is(HistoricalIssuedObservationSchema)(first.health.observation)
        ) {
          return Effect.fail(rejected('CONFIRMATION_HISTORY_INVALID'));
        }
        return Effect.reduce(
          rest,
          () => first,
          (previous, current) => {
            if (
              current.revision !== previous.revision + 1 ||
              Schema.is(HistoricalIssuedObservationSchema)(current.health.observation)
            ) {
              return Effect.fail(rejected('CONFIRMATION_HISTORY_INVALID'));
            }
            return advanceReservationConfirmationHealth(previous, current.health.observation).pipe(
              Effect.mapError((cause) => Object.assign(rejected('CONFIRMATION_HISTORY_INVALID'), { cause })),
              Effect.flatMap((advanced) =>
                sameConfirmation(advanced, current)
                  ? Effect.succeed(current)
                  : Effect.fail(rejected('CONFIRMATION_HISTORY_INVALID')),
              ),
            );
          },
        );
      },
      { concurrency: 1, discard: true },
    );
  },
);

const validateShortageHistory = Effect.fn('InventoryHistoricalEvidence.validateShortageHistory')(
  function* validateShortage(input: CompileInventoryHistoricalEvidenceInput) {
    yield* Effect.forEach(
      input.shortageDecisions,
      (decision) =>
        evaluateReservationShortageImpact(decision.input).pipe(
          Effect.mapError((cause) => Object.assign(rejected('SHORTAGE_RANK_MISMATCH'), { cause })),
          Effect.flatMap((authoritative) => {
            const decisionEpoch = DateTime.toEpochMillis(DateTime.makeUnsafe(decision.decidedAt));
            const futureEvidence = decision.input.candidates.some(
              ({ confirmation }) =>
                DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.health.observation.effectiveAt)) >
                decisionEpoch,
            );
            return sameShortageEvaluation(authoritative, decision.evaluation) && !futureEvidence
              ? Effect.void
              : Effect.fail(rejected('SHORTAGE_RANK_MISMATCH'));
          }),
        ),
      { concurrency: 1, discard: true },
    );
  },
);

const validateBackendLineage = (
  input: CompileInventoryHistoricalEvidenceInput,
): typeof InventoryBackendConfigurationSchema.Type | undefined => {
  let current = input.reservation.authority;
  const establishedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(input.reservation.establishedAt));
  if (
    String(current.tenantId) !== String(input.reservation.ref.tenantId) ||
    DateTime.toEpochMillis(DateTime.makeUnsafe(current.selectedAt)) > establishedAt ||
    input.reservation.requirements.some(
      (requirement) =>
        String(requirement.bindingRef.tenantId) !== String(current.tenantId) ||
        requirement.catalogSelection.productRef.tenantId !== current.tenantId ||
        String(requirement.stockItem.stockItemRef.tenantId) !== String(current.tenantId) ||
        requirement.unitRef.tenantId !== current.tenantId ||
        requirement.allocations.some(
          (allocation) =>
            allocation.positionRef.tenantId !== current.tenantId ||
            String(allocation.stockItemRef.tenantId) !== String(current.tenantId) ||
            allocation.quantity.unitRef.tenantId !== current.tenantId,
        ),
    )
  ) {
    return undefined;
  }
  let previousBoundary = establishedAt;
  for (const transition of input.backendTransitions) {
    const boundary = DateTime.toEpochMillis(DateTime.makeUnsafe(transition.effectiveBoundary));
    if (
      !sameConfiguration(transition.preCutoverConfiguration, current) ||
      String(transition.preCutoverConfiguration.tenantId) !== String(input.reservation.ref.tenantId) ||
      transition.preCutoverConfiguration.customerConfigurationId !==
        input.reservation.authority.customerConfigurationId ||
      transition.preCutoverConfiguration.tenantId !== transition.postCutoverConfiguration.tenantId ||
      transition.preCutoverConfiguration.customerConfigurationId !==
        transition.postCutoverConfiguration.customerConfigurationId ||
      transition.postCutoverConfiguration.selectedAt !== transition.effectiveBoundary ||
      DateTime.toEpochMillis(DateTime.makeUnsafe(transition.preCutoverConfiguration.selectedAt)) >= boundary ||
      boundary <= previousBoundary ||
      transition.preCutoverConfiguration.configurationId === transition.postCutoverConfiguration.configurationId ||
      transition.preCutoverConfiguration.selection.backendId === transition.postCutoverConfiguration.selection.backendId
    ) {
      return undefined;
    }
    current = transition.postCutoverConfiguration;
    previousBoundary = boundary;
  }
  return current;
};

const sameReservation = Schema.toEquivalence(ProvisionalInventoryReservationSchema);

const knownAuthorities = (input: CompileInventoryHistoricalEvidenceInput) => [
  input.reservation.authority,
  ...input.backendTransitions.flatMap(({ postCutoverConfiguration, preCutoverConfiguration }) => [
    preCutoverConfiguration,
    postCutoverConfiguration,
  ]),
];

const allAllocations = (input: CompileInventoryHistoricalEvidenceInput) =>
  input.reservation.requirements.flatMap(({ allocations }) => allocations);

const correlationAllocations = (
  input: CompileInventoryHistoricalEvidenceInput,
  evidence: InventoryHistoricalRelatedEvidence,
) => {
  const allocationIds = new Set(evidence.correlation.allocationIds.map(String));
  const positionKeys = new Set(
    evidence.correlation.positionRefs.map(({ resourceId, tenantId }) => `${tenantId}:${resourceId}`),
  );
  return allAllocations(input).filter(
    ({ allocationId, positionRef }) =>
      allocationIds.has(String(allocationId)) && positionKeys.has(`${positionRef.tenantId}:${positionRef.resourceId}`),
  );
};

const authorityRefMatches = (
  authority: typeof InventoryBackendConfigurationSchema.Type,
  ref: { readonly resourceId: string; readonly tenantId: string },
) => authority.configurationId === ref.resourceId && authority.tenantId === ref.tenantId;

const physicalRequestMatches = (
  request: Pick<
    (typeof PhysicalStockEffectRecordSchema.Type)['request'],
    | 'backend'
    | 'backendConfigurationRef'
    | 'backendId'
    | 'customerConfigurationId'
    | 'effectId'
    | 'positionRef'
    | 'quantity'
    | 'stockItemRef'
  >,
  expectedEffectId: string,
  authority: typeof InventoryBackendConfigurationSchema.Type,
  allocations: readonly (typeof InventoryStockAllocationSchema.Type)[],
) =>
  String(request.effectId) === expectedEffectId &&
  authorityRefMatches(authority, request.backendConfigurationRef) &&
  request.customerConfigurationId === authority.customerConfigurationId &&
  request.backend === authority.selection.backend &&
  request.backendId === authority.selection.backendId &&
  allocations.length === 1 &&
  allocations.every(
    (allocation) =>
      sameRef(allocation.positionRef, request.positionRef) &&
      sameRef(allocation.stockItemRef, request.stockItemRef) &&
      sameRef(allocation.quantity.unitRef, request.quantity.unitRef) &&
      allocation.quantity.amount === request.quantity.amount,
  );

const effectLedgerMatches = (
  input: CompileInventoryHistoricalEvidenceInput,
  evidence: Extract<InventoryHistoricalRelatedEvidence, { readonly _tag: 'EFFECT_LEDGER' }>,
  allocations: readonly (typeof InventoryStockAllocationSchema.Type)[],
) => {
  const { authority, effectId } = evidence.correlation;
  const fullReservationCoverage = allocations.length === allAllocations(input).length;
  return (
    String(evidence.value.effectId) === effectId &&
    Match.value(evidence.value.intent).pipe(
      Match.tag(
        'RESERVATION_CREATE',
        ({ request }) =>
          String(request.effectId) === effectId &&
          fullReservationCoverage &&
          sameRef(request.reservation.ref, input.reservation.ref) &&
          request.reservation.origin.attemptId === input.reservation.origin.attemptId &&
          sameRequirements(request.reservation.requirements, input.reservation.requirements) &&
          sameConfiguration(request.authority, authority),
      ),
      Match.tag(
        'RESERVATION_RELEASE',
        ({ request }) =>
          String(request.effectId) === effectId &&
          fullReservationCoverage &&
          sameReservation(request.reservation, input.reservation) &&
          sameConfiguration(authority, input.reservation.authority),
      ),
      Match.tag(
        'ESTABLISH_COMMITMENT_PROTECTION',
        ({ request }) =>
          String(request.effectId) === effectId &&
          fullReservationCoverage &&
          sameReservation(request.confirmation.reservation, input.reservation) &&
          sameConfiguration(authority, input.reservation.authority),
      ),
      Match.tag('PHYSICAL_RECEIPT', ({ request }) => physicalRequestMatches(request, effectId, authority, allocations)),
      Match.tag('PHYSICAL_ISSUE', ({ request }) => physicalRequestMatches(request, effectId, authority, allocations)),
      Match.exhaustive,
    )
  );
};

const relatedVariantMatches = (
  input: CompileInventoryHistoricalEvidenceInput,
  evidence: InventoryHistoricalRelatedEvidence,
  allocations: readonly (typeof InventoryStockAllocationSchema.Type)[],
): boolean =>
  Match.value(evidence).pipe(
    Match.tag(
      'COMMITMENT_PROTECTION',
      ({ correlation, value }) =>
        String(value.authorityEvidence.effectId) === correlation.effectId &&
        allocations.length === allAllocations(input).length &&
        sameReservation(value.confirmation.reservation, input.reservation) &&
        sameConfiguration(correlation.authority, input.reservation.authority) &&
        sameIssuer(value.authorityEvidence.issuer, value.confirmation.authorityEvidence.issuer),
    ),
    Match.tag(
      'RESERVATION_RELEASE',
      ({ correlation, value }) =>
        String(value.request.effectId) === correlation.effectId &&
        allocations.length === allAllocations(input).length &&
        sameReservation(value.request.reservation, input.reservation) &&
        sameConfiguration(correlation.authority, input.reservation.authority),
    ),
    Match.tag(
      'SOURCE_ASSERTION',
      ({ correlation, value }) =>
        String(value.assertionId) === correlation.effectId &&
        sameConfiguration(value.authorityConfiguration, correlation.authority) &&
        value.customerConfigurationId === correlation.authority.customerConfigurationId &&
        correlation.positionRefs.length === 1 &&
        allocations.every(
          (allocation) =>
            sameRef(allocation.positionRef, value.positionRef) &&
            sameRef(allocation.stockItemRef, value.stockItemRef) &&
            sameRef(allocation.quantity.unitRef, value.quantity.unitRef),
        ),
    ),
    Match.tag(
      'STOCK_CORRECTION',
      ({ correlation, value }) =>
        String(value.correctionId) === correlation.effectId &&
        authorityRefMatches(correlation.authority, value.authorityConfigurationRef) &&
        value.customerConfigurationId === correlation.authority.customerConfigurationId &&
        correlation.positionRefs.length === 1 &&
        allocations.every((allocation) => sameRef(allocation.positionRef, value.positionRef)),
    ),
    Match.tag(
      'PHYSICAL_STOCK_EFFECT',
      ({ correlation, value }) =>
        String(value.request.effectId) === correlation.effectId &&
        physicalRequestMatches(value.request, correlation.effectId, correlation.authority, allocations),
    ),
    Match.tag('EFFECT_LEDGER', (ledger) => effectLedgerMatches(input, ledger, allocations)),
    Match.exhaustive,
  );

const validateRelatedEvidence = (
  input: CompileInventoryHistoricalEvidenceInput,
): InventoryHistoricalEvidenceRejected['reason'] | undefined => {
  const authorities = knownAuthorities(input);
  for (const evidence of input.relatedEvidence) {
    const { correlation } = evidence;
    const allocations = correlationAllocations(input, evidence);
    if (
      !sameRef(correlation.reservationRef, input.reservation.ref) ||
      correlation.attemptId !== input.reservation.origin.attemptId ||
      !authorities.some((authority) => sameConfiguration(authority, correlation.authority)) ||
      allocations.length !== correlation.allocationIds.length ||
      new Set(allocations.map(({ positionRef }) => `${positionRef.tenantId}:${positionRef.resourceId}`)).size !==
        correlation.positionRefs.length ||
      !relatedVariantMatches(input, evidence, allocations)
    ) {
      return 'RELATED_EVIDENCE_SCOPE_MISMATCH';
    }
  }
  return undefined;
};

const validateCommittedLineage = (
  input: CompileInventoryHistoricalEvidenceInput,
): InventoryHistoricalEvidenceRejected['reason'] | undefined => {
  for (const lineage of input.committedLineage) {
    const valid = Match.value(lineage).pipe(
      Match.tag(
        'RUNTIME_COMMITTED',
        ({ obligation }) =>
          sameRef(obligation.ref, input.reservation.ref) &&
          obligation.origin.attemptId === input.reservation.origin.attemptId &&
          sameRequirements(obligation.requirements, input.reservation.requirements) &&
          sameConfiguration(obligation.authority, input.reservation.authority),
      ),
      Match.tag(
        'IMPORTED_COMMITTED',
        ({ obligation }) =>
          obligation.ref.tenantId === input.reservation.ref.tenantId &&
          obligation.authority.customerConfigurationId === input.reservation.authority.customerConfigurationId &&
          obligation.runtimeAttemptId === null &&
          obligation.origin.kind === 'IMPORTED_PROVEN_ORDER' &&
          obligation.orderProof.sourceOrderId === obligation.origin.sourceOrderId &&
          obligation.orderProof.sourceSystem === obligation.origin.sourceSystem,
      ),
      Match.exhaustive,
    );
    if (!valid) {
      return 'COMMITTED_LINEAGE_MISMATCH';
    }
  }
  return undefined;
};

interface TerminalResolutionEvidence {
  readonly observedAt: typeof auditInstant.Type;
  readonly ownerEvidenceRef: string;
  readonly state: 'REJECTED' | 'SUCCEEDED';
}

const terminalPhysicalEvidence = (
  effect: Extract<
    typeof PhysicalStockEffectRecordSchema.Type,
    { readonly _tag: 'APPLIED' | 'INDETERMINATE' | 'REJECTED' | 'REQUESTED' }
  >,
  expectedEffectId: string,
): TerminalResolutionEvidence | null =>
  Match.value(effect).pipe(
    Match.tag('APPLIED', ({ evidence, request }) =>
      String(request.effectId) === expectedEffectId && String(evidence.effectId) === expectedEffectId
        ? {
            observedAt: evidence.appliedAt,
            ownerEvidenceRef: evidence.backendEvidenceRef,
            state: 'SUCCEEDED' as const,
          }
        : null,
    ),
    Match.tag('INDETERMINATE', () => null),
    Match.tag('REJECTED', () => null),
    Match.tag('REQUESTED', () => null),
    Match.exhaustive,
  );

const terminalResolutionEvidence = (
  resolution: typeof InventoryEffectLedgerResolutionSchema.Type,
  expectedEffectId: string,
): TerminalResolutionEvidence | null =>
  Match.value(resolution).pipe(
    Match.tag('RESERVATION_CREATE', ({ effect }) =>
      String(effect.request.effectId) === expectedEffectId
        ? Match.value(effect).pipe(
            Match.tag('ESTABLISHED', ({ ownerEvidenceRef, reservation }) => ({
              observedAt: reservation.establishedAt,
              ownerEvidenceRef,
              state: 'SUCCEEDED' as const,
            })),
            Match.tag('RESOLVED_NO_RESERVATION', ({ preCommitCompensation }) =>
              preCommitCompensation === undefined
                ? null
                : {
                    observedAt: preCommitCompensation.cleanedAt,
                    ownerEvidenceRef: preCommitCompensation.cleanupEvidenceRef,
                    state: 'REJECTED' as const,
                  },
            ),
            Match.tag('INDETERMINATE', () => null),
            Match.tag('RECONCILIATION_REQUIRED', () => null),
            Match.tag('REQUESTED', () => null),
            Match.exhaustive,
          )
        : null,
    ),
    Match.tag('RESERVATION_RELEASE', ({ effect }) =>
      String(effect.request.effectId) === expectedEffectId
        ? Match.value(effect).pipe(
            Match.tag('RELEASED', ({ ownerEvidenceRef, releasedAt }) => ({
              observedAt: releasedAt,
              ownerEvidenceRef,
              state: 'SUCCEEDED' as const,
            })),
            Match.tag('NOT_RELEASABLE', ({ evidenceRef, observedAt }) => ({
              observedAt,
              ownerEvidenceRef: evidenceRef,
              state: 'REJECTED' as const,
            })),
            Match.tag('INDETERMINATE', () => null),
            Match.tag('REQUESTED', () => null),
            Match.exhaustive,
          )
        : null,
    ),
    Match.tag('ESTABLISH_COMMITMENT_PROTECTION', ({ effect }) =>
      String(effect.request.effectId) === expectedEffectId
        ? Match.value(effect).pipe(
            Match.tag('PROTECTED', ({ protection }) => ({
              observedAt: protection.establishedAt,
              ownerEvidenceRef: protection.authorityEvidence.evidence.ownerEvidenceRef,
              state: 'SUCCEEDED' as const,
            })),
            Match.tag('NOT_PROTECTABLE', () => null),
            Match.exhaustive,
          )
        : null,
    ),
    Match.tag('PHYSICAL_RECEIPT', ({ effect }) => terminalPhysicalEvidence(effect, expectedEffectId)),
    Match.tag('PHYSICAL_ISSUE', ({ effect }) => terminalPhysicalEvidence(effect, expectedEffectId)),
    Match.exhaustive,
  );

const validateReconciliationLineage = (
  input: CompileInventoryHistoricalEvidenceInput,
): InventoryHistoricalEvidenceRejected['reason'] | undefined => {
  const ledgers = input.relatedEvidence.filter(
    (evidence): evidence is Extract<InventoryHistoricalRelatedEvidence, { readonly _tag: 'EFFECT_LEDGER' }> =>
      Schema.is(InventoryHistoricalEffectLedgerEvidenceSchema)(evidence),
  );
  for (const interval of input.reconciliationIntervals) {
    const ledger = ledgers.find(({ value }) => String(value.effectId) === String(interval.effectId));
    const ledgerResolution = ledger?.value.resolution;
    const resolution = interval.finalResolution;
    const partialEffectsBound = interval.possiblePartialEffectIds.every((effectId) =>
      ledgers.some(
        (candidate) =>
          String(candidate.value.effectId) === String(effectId) &&
          candidate.correlation.attemptId === interval.attemptId,
      ),
    );
    const terminalEvidence =
      ledgerResolution === null || ledgerResolution === undefined
        ? null
        : terminalResolutionEvidence(ledgerResolution, String(interval.effectId));
    if (
      interval.attemptId !== input.reservation.origin.attemptId ||
      ledger === undefined ||
      !partialEffectsBound ||
      DateTime.toEpochMillis(DateTime.makeUnsafe(interval.indeterminateFrom)) <
        DateTime.toEpochMillis(DateTime.makeUnsafe(ledger.value.requestedAt)) ||
      (resolution === null && ledger.value.currentState !== 'INDETERMINATE') ||
      (resolution !== null &&
        (ledger.value.currentState !== resolution.state ||
          ledgerResolution === null ||
          terminalEvidence === null ||
          terminalEvidence.state !== resolution.state ||
          terminalEvidence.ownerEvidenceRef !== resolution.ownerEvidenceRef ||
          terminalEvidence.observedAt !== resolution.resolvedAt ||
          DateTime.toEpochMillis(DateTime.makeUnsafe(resolution.resolvedAt)) <
            DateTime.toEpochMillis(DateTime.makeUnsafe(interval.indeterminateFrom))))
    ) {
      return 'RECONCILIATION_LINEAGE_MISMATCH';
    }
  }
  return undefined;
};

export const compileInventoryHistoricalEvidence = Effect.fn('InventoryHistoricalEvidence.compile')(function* compile(
  input: CompileInventoryHistoricalEvidenceInput,
) {
  const requirementFailure = validateRequirementEvidence(input);
  if (requirementFailure !== undefined) {
    return yield* rejected(requirementFailure);
  }
  const confirmationFailure = validateConfirmationHistory(input);
  if (confirmationFailure !== undefined) {
    return yield* rejected(confirmationFailure);
  }
  yield* validateConfirmationTransitions(input);
  yield* validateShortageHistory(input);
  const relatedEvidenceFailure = validateRelatedEvidence(input);
  if (relatedEvidenceFailure !== undefined) {
    return yield* rejected(relatedEvidenceFailure);
  }
  const committedFailure = validateCommittedLineage(input);
  if (committedFailure !== undefined) {
    return yield* rejected(committedFailure);
  }
  const reconciliationFailure = validateReconciliationLineage(input);
  if (reconciliationFailure !== undefined) {
    return yield* rejected(reconciliationFailure);
  }
  const lineage = validateBackendLineage(input);
  if (lineage === undefined) {
    return yield* rejected('BACKEND_LINEAGE_MISMATCH');
  }
  return yield* Schema.decodeEffect(InventoryHistoricalEvidencePacketSchema)({
    _tag: 'InventoryHistoricalEvidencePacket',
    ...input,
    authorityRewriteApplied: false,
    currentAuthority: lineage,
    historicalAllocationSubstitutionApplied: false,
    historicalAuthority: input.reservation.authority,
    rawProviderPayloadRetained: false,
  }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_HISTORICAL_EVIDENCE'), { cause })));
});
