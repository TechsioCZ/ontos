import { DateTime, Match, Result, Schema } from 'effect';

import {
  InventoryBackendConfigurationSchema,
  sameInventoryBackendSelection,
} from './inventory-backend-configuration.ts';
import {
  InventoryOpeningEvaluationInputSchema,
  InventoryOpeningPacketSchema,
  InventoryOpeningReadinessBlockerSchema,
  InventoryOpeningReadySchema,
  evaluateInventoryOpeningPacket,
} from './inventory-opening-stock-and-open-obligations.ts';
import {
  InventoryEffectLedgerKindSchema,
  InventoryEffectLedgerRecordSchema,
  ReservationCreateInventoryEffectLedgerIntentSchema,
} from './inventory-effect-ledger.ts';
import { EstablishedReservationCreateEffectSchema } from './inventory-reservation-create.ts';
import { ProvisionalInventoryReservationSchema } from './inventory-obligation.ts';

const cutoverInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const RetainSelectedInventoryBackendInputSchema = Schema.TaggedStruct('RETAIN_SELECTED_BACKEND', {
  currentConfiguration: InventoryBackendConfigurationSchema,
  evaluatedAt: cutoverInstant,
});

export const ReplaceSelectedInventoryBackendInputSchema = Schema.TaggedStruct('REPLACE_SELECTED_BACKEND', {
  effectiveBoundary: cutoverInstant,
  evaluatedAt: cutoverInstant,
  openingFacts: InventoryOpeningEvaluationInputSchema,
  postCutoverConfiguration: InventoryBackendConfigurationSchema,
  preCutoverConfiguration: InventoryBackendConfigurationSchema,
  rollbackPolicy: Schema.Literal('PRESERVE_PROVEN_COMMITTED_FACTS'),
  scope: Schema.Literal('WHOLE_CUSTOMER_CONFIGURATION'),
});

export const InventoryBackendCutoverInputSchema = Schema.Union([
  RetainSelectedInventoryBackendInputSchema,
  ReplaceSelectedInventoryBackendInputSchema,
]);
export type InventoryBackendCutoverInput = typeof InventoryBackendCutoverInputSchema.Type;

export const InventoryBackendRetainedSchema = Schema.TaggedStruct('NO_REPLACEMENT_REQUIRED', {
  evaluatedAt: cutoverInstant,
  migrationRequired: Schema.Literal(false),
  runtimeAuthorityMode: Schema.Literal('SINGLE_SELECTED_BACKEND'),
  selectedConfiguration: InventoryBackendConfigurationSchema,
});

export const InventoryBackendCutoverScopeMismatchSchema = Schema.TaggedStruct('CUTOVER_SCOPE_MISMATCH', {});
export const InventoryBackendCutoverBackendUnchangedSchema = Schema.TaggedStruct('BACKEND_UNCHANGED', {});
export const InventoryBackendCutoverConfigurationIdentityReusedSchema = Schema.TaggedStruct(
  'CONFIGURATION_IDENTITY_REUSED',
  {},
);
export const InventoryBackendCutoverAuthorityBoundaryMismatchSchema = Schema.TaggedStruct(
  'AUTHORITY_BOUNDARY_MISMATCH',
  {
    reason: Schema.Literals(['PRE_CUTOVER_AUTHORITY_NOT_BEFORE_BOUNDARY', 'POST_CUTOVER_AUTHORITY_NOT_AT_BOUNDARY']),
  },
);
export const InventoryBackendCutoverOpeningConfigurationMismatchSchema = Schema.TaggedStruct(
  'OPENING_CONFIGURATION_MISMATCH',
  {},
);
export const InventoryBackendCutoverOpeningNotReadySchema = Schema.TaggedStruct('OPENING_NOT_READY', {
  openingBlockers: Schema.NonEmptyArray(InventoryOpeningReadinessBlockerSchema),
});
export const InventoryBackendCutoverProvisionalReservationSchema = Schema.TaggedStruct(
  'PROVISIONAL_RESERVATION_REMAINS',
  { reservationRef: ProvisionalInventoryReservationSchema.fields.ref },
);
export const InventoryBackendCutoverUnresolvedEffectSchema = Schema.TaggedStruct('UNRESOLVED_PRE_CUTOVER_EFFECT', {
  effectId: InventoryEffectLedgerRecordSchema.fields.effectId,
  kind: InventoryEffectLedgerKindSchema,
  state: Schema.Literals(['REQUESTED', 'INDETERMINATE']),
});
export const InventoryBackendCutoverMissingObligationSchema = Schema.TaggedStruct(
  'SUCCESSFUL_CREATE_OBLIGATION_MISSING',
  {
    effectId: InventoryEffectLedgerRecordSchema.fields.effectId,
    reservationRef: ProvisionalInventoryReservationSchema.fields.ref,
  },
);

