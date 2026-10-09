import { Match, Schema } from 'effect';

import { CatalogToStockBindingSchema } from './catalog-to-stock-binding.ts';
import { ExternalStockCorrelationSchema } from './external-stock-correlation.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import {
  CommitmentProtectionInventoryEffectLedgerIntentSchema,
  InventoryEffectLedgerRecordSchema,
  ReservationCreateInventoryEffectLedgerIntentSchema,
  ReservationReleaseInventoryEffectLedgerIntentSchema,
} from './inventory-effect-ledger.ts';
import {
  ImportedCommittedObligationSchema,
  InventoryObligationSchema,
  ProvisionalInventoryReservationSchema,
} from './inventory-obligation.ts';
import {
  DeterminateInventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionEvaluationSchema,
} from './inventory-source-assertion.ts';
import { StockItemSchema } from './stock-item.ts';
import { CurrentOnHandEvidenceSchema, StockPositionSchema } from './stock-position.ts';

const boundedReference = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const openingInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const ExternalOpeningStockSourceSchema = Schema.TaggedStruct('EXTERNAL_SOURCE_ASSERTION', {
  evaluation: InventorySourceAssertionEvaluationSchema,
  itemCorrelation: ExternalStockCorrelationSchema,
  locationCorrelation: ExternalStockCorrelationSchema,
});

export const OntosWmsOpeningStockSourceSchema = Schema.TaggedStruct('ONTOS_WMS_OWNER_EVIDENCE', {
  ownerEvidenceRef: boundedReference,
});

export const InventoryOpeningStockSourceSchema = Schema.Union([
  ExternalOpeningStockSourceSchema,
  OntosWmsOpeningStockSourceSchema,
]);

export const InventoryOpeningPositionFactSchema = Schema.Struct({
  position: StockPositionSchema,
  source: InventoryOpeningStockSourceSchema,
});
export type InventoryOpeningPositionFact = typeof InventoryOpeningPositionFactSchema.Type;

const unresolvedLegacyHold = <Tag extends 'ACTIVE' | 'POSSIBLY_ACTIVE'>(tag: Tag) =>
  Schema.TaggedStruct(tag, {
    observedAt: openingInstant,
    reason: Schema.Literals(['NO_REAL_ATTEMPT', 'OWNER_OUTCOME_UNKNOWN']),
  });

export const ActiveLegacyUncommittedHoldSchema = unresolvedLegacyHold('ACTIVE');
export const PossiblyActiveLegacyUncommittedHoldSchema = unresolvedLegacyHold('POSSIBLY_ACTIVE');
export const ResolvedLegacyUncommittedHoldSchema = Schema.TaggedStruct('RESOLVED', {
  disposition: Schema.Literals(['DRAINED', 'EXPIRED', 'RELEASED', 'RECONCILED']),
  ownerEvidenceRef: boundedReference,
  resolvedAt: openingInstant,
});

export const LegacyUncommittedHoldFactSchema = Schema.Struct({
  customerConfigurationId: InventoryBackendConfigurationSchema.fields.customerConfigurationId,
  holdReference: boundedReference,
  state: Schema.Union([
    ActiveLegacyUncommittedHoldSchema,
    PossiblyActiveLegacyUncommittedHoldSchema,
    ResolvedLegacyUncommittedHoldSchema,
  ]),
  tenantId: InventoryBackendConfigurationSchema.fields.tenantId,
});

export const InventoryOpeningEvaluationInputSchema = Schema.Struct({
  bindings: Schema.Array(CatalogToStockBindingSchema),
  effectLedger: Schema.Array(InventoryEffectLedgerRecordSchema),
  evaluatedAt: openingInstant,
  legacyUncommittedHolds: Schema.Array(LegacyUncommittedHoldFactSchema),
  obligations: Schema.Array(InventoryObligationSchema),
  selectedConfiguration: InventoryBackendConfigurationSchema,
  stockItems: Schema.Array(StockItemSchema),
  stockPositions: Schema.Array(InventoryOpeningPositionFactSchema),
});
export type InventoryOpeningEvaluationInput = typeof InventoryOpeningEvaluationInputSchema.Type;

const positionBlocker = <Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) =>
  Schema.TaggedStruct(tag, {
    positionRef: StockPositionSchema.fields.ref,
    ...fields,
  });

