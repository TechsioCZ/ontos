import { DateTime, Match, Schema } from 'effect';

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
    reason: Schema.Literals([
      'PRE_CUTOVER_AUTHORITY_NOT_BEFORE_BOUNDARY',
      'POST_CUTOVER_AUTHORITY_NOT_AT_BOUNDARY',
      'READINESS_EVALUATED_BEFORE_BOUNDARY',
    ]),
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

export const InventoryBackendCutoverReadySchema = Schema.TaggedStruct('READY', {
  evaluatedAt: cutoverInstant,
  transition: InventoryBackendAuthorityTransitionSchema,
});

export const InventoryBackendCutoverResultSchema = Schema.Union([
  InventoryBackendRetainedSchema,
  InventoryBackendCutoverBlockedSchema,
  InventoryBackendCutoverReadySchema,
]);
export type InventoryBackendCutoverResult = typeof InventoryBackendCutoverResultSchema.Type;

const epoch = (instant: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));

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

const evaluateReplacement = (
  input: typeof ReplaceSelectedInventoryBackendInputSchema.Type,
): InventoryBackendCutoverResult => {
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
  if (epoch(input.evaluatedAt) < epoch(input.effectiveBoundary)) {
    blockers.push({ _tag: 'AUTHORITY_BOUNDARY_MISMATCH', reason: 'READINESS_EVALUATED_BEFORE_BOUNDARY' });
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
    evaluatedAt: input.evaluatedAt,
    transition: {
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