export const InventoryBackendCutoverBlockerSchema = Schema.Union([
  InventoryBackendCutoverScopeMismatchSchema,
  InventoryBackendCutoverBackendUnchangedSchema,
  InventoryBackendCutoverConfigurationIdentityReusedSchema,
  InventoryBackendCutoverAuthorityBoundaryMismatchSchema,
  InventoryBackendCutoverOpeningConfigurationMismatchSchema,
  InventoryBackendCutoverOpeningNotReadySchema,
  InventoryBackendCutoverProvisionalReservationSchema,
  InventoryBackendCutoverUnresolvedEffectSchema,
  InventoryBackendCutoverMissingObligationSchema,
]);
export type InventoryBackendCutoverBlocker = typeof InventoryBackendCutoverBlockerSchema.Type;

export const InventoryBackendCutoverBlockedSchema = Schema.TaggedStruct('BLOCKED', {
  blockers: Schema.NonEmptyArray(InventoryBackendCutoverBlockerSchema),
  evaluatedAt: cutoverInstant,
  reconciliationRequired: Schema.Literal(true),
  scope: Schema.Literal('WHOLE_CUSTOMER_CONFIGURATION'),
});

export const InventoryBackendAuthorityTransitionSchema = Schema.Struct({
  customerConfigurationId: InventoryBackendConfigurationSchema.fields.customerConfigurationId,
  cutoverPurpose: Schema.Literal('PLANNED_BACKEND_REPLACEMENT_NOT_OUTAGE_RECOVERY'),
  effectiveBoundary: cutoverInstant,
  latePreCutoverEvidencePolicy: Schema.Literal('HISTORICAL_OR_RECONCILIATION_ONLY'),
  migrationToolingAuthority: Schema.Literal('NONE'),
  openingPacket: InventoryOpeningPacketSchema,
  postCutoverAuthorityStartsAt: cutoverInstant,
  postCutoverConfiguration: InventoryBackendConfigurationSchema,
  preCutoverAuthorityValidBefore: cutoverInstant,
  preCutoverConfiguration: InventoryBackendConfigurationSchema,
  rollbackPolicy: Schema.Literal('PRESERVE_PROVEN_COMMITTED_FACTS'),
  runtimeAuthorityMode: Schema.Literal('SINGLE_SELECTED_BACKEND'),
  scope: Schema.Literal('WHOLE_CUSTOMER_CONFIGURATION'),
  unresolvedEffectPolicy: Schema.Literal('BLOCK_SWITCH_AND_NEVER_REPEAT_AS_FRESH_EFFECT'),
});

const InventoryBackendCutoverConfigurationFenceSchema = Schema.Struct({
  configurationId: InventoryBackendConfigurationSchema.fields.configurationId,
  customerConfigurationId: InventoryBackendConfigurationSchema.fields.customerConfigurationId,
  revision: InventoryBackendConfigurationSchema.fields.revision,
  tenantId: InventoryBackendConfigurationSchema.fields.tenantId,
});

export const InventoryBackendCutoverReadinessFenceSchema = Schema.TaggedStruct('CUTOVER_READINESS_FENCE', {
  effectiveBoundary: cutoverInstant,
  effectLedgerStateIdentity: Schema.String,
  identity: Schema.String,
  obligationSetIdentity: Schema.String,
  openingPacketIdentity: Schema.String,
  ownerFactsIdentity: Schema.String,
  postCutoverConfiguration: InventoryBackendCutoverConfigurationFenceSchema,
  preCutoverConfiguration: InventoryBackendCutoverConfigurationFenceSchema,
});
export type InventoryBackendCutoverReadinessFence = typeof InventoryBackendCutoverReadinessFenceSchema.Type;