export const InventoryOpeningPositionNotCurrentBlockerSchema = positionBlocker('POSITION_NOT_CURRENT', {});
export const InventoryOpeningPositionScopeMismatchBlockerSchema = positionBlocker('POSITION_SCOPE_MISMATCH', {});
export const InventoryOpeningPositionOwnerMismatchBlockerSchema = positionBlocker('POSITION_OWNER_MISMATCH', {});
export const InventoryOpeningStockItemNotCurrentBlockerSchema = positionBlocker('STOCK_ITEM_NOT_CURRENT', {
  stockItemRef: StockItemSchema.fields.stockItemRef,
});
export const InventoryOpeningBindingCoverageBlockerSchema = positionBlocker('BINDING_COVERAGE_INVALID', {
  candidateCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stockItemRef: StockItemSchema.fields.stockItemRef,
});
export const InventoryOpeningBindingMeaningBlockerSchema = positionBlocker('BINDING_MEANING_OR_UNIT_MISMATCH', {
  bindingRef: CatalogToStockBindingSchema.fields.bindingRef,
  stockItemRef: StockItemSchema.fields.stockItemRef,
});
export const InventoryOpeningOnHandNotCurrentBlockerSchema = positionBlocker('ON_HAND_NOT_CURRENT', {
  evidenceState: Schema.Literals(['UNKNOWN', 'MISSING', 'STALE', 'INDETERMINATE']),
});
export const InventoryOpeningSourceKindMismatchBlockerSchema = positionBlocker('OPENING_SOURCE_KIND_MISMATCH', {});
export const InventoryOpeningExternalSourceNotCurrentBlockerSchema = positionBlocker('EXTERNAL_SOURCE_NOT_CURRENT', {
  sourceState: Schema.Literals(['HISTORICAL', 'INDETERMINATE']),
});
export const InventoryOpeningExternalSourceScopeMismatchBlockerSchema = positionBlocker(
  'EXTERNAL_SOURCE_SCOPE_MISMATCH',
  {},
);
export const InventoryOpeningExternalCorrelationMismatchBlockerSchema = positionBlocker(
  'EXTERNAL_CORRELATION_MISMATCH',
  {},
);
export const InventoryOpeningPreCutoverReservationBlockerSchema = Schema.TaggedStruct(
  'PRE_CUTOVER_PROVISIONAL_RESERVATION',
  { reservationRef: ProvisionalInventoryReservationSchema.fields.ref },
);
export const InventoryOpeningUnresolvedEffectBlockerSchema = Schema.TaggedStruct('UNRESOLVED_RESERVATION_EFFECT', {
  effectId: InventoryEffectLedgerRecordSchema.fields.effectId,
  state: InventoryEffectLedgerRecordSchema.fields.currentState,
});
export const InventoryOpeningLegacyHoldBlockerSchema = Schema.TaggedStruct('LEGACY_UNCOMMITTED_HOLD', {
  holdReference: LegacyUncommittedHoldFactSchema.fields.holdReference,
  state: Schema.Literals(['ACTIVE', 'POSSIBLY_ACTIVE']),
});

export const InventoryOpeningReadinessBlockerSchema = Schema.Union([
  InventoryOpeningPositionNotCurrentBlockerSchema,
  InventoryOpeningPositionScopeMismatchBlockerSchema,
  InventoryOpeningPositionOwnerMismatchBlockerSchema,
  InventoryOpeningStockItemNotCurrentBlockerSchema,
  InventoryOpeningBindingCoverageBlockerSchema,
  InventoryOpeningBindingMeaningBlockerSchema,
  InventoryOpeningOnHandNotCurrentBlockerSchema,
  InventoryOpeningSourceKindMismatchBlockerSchema,
  InventoryOpeningExternalSourceNotCurrentBlockerSchema,
  InventoryOpeningExternalSourceScopeMismatchBlockerSchema,
  InventoryOpeningExternalCorrelationMismatchBlockerSchema,
  Schema.TaggedStruct('OBLIGATION_SCOPE_MISMATCH', {
    obligationRef: Schema.Union([
      ProvisionalInventoryReservationSchema.fields.ref,
      ImportedCommittedObligationSchema.fields.ref,
    ]),
  }),
  InventoryOpeningPreCutoverReservationBlockerSchema,
  InventoryOpeningUnresolvedEffectBlockerSchema,
  InventoryOpeningLegacyHoldBlockerSchema,
]);
export type InventoryOpeningReadinessBlocker = typeof InventoryOpeningReadinessBlockerSchema.Type;

export const InventoryOpeningPacketSchema = Schema.Struct({
  assembledAt: openingInstant,
  obligations: Schema.Array(InventoryObligationSchema),
  selectedConfiguration: InventoryBackendConfigurationSchema,
  stock: Schema.Array(
    Schema.Struct({
      binding: CatalogToStockBindingSchema,
      item: StockItemSchema,
      position: StockPositionSchema,
      source: InventoryOpeningStockSourceSchema,
    }),
  ),
});
export type InventoryOpeningPacket = typeof InventoryOpeningPacketSchema.Type;