export const InventoryBackendCutoverReadySchema = Schema.TaggedStruct('READY', {
  authorityStatus: Schema.Literal('PRE_CUTOVER_BACKEND_REMAINS_AUTHORITATIVE'),
  evaluatedAt: cutoverInstant,
  readinessFence: InventoryBackendCutoverReadinessFenceSchema,
  transitionCandidate: InventoryBackendAuthorityTransitionSchema,
});

export const InventoryBackendCutoverReadinessResultSchema = Schema.Union([
  InventoryBackendCutoverBlockedSchema,
  InventoryBackendCutoverReadySchema,
]);
export type InventoryBackendCutoverReadinessResult = typeof InventoryBackendCutoverReadinessResultSchema.Type;

export const InventoryBackendCutoverAuthorizationTimeMismatchSchema = Schema.TaggedStruct(
  'BOUNDARY_AUTHORIZATION_TIME_MISMATCH',
  {
    effectiveBoundary: cutoverInstant,
    reason: Schema.Literals([
      'BEFORE_EFFECTIVE_BOUNDARY',
      'AFTER_EFFECTIVE_BOUNDARY',
      'CURRENT_FACTS_NOT_EVALUATED_AT_BOUNDARY',
    ]),
  },
);
export const InventoryBackendCutoverStaleReadinessFenceSchema = Schema.TaggedStruct('STALE_READINESS_FENCE', {
  currentReadinessIdentity: Schema.String,
  expectedReadinessIdentity: Schema.String,
});
export const InventoryBackendCutoverAuthorizationBlockerSchema = Schema.Union([
  InventoryBackendCutoverBlockerSchema,
  InventoryBackendCutoverAuthorizationTimeMismatchSchema,
  InventoryBackendCutoverStaleReadinessFenceSchema,
]);
export type InventoryBackendCutoverAuthorizationBlocker = typeof InventoryBackendCutoverAuthorizationBlockerSchema.Type;

export const AuthorizeInventoryBackendCutoverInputSchema = Schema.Struct({
  authorizedAt: cutoverInstant,
  currentFacts: ReplaceSelectedInventoryBackendInputSchema,
  readiness: InventoryBackendCutoverReadySchema,
});
export type AuthorizeInventoryBackendCutoverInput = typeof AuthorizeInventoryBackendCutoverInputSchema.Type;

export const InventoryBackendCutoverAuthorizationBlockedSchema = Schema.TaggedStruct('AUTHORIZATION_BLOCKED', {
  authorityStatus: Schema.Literal('PRE_CUTOVER_BACKEND_REMAINS_AUTHORITATIVE'),
  authorizedAt: cutoverInstant,
  blockers: Schema.NonEmptyArray(InventoryBackendCutoverAuthorizationBlockerSchema),
});

export const InventoryBackendCutoverAuthorizedSchema = Schema.TaggedStruct('AUTHORIZED', {
  authorityStatus: Schema.Literal('POST_CUTOVER_BACKEND_AUTHORITATIVE'),
  authorizedAt: cutoverInstant,
  readinessFence: InventoryBackendCutoverReadinessFenceSchema,
  transition: InventoryBackendAuthorityTransitionSchema,
});

export const InventoryBackendCutoverAuthorizationResultSchema = Schema.Union([
  InventoryBackendCutoverAuthorizationBlockedSchema,
  InventoryBackendCutoverAuthorizedSchema,
]);
export type InventoryBackendCutoverAuthorizationResult = typeof InventoryBackendCutoverAuthorizationResultSchema.Type;

export const InventoryBackendCutoverResultSchema = Schema.Union([
  InventoryBackendRetainedSchema,
  InventoryBackendCutoverBlockedSchema,
  InventoryBackendCutoverReadySchema,
]);
export type InventoryBackendCutoverResult = typeof InventoryBackendCutoverResultSchema.Type;

const epoch = (instant: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));