export const InventoryOpeningReadySchema = Schema.TaggedStruct('READY', {
  packet: InventoryOpeningPacketSchema,
});
export const InventoryOpeningNotReadySchema = Schema.TaggedStruct('NOT_READY', {
  blockers: Schema.NonEmptyArray(InventoryOpeningReadinessBlockerSchema),
  evaluatedFacts: InventoryOpeningEvaluationInputSchema,
});
export const InventoryOpeningEvaluationResultSchema = Schema.Union([
  InventoryOpeningReadySchema,
  InventoryOpeningNotReadySchema,
]);
export type InventoryOpeningEvaluationResult = typeof InventoryOpeningEvaluationResultSchema.Type;

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameUnit = (
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

const selectedConfigurationRefMatches = (
  input: InventoryOpeningEvaluationInput,
  position: InventoryOpeningPositionFact['position'],
) =>
  position.onHand.ownerConfigurationRef.resourceId === input.selectedConfiguration.configurationId &&
  position.onHand.ownerConfigurationRef.tenantId === input.selectedConfiguration.tenantId;

const correlationMatchesAssertion = (
  correlation: typeof ExternalStockCorrelationSchema.Type,
  expectedRef: (typeof ExternalStockCorrelationSchema.Type)['correlationRef'],
  expectedKey: (typeof ExternalStockCorrelationSchema.Type)['externalKey'],
  expectedTarget: (typeof ExternalStockCorrelationSchema.Type)['target'],
) =>
  sameRef(correlation.correlationRef, expectedRef) &&
  correlation.externalKey.customerConfigurationId === expectedKey.customerConfigurationId &&
  correlation.externalKey.externalScope === expectedKey.externalScope &&
  correlation.externalKey.externalValue === expectedKey.externalValue &&
  correlation.externalKey.identifierKind === expectedKey.identifierKind &&
  correlation.externalKey.issuer.backendId === expectedKey.issuer.backendId &&
  correlation.externalKey.issuer.backendKind === expectedKey.issuer.backendKind &&
  correlation.externalKey.namespace === expectedKey.namespace &&
  correlation.externalKey.tenantId === expectedKey.tenantId &&
  sameRef(correlation.target.ref, expectedTarget.ref);

const positionScopeBlockers = (
  input: InventoryOpeningEvaluationInput,
  position: InventoryOpeningPositionFact['position'],
): InventoryOpeningReadinessBlocker[] => {
  const blockers: InventoryOpeningReadinessBlocker[] = [];
  if (position.lifecycle !== 'CURRENT' || position.endedAt !== null) {
    blockers.push({ _tag: 'POSITION_NOT_CURRENT', positionRef: position.ref });
  }
  if (
    position.ref.tenantId !== input.selectedConfiguration.tenantId ||
    position.scope.customerConfigurationId !== input.selectedConfiguration.customerConfigurationId
  ) {
    blockers.push({ _tag: 'POSITION_SCOPE_MISMATCH', positionRef: position.ref });
  }
  if (!selectedConfigurationRefMatches(input, position)) {
    blockers.push({ _tag: 'POSITION_OWNER_MISMATCH', positionRef: position.ref });
  }
  if (!Schema.is(CurrentOnHandEvidenceSchema)(position.onHand)) {
    blockers.push({
      _tag: 'ON_HAND_NOT_CURRENT',
      evidenceState: position.onHand._tag,
      positionRef: position.ref,
    });
  }
  return blockers;
};

interface ItemAndBindingResult {
  readonly binding: typeof CatalogToStockBindingSchema.Type | undefined;
  readonly blockers: InventoryOpeningReadinessBlocker[];
  readonly item: typeof StockItemSchema.Type | undefined;
}

const itemAndBindingResult = (
  input: InventoryOpeningEvaluationInput,
  position: InventoryOpeningPositionFact['position'],
): ItemAndBindingResult => {
  const blockers: InventoryOpeningReadinessBlocker[] = [];
  const item = input.stockItems.find(({ stockItemRef }) => sameRef(stockItemRef, position.scope.stockItemRef));
  if (item === undefined || item.lifecycle !== 'CURRENT') {
    blockers.push({
      _tag: 'STOCK_ITEM_NOT_CURRENT',
      positionRef: position.ref,
      stockItemRef: position.scope.stockItemRef,
    });
  }
  const bindings = input.bindings.filter(({ stockItemRef }) => sameRef(stockItemRef, position.scope.stockItemRef));
  const [binding] = bindings;
  if (bindings.length !== 1 || binding === undefined) {
    blockers.push({
      _tag: 'BINDING_COVERAGE_INVALID',
      candidateCount: bindings.length,
      positionRef: position.ref,
      stockItemRef: position.scope.stockItemRef,
    });
  } else if (
    item !== undefined &&
    (binding.exactSelectionMeaning.id !== item.exactSelectionMeaning.id ||
      binding.exactSelectionMeaning.kind !== item.exactSelectionMeaning.kind ||
      !sameUnit(binding.unitRef, item.unitRef) ||
      !sameUnit(binding.unitRef, position.scope.unitRef))
  ) {
    blockers.push({
      _tag: 'BINDING_MEANING_OR_UNIT_MISMATCH',
      bindingRef: binding.bindingRef,
      positionRef: position.ref,
      stockItemRef: position.scope.stockItemRef,
    });
  }
  return { binding, blockers, item };
};

const externalAssertionScopeMatches = (
  input: InventoryOpeningEvaluationInput,
  position: InventoryOpeningPositionFact['position'],
  evaluation: typeof DeterminateInventorySourceAssertionEvaluationSchema.Type,
): boolean => {
  const { assertion } = evaluation;
  return (
    sameRef(assertion.positionRef, position.ref) &&
    assertion.customerConfigurationId === input.selectedConfiguration.customerConfigurationId &&
    assertion.authorityConfiguration.configurationId === input.selectedConfiguration.configurationId &&
    assertion.issuer.backendId === input.selectedConfiguration.selection.backendId &&
    assertion.issuer.backendKind === input.selectedConfiguration.selection.backend &&
    assertion.issuerAuthority === 'SELECTED_BACKEND' &&
    sameRef(assertion.stockItemRef, position.scope.stockItemRef) &&
    sameRef(assertion.stockLocationRef, position.scope.stockLocationRef) &&
    sameUnit(assertion.quantity.unitRef, position.scope.unitRef) &&
    Schema.is(CurrentOnHandEvidenceSchema)(position.onHand) &&
    assertion.ownerEvidenceRef === position.onHand.evidenceRef &&
    assertion.quantity.amount === position.onHand.quantity.amount
  );
};

const openingSourceBlockers = (
  input: InventoryOpeningEvaluationInput,
  { position, source }: InventoryOpeningPositionFact,
): InventoryOpeningReadinessBlocker[] => {
  const selectedExternal = input.selectedConfiguration.selection.backend === 'external_business_system';
  if (
    (selectedExternal && !Schema.is(ExternalOpeningStockSourceSchema)(source)) ||
    (!selectedExternal && !Schema.is(OntosWmsOpeningStockSourceSchema)(source))
  ) {
    return [{ _tag: 'OPENING_SOURCE_KIND_MISMATCH', positionRef: position.ref }];
  }
  if (Schema.is(ExternalOpeningStockSourceSchema)(source)) {
    const { evaluation, itemCorrelation, locationCorrelation } = source;
    if (!Schema.is(DeterminateInventorySourceAssertionEvaluationSchema)(evaluation)) {
      return [
        {
          _tag: 'EXTERNAL_SOURCE_NOT_CURRENT',
          positionRef: position.ref,
          sourceState: evaluation._tag,
        },
      ];
    }
    const blockers: InventoryOpeningReadinessBlocker[] = externalAssertionScopeMatches(input, position, evaluation)
      ? []
      : [{ _tag: 'EXTERNAL_SOURCE_SCOPE_MISMATCH', positionRef: position.ref }];
    const { assertion } = evaluation;
    if (
      !correlationMatchesAssertion(itemCorrelation, assertion.itemCorrelationRef, assertion.itemExternalKey, {
        _tag: 'STOCK_ITEM',
        ref: assertion.stockItemRef,
      }) ||
      !correlationMatchesAssertion(
        locationCorrelation,
        assertion.locationCorrelationRef,
        assertion.locationExternalKey,
        { _tag: 'STOCK_LOCATION', ref: assertion.stockLocationRef },
      )
    ) {
      blockers.push({ _tag: 'EXTERNAL_CORRELATION_MISMATCH', positionRef: position.ref });
    }
    return blockers;
  }
  return Schema.is(CurrentOnHandEvidenceSchema)(position.onHand) &&
    source.ownerEvidenceRef !== position.onHand.evidenceRef
    ? [{ _tag: 'EXTERNAL_SOURCE_SCOPE_MISMATCH', positionRef: position.ref }]
    : [];
};

const positionBlockers = (
  input: InventoryOpeningEvaluationInput,
  fact: InventoryOpeningPositionFact,
): {
  readonly blockers: InventoryOpeningReadinessBlocker[];
  readonly stock?: InventoryOpeningPacket['stock'][number];
} => {
  const itemAndBinding = itemAndBindingResult(input, fact.position);
  const blockers = [
    ...positionScopeBlockers(input, fact.position),
    ...itemAndBinding.blockers,
    ...openingSourceBlockers(input, fact),
  ];
  return blockers.length === 0 && itemAndBinding.item !== undefined && itemAndBinding.binding !== undefined
    ? {
        blockers,
        stock: {
          binding: itemAndBinding.binding,
          item: itemAndBinding.item,
          position: fact.position,
          source: fact.source,
        },
      }
    : { blockers };
};

const obligationCustomerConfigurationId = (obligation: typeof InventoryObligationSchema.Type) =>
  obligation.authority.customerConfigurationId;

const effectCustomerConfigurationId = (record: typeof InventoryEffectLedgerRecordSchema.Type) =>
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

const isUnresolvedReservationEffect = (record: typeof InventoryEffectLedgerRecordSchema.Type) =>
  (Schema.is(ReservationCreateInventoryEffectLedgerIntentSchema)(record.intent) ||
    Schema.is(ReservationReleaseInventoryEffectLedgerIntentSchema)(record.intent) ||
    Schema.is(CommitmentProtectionInventoryEffectLedgerIntentSchema)(record.intent)) &&
  (record.currentState === 'REQUESTED' || record.currentState === 'INDETERMINATE');

/**
 * Builds no new business fact: it only verifies and packages exact owner facts already persisted
 * by Inventory. A NOT_READY result retains those facts verbatim so unknown or indeterminate
 * evidence can never be collapsed into numeric zero or guessed Availability.
 */
export const evaluateInventoryOpeningPacket = (
  input: InventoryOpeningEvaluationInput,
): InventoryOpeningEvaluationResult => {
  const blockers: InventoryOpeningReadinessBlocker[] = [];
  const stock: InventoryOpeningPacket['stock'][number][] = [];
  for (const fact of input.stockPositions) {
    const result = positionBlockers(input, fact);
    blockers.push(...result.blockers);
    if (result.stock !== undefined) {
      stock.push(result.stock);
    }
  }

  for (const obligation of input.obligations) {
    if (
      String(obligation.ref.tenantId) !== String(input.selectedConfiguration.tenantId) ||
      obligationCustomerConfigurationId(obligation) !== input.selectedConfiguration.customerConfigurationId
    ) {
      blockers.push({ _tag: 'OBLIGATION_SCOPE_MISMATCH', obligationRef: obligation.ref });
      continue;
    }
    if (
      Schema.is(ProvisionalInventoryReservationSchema)(obligation) &&
      (obligation.authority.configurationId !== input.selectedConfiguration.configurationId ||
        obligation.authority.selection.backendId !== input.selectedConfiguration.selection.backendId ||
        obligation.authority.selection.backend !== input.selectedConfiguration.selection.backend)
    ) {
      blockers.push({ _tag: 'PRE_CUTOVER_PROVISIONAL_RESERVATION', reservationRef: obligation.ref });
    }
  }

  for (const record of input.effectLedger) {
    if (
      record.tenantId === input.selectedConfiguration.tenantId &&
      effectCustomerConfigurationId(record) === input.selectedConfiguration.customerConfigurationId &&
      isUnresolvedReservationEffect(record)
    ) {
      blockers.push({
        _tag: 'UNRESOLVED_RESERVATION_EFFECT',
        effectId: record.effectId,
        state: record.currentState,
      });
    }
  }

  for (const hold of input.legacyUncommittedHolds) {
    if (
      hold.tenantId === input.selectedConfiguration.tenantId &&
      hold.customerConfigurationId === input.selectedConfiguration.customerConfigurationId &&
      !Schema.is(ResolvedLegacyUncommittedHoldSchema)(hold.state)
    ) {
      blockers.push({
        _tag: 'LEGACY_UNCOMMITTED_HOLD',
        holdReference: hold.holdReference,
        state: hold.state._tag,
      });
    }
  }

  const [firstBlocker, ...remainingBlockers] = blockers;
  if (firstBlocker !== undefined) {
    return {
      _tag: 'NOT_READY',
      blockers: [firstBlocker, ...remainingBlockers],
      evaluatedFacts: input,
    };
  }
  return {
    _tag: 'READY',
    packet: {
      assembledAt: input.evaluatedAt,
      obligations: input.obligations,
      selectedConfiguration: input.selectedConfiguration,
      stock,
    },
  };
};