const InventoryBackendCutoverOpeningPacketFenceEvidenceSchema = Schema.Struct({
  obligations: InventoryOpeningPacketSchema.fields.obligations,
  selectedConfiguration: InventoryOpeningPacketSchema.fields.selectedConfiguration,
  stock: InventoryOpeningPacketSchema.fields.stock,
});
const InventoryBackendCutoverOwnerFactsFenceEvidenceSchema = Schema.Struct({
  bindings: InventoryOpeningEvaluationInputSchema.fields.bindings,
  effectLedger: InventoryOpeningEvaluationInputSchema.fields.effectLedger,
  legacyUncommittedHolds: InventoryOpeningEvaluationInputSchema.fields.legacyUncommittedHolds,
  obligations: InventoryOpeningEvaluationInputSchema.fields.obligations,
  selectedConfiguration: InventoryOpeningEvaluationInputSchema.fields.selectedConfiguration,
  stockItems: InventoryOpeningEvaluationInputSchema.fields.stockItems,
  stockPositions: InventoryOpeningEvaluationInputSchema.fields.stockPositions,
});
const InventoryBackendCutoverReadinessIdentityEvidenceSchema = Schema.Struct({
  effectiveBoundary: cutoverInstant,
  effectLedgerStateIdentity: Schema.String,
  obligationSetIdentity: Schema.String,
  openingPacketIdentity: Schema.String,
  ownerFactsIdentity: Schema.String,
  postCutoverConfiguration: InventoryBackendConfigurationSchema,
  preCutoverConfiguration: InventoryBackendConfigurationSchema,
});
const canonicalEffectLedgerFenceSchema = Schema.fromJsonString(
  InventoryOpeningEvaluationInputSchema.fields.effectLedger,
);
const canonicalObligationSetFenceSchema = Schema.fromJsonString(
  InventoryOpeningEvaluationInputSchema.fields.obligations,
);
const canonicalOpeningPacketFenceSchema = Schema.fromJsonString(
  InventoryBackendCutoverOpeningPacketFenceEvidenceSchema,
);
const canonicalOwnerFactsFenceSchema = Schema.fromJsonString(InventoryBackendCutoverOwnerFactsFenceEvidenceSchema);
const canonicalReadinessIdentitySchema = Schema.fromJsonString(InventoryBackendCutoverReadinessIdentityEvidenceSchema);

const configurationFence = ({
  configurationId,
  customerConfigurationId,
  revision,
  tenantId,
}: typeof InventoryBackendConfigurationSchema.Type) => ({
  configurationId,
  customerConfigurationId,
  revision,
  tenantId,
});

const sameConfiguration = (
  left: typeof InventoryBackendConfigurationSchema.Type,
  right: typeof InventoryBackendConfigurationSchema.Type,
): boolean =>
  left.configurationId === right.configurationId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.revision === right.revision &&
  epoch(left.selectedAt) === epoch(right.selectedAt) &&
  left.tenantId === right.tenantId &&
  sameInventoryBackendSelection(left.selection, right.selection);

const effectCustomerConfigurationId = (record: typeof InventoryEffectLedgerRecordSchema.Type): string =>
  Match.value(record.intent).pipe(
    Match.tag('RESERVATION_CREATE', ({ request }) => request.authority.customerConfigurationId),
    Match.tag('RESERVATION_RELEASE', ({ request }) => request.reservation.authority.customerConfigurationId),
    Match.tag(
      'ESTABLISH_COMMITMENT_PROTECTION',
      ({ request }) => request.confirmation.reservation.authority.customerConfigurationId,
    ),
    Match.tag('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE', ({ request }) => request.customerConfigurationId),
    Match.exhaustive,
  );

const reservationRefEquals = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const successfulCreateReservationRef = (record: typeof InventoryEffectLedgerRecordSchema.Type) => {
  if (
    record.currentState !== 'SUCCEEDED' ||
    !Schema.is(ReservationCreateInventoryEffectLedgerIntentSchema)(record.intent) ||
    record.resolution === null
  ) {
    return null;
  }
  return Match.value(record.resolution).pipe(
    Match.tag('RESERVATION_CREATE', ({ effect }) =>
      Schema.is(EstablishedReservationCreateEffectSchema)(effect) ? effect.reservation.ref : null,
    ),
    Match.orElse(() => null),
  );
};

const makeReadinessFence = (
  input: typeof ReplaceSelectedInventoryBackendInputSchema.Type,
  openingPacket: typeof InventoryOpeningPacketSchema.Type,
): InventoryBackendCutoverReadinessFence => {
  const effectLedger = input.openingFacts.effectLedger.toSorted((left, right) =>
    left.effectId.localeCompare(right.effectId),
  );
  const obligations = input.openingFacts.obligations.toSorted((left, right) =>
    left.ref.resourceId.localeCompare(right.ref.resourceId),
  );
  const effectLedgerStateIdentity = Result.getOrThrow(
    Schema.encodeResult(canonicalEffectLedgerFenceSchema)(effectLedger),
  );
  const obligationSetIdentity = Result.getOrThrow(Schema.encodeResult(canonicalObligationSetFenceSchema)(obligations));
  const openingPacketIdentity = Result.getOrThrow(
    Schema.encodeResult(canonicalOpeningPacketFenceSchema)({
      obligations: openingPacket.obligations.toSorted((left, right) =>
        left.ref.resourceId.localeCompare(right.ref.resourceId),
      ),
      selectedConfiguration: openingPacket.selectedConfiguration,
      stock: openingPacket.stock.toSorted((left, right) =>
        left.position.ref.resourceId.localeCompare(right.position.ref.resourceId),
      ),
    }),
  );
  const ownerFactsIdentity = Result.getOrThrow(
    Schema.encodeResult(canonicalOwnerFactsFenceSchema)({
      bindings: input.openingFacts.bindings.toSorted((left, right) =>
        left.bindingRef.resourceId.localeCompare(right.bindingRef.resourceId),
      ),
      effectLedger,
      legacyUncommittedHolds: input.openingFacts.legacyUncommittedHolds.toSorted((left, right) =>
        left.holdReference.localeCompare(right.holdReference),
      ),
      obligations,
      selectedConfiguration: input.openingFacts.selectedConfiguration,
      stockItems: input.openingFacts.stockItems.toSorted((left, right) =>
        left.stockItemRef.resourceId.localeCompare(right.stockItemRef.resourceId),
      ),
      stockPositions: input.openingFacts.stockPositions.toSorted((left, right) =>
        left.position.ref.resourceId.localeCompare(right.position.ref.resourceId),
      ),
    }),
  );
  const postCutoverConfiguration = configurationFence(input.postCutoverConfiguration);
  const preCutoverConfiguration = configurationFence(input.preCutoverConfiguration);
  const identity = Result.getOrThrow(
    Schema.encodeResult(canonicalReadinessIdentitySchema)({
      effectiveBoundary: input.effectiveBoundary,
      effectLedgerStateIdentity,
      obligationSetIdentity,
      openingPacketIdentity,
      ownerFactsIdentity,
      postCutoverConfiguration: input.postCutoverConfiguration,
      preCutoverConfiguration: input.preCutoverConfiguration,
    }),
  );

  return {
    _tag: 'CUTOVER_READINESS_FENCE',
    effectiveBoundary: input.effectiveBoundary,
    effectLedgerStateIdentity,
    identity,
    obligationSetIdentity,
    openingPacketIdentity,
    ownerFactsIdentity,
    postCutoverConfiguration,
    preCutoverConfiguration,
  };
};

const evaluateReplacement = (
  input: typeof ReplaceSelectedInventoryBackendInputSchema.Type,
): InventoryBackendCutoverReadinessResult => {
  const blockers: InventoryBackendCutoverBlocker[] = [];
  const { postCutoverConfiguration: post, preCutoverConfiguration: pre } = input;

  if (pre.tenantId !== post.tenantId || pre.customerConfigurationId !== post.customerConfigurationId) {
    blockers.push({ _tag: 'CUTOVER_SCOPE_MISMATCH' });
  }
  if (sameInventoryBackendSelection(pre.selection, post.selection)) {
    blockers.push({ _tag: 'BACKEND_UNCHANGED' });
  }
  if (pre.configurationId === post.configurationId) {
    blockers.push({ _tag: 'CONFIGURATION_IDENTITY_REUSED' });
  }
  if (epoch(pre.selectedAt) >= epoch(input.effectiveBoundary)) {
    blockers.push({ _tag: 'AUTHORITY_BOUNDARY_MISMATCH', reason: 'PRE_CUTOVER_AUTHORITY_NOT_BEFORE_BOUNDARY' });
  }
  if (epoch(post.selectedAt) !== epoch(input.effectiveBoundary)) {
    blockers.push({ _tag: 'AUTHORITY_BOUNDARY_MISMATCH', reason: 'POST_CUTOVER_AUTHORITY_NOT_AT_BOUNDARY' });
  }
  if (
    !sameConfiguration(input.openingFacts.selectedConfiguration, post) ||
    epoch(input.openingFacts.evaluatedAt) !== epoch(input.evaluatedAt)
  ) {
    blockers.push({ _tag: 'OPENING_CONFIGURATION_MISMATCH' });
  }

  const opening = evaluateInventoryOpeningPacket(input.openingFacts);
  if (!Schema.is(InventoryOpeningReadySchema)(opening)) {
    blockers.push({ _tag: 'OPENING_NOT_READY', openingBlockers: opening.blockers });
  }

  const scopedObligations = input.openingFacts.obligations.filter(
    (obligation) =>
      String(obligation.ref.tenantId) === String(pre.tenantId) &&
      obligation.authority.customerConfigurationId === pre.customerConfigurationId,
  );
  for (const obligation of scopedObligations) {
    if (Schema.is(ProvisionalInventoryReservationSchema)(obligation)) {
      blockers.push({ _tag: 'PROVISIONAL_RESERVATION_REMAINS', reservationRef: obligation.ref });
    }
  }

  const scopedEffects = input.openingFacts.effectLedger.filter(
    (record) =>
      record.tenantId === pre.tenantId && effectCustomerConfigurationId(record) === pre.customerConfigurationId,
  );
  for (const record of scopedEffects) {
    if (record.currentState === 'REQUESTED' || record.currentState === 'INDETERMINATE') {
      blockers.push({
        _tag: 'UNRESOLVED_PRE_CUTOVER_EFFECT',
        effectId: record.effectId,
        kind: record.intent._tag,
        state: record.currentState,
      });
      continue;
    }
    const successfulReservationRef = successfulCreateReservationRef(record);
    if (
      successfulReservationRef !== null &&
      !scopedObligations.some(({ ref }) => reservationRefEquals(ref, successfulReservationRef))
    ) {
      blockers.push({
        _tag: 'SUCCESSFUL_CREATE_OBLIGATION_MISSING',
        effectId: record.effectId,
        reservationRef: successfulReservationRef,
      });
    }
  }

  const [firstBlocker, ...remainingBlockers] = blockers;
  if (firstBlocker !== undefined) {
    return {
      _tag: 'BLOCKED',
      blockers: [firstBlocker, ...remainingBlockers],
      evaluatedAt: input.evaluatedAt,
      reconciliationRequired: true,
      scope: 'WHOLE_CUSTOMER_CONFIGURATION',
    };
  }
  if (!Schema.is(InventoryOpeningReadySchema)(opening)) {
    return {
      _tag: 'BLOCKED',
      blockers: [{ _tag: 'OPENING_NOT_READY', openingBlockers: opening.blockers }],
      evaluatedAt: input.evaluatedAt,
      reconciliationRequired: true,
      scope: 'WHOLE_CUSTOMER_CONFIGURATION',
    };
  }
  return {
    _tag: 'READY',
    authorityStatus: 'PRE_CUTOVER_BACKEND_REMAINS_AUTHORITATIVE',
    evaluatedAt: input.evaluatedAt,
    readinessFence: makeReadinessFence(input, opening.packet),
    transitionCandidate: {
      customerConfigurationId: post.customerConfigurationId,
      cutoverPurpose: 'PLANNED_BACKEND_REPLACEMENT_NOT_OUTAGE_RECOVERY',
      effectiveBoundary: input.effectiveBoundary,
      latePreCutoverEvidencePolicy: 'HISTORICAL_OR_RECONCILIATION_ONLY',
      migrationToolingAuthority: 'NONE',
      openingPacket: opening.packet,
      postCutoverAuthorityStartsAt: input.effectiveBoundary,
      postCutoverConfiguration: post,
      preCutoverAuthorityValidBefore: input.effectiveBoundary,
      preCutoverConfiguration: pre,
      rollbackPolicy: input.rollbackPolicy,
      runtimeAuthorityMode: 'SINGLE_SELECTED_BACKEND',
      scope: input.scope,
      unresolvedEffectPolicy: 'BLOCK_SWITCH_AND_NEVER_REPEAT_AS_FRESH_EFFECT',
    },
  };
};

/**
 * Evaluates the Inventory-owned safety contract only. It neither performs provider migration nor
 * changes authority; the returned transition can be consumed by the later cutover operation.
 */
export const evaluateInventoryBackendCutover = (input: InventoryBackendCutoverInput): InventoryBackendCutoverResult =>
  Match.value(input).pipe(
    Match.tag('RETAIN_SELECTED_BACKEND', ({ currentConfiguration, evaluatedAt }) => ({
      _tag: 'NO_REPLACEMENT_REQUIRED' as const,
      evaluatedAt,
      migrationRequired: false as const,
      runtimeAuthorityMode: 'SINGLE_SELECTED_BACKEND' as const,
      selectedConfiguration: currentConfiguration,
    })),
    Match.tag('REPLACE_SELECTED_BACKEND', evaluateReplacement),
    Match.exhaustive,
  );

/** Assesses cutover readiness without changing or authorizing runtime authority. */
export const assessInventoryBackendCutoverReadiness = (
  input: typeof ReplaceSelectedInventoryBackendInputSchema.Type,
): InventoryBackendCutoverReadinessResult => evaluateReplacement(input);

const authorizationBlocked = (
  input: AuthorizeInventoryBackendCutoverInput,
  blockers: readonly [InventoryBackendCutoverAuthorizationBlocker, ...InventoryBackendCutoverAuthorizationBlocker[]],
): InventoryBackendCutoverAuthorizationResult => ({
  _tag: 'AUTHORIZATION_BLOCKED',
  authorityStatus: 'PRE_CUTOVER_BACKEND_REMAINS_AUTHORITATIVE',
  authorizedAt: input.authorizedAt,
  blockers,
});

/** Revalidates fresh owner facts at the exact boundary before authorizing the authority transition. */
export const authorizeInventoryBackendCutover = (
  input: AuthorizeInventoryBackendCutoverInput,
): InventoryBackendCutoverAuthorizationResult => {
  const authorizationEpoch = epoch(input.authorizedAt);
  const boundaryEpoch = epoch(input.readiness.transitionCandidate.effectiveBoundary);
  if (authorizationEpoch !== boundaryEpoch) {
    return authorizationBlocked(input, [
      {
        _tag: 'BOUNDARY_AUTHORIZATION_TIME_MISMATCH',
        effectiveBoundary: input.readiness.transitionCandidate.effectiveBoundary,
        reason: authorizationEpoch < boundaryEpoch ? 'BEFORE_EFFECTIVE_BOUNDARY' : 'AFTER_EFFECTIVE_BOUNDARY',
      },
    ]);
  }
  if (
    epoch(input.currentFacts.evaluatedAt) !== boundaryEpoch ||
    epoch(input.currentFacts.openingFacts.evaluatedAt) !== boundaryEpoch
  ) {
    return authorizationBlocked(input, [
      {
        _tag: 'BOUNDARY_AUTHORIZATION_TIME_MISMATCH',
        effectiveBoundary: input.readiness.transitionCandidate.effectiveBoundary,
        reason: 'CURRENT_FACTS_NOT_EVALUATED_AT_BOUNDARY',
      },
    ]);
  }

  const currentReadiness = assessInventoryBackendCutoverReadiness(input.currentFacts);
  if (Schema.is(InventoryBackendCutoverBlockedSchema)(currentReadiness)) {
    return authorizationBlocked(input, currentReadiness.blockers);
  }
  if (currentReadiness.readinessFence.identity !== input.readiness.readinessFence.identity) {
    return authorizationBlocked(input, [
      {
        _tag: 'STALE_READINESS_FENCE',
        currentReadinessIdentity: currentReadiness.readinessFence.identity,
        expectedReadinessIdentity: input.readiness.readinessFence.identity,
      },
    ]);
  }

  return {
    _tag: 'AUTHORIZED',
    authorityStatus: 'POST_CUTOVER_BACKEND_AUTHORITATIVE',
    authorizedAt: input.authorizedAt,
    readinessFence: currentReadiness.readinessFence,
    transition: currentReadiness.transitionCandidate,
  };
};
