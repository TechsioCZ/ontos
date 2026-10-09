import { Effect, Match, Schema } from 'effect';

import { StockLocationRefSchema } from '../resources/stock-location.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const reason = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(1000));
const timestamp = Schema.toEncoded(Schema.DateTimeUtcFromString);
const PhysicalSiteEvidenceKeySchema = boundedText.pipe(
  Schema.brand('InventoryPhysicalSiteEvidenceKey'),
  Schema.decodeTo(boundedText),
);
const ExternalStockLocationIssuerIdSchema = boundedText.pipe(
  Schema.brand('ExternalStockLocationIssuerId'),
  Schema.decodeTo(boundedText),
);
const ExternalStockLocationCorrelationIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('ExternalStockLocationCorrelationId'),
  Schema.decodeTo(Schema.String.check(Schema.isUUID(), Schema.isTrimmed())),
);
const physicalSiteKeys = Schema.Array(PhysicalSiteEvidenceKeySchema).check(
  Schema.isMaxLength(100),
  Schema.makeFilter((keys) => new Set(keys).size === keys.length || 'Physical-site evidence keys must be distinct'),
);

export const StockLocationAddressEvidenceSchema = Schema.Struct({
  countryCode: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)),
  lines: Schema.Array(boundedText).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  locality: Schema.optionalKey(boundedText),
  postalCode: Schema.optionalKey(boundedText),
});
export type StockLocationAddressEvidence = typeof StockLocationAddressEvidenceSchema.Type;

const PhysicalSiteScopeSchema = Schema.TaggedStruct('PHYSICAL_SITE', {
  physicalSiteKeys,
}).check(
  Schema.makeFilter(
    ({ physicalSiteKeys: keys }) =>
      keys.length === 1 || 'A physical-site Stock Location must declare exactly one physical site',
  ),
);

export const LogicalAggregateScopeSchema = Schema.TaggedStruct('LOGICAL_AGGREGATE', {
  physicalSiteKeys,
});

/** Site keys are descriptive owner evidence. They never become Stock Location identity. */
export const StockLocationOperationalScopeSchema = Schema.Union([PhysicalSiteScopeSchema, LogicalAggregateScopeSchema]);

export const ActiveLifecycleSchema = Schema.TaggedStruct('ACTIVE', {});
const RetiredLifecycleSchema = Schema.TaggedStruct('RETIRED', {
  reason,
  transitionedAt: timestamp,
});
export const ReplacedLifecycleSchema = Schema.TaggedStruct('REPLACED', {
  reason,
  successorRef: StockLocationRefSchema,
  transitionedAt: timestamp,
});
export const MergedLifecycleSchema = Schema.TaggedStruct('MERGED', {
  reason,
  successorRef: StockLocationRefSchema,
  transitionedAt: timestamp,
});

export const StockLocationLifecycleSchema = Schema.Union([
  ActiveLifecycleSchema,
  RetiredLifecycleSchema,
  ReplacedLifecycleSchema,
  MergedLifecycleSchema,
]);
export type StockLocationLifecycle = typeof StockLocationLifecycleSchema.Type;

export const StockLocationSchema = Schema.Struct({
  addressEvidence: Schema.optionalKey(StockLocationAddressEvidenceSchema),
  displayName: boundedText,
  lifecycle: StockLocationLifecycleSchema,
  operationalScope: StockLocationOperationalScopeSchema,
  ref: StockLocationRefSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}).check(
  Schema.makeFilter(({ lifecycle, ref }) => {
    if (!('successorRef' in lifecycle)) {
      return true;
    }
    if (lifecycle.successorRef.tenantId !== ref.tenantId) {
      return 'A Stock Location successor must belong to the same Tenant';
    }
    if (lifecycle.successorRef.resourceId === ref.resourceId) {
      return 'A Stock Location cannot replace or merge into itself';
    }
    return true;
  }),
);
export type StockLocation = typeof StockLocationSchema.Type;

export const StockLocationTransitionSchema = Schema.Union([
  Schema.TaggedStruct('RETIRE', { reason, transitionedAt: timestamp }),
  Schema.TaggedStruct('REPLACE', {
    reason,
    successorRef: StockLocationRefSchema,
    transitionedAt: timestamp,
  }),
  Schema.TaggedStruct('MERGE', {
    reason,
    successorRef: StockLocationRefSchema,
    transitionedAt: timestamp,
  }),
]);
export type StockLocationTransition = typeof StockLocationTransitionSchema.Type;

export class StockLocationTransitionRejected extends Schema.TaggedError<StockLocationTransitionRejected>()(
  'StockLocationTransitionRejected',
  {
    locationRef: StockLocationRefSchema,
    reason: Schema.Literals(['CROSS_TENANT_SUCCESSOR', 'INVALID_TRANSITION', 'SELF_SUCCESSOR', 'TERMINAL_LIFECYCLE']),
  },
) {}

/**
 * End one Current location without rotating or erasing its Resource identity. A replacement or
 * merge records a forward relation; historical stock facts continue to carry the original ref.
 */
export const transitionStockLocation = (
  current: StockLocation,
  transition: StockLocationTransition,
): Effect.Effect<StockLocation, StockLocationTransitionRejected> => {
  if (!Schema.is(ActiveLifecycleSchema)(current.lifecycle)) {
    return Effect.fail(new StockLocationTransitionRejected({ locationRef: current.ref, reason: 'TERMINAL_LIFECYCLE' }));
  }
  if ('successorRef' in transition) {
    if (transition.successorRef.tenantId !== current.ref.tenantId) {
      return Effect.fail(
        new StockLocationTransitionRejected({ locationRef: current.ref, reason: 'CROSS_TENANT_SUCCESSOR' }),
      );
    }
    if (transition.successorRef.resourceId === current.ref.resourceId) {
      return Effect.fail(new StockLocationTransitionRejected({ locationRef: current.ref, reason: 'SELF_SUCCESSOR' }));
    }
  }

  const lifecycle: StockLocationLifecycle = Match.value(transition).pipe(
    Match.tag('RETIRE', ({ reason: transitionReason, transitionedAt }) => ({
      _tag: 'RETIRED' as const,
      reason: transitionReason,
      transitionedAt,
    })),
    Match.tag('REPLACE', ({ reason: transitionReason, successorRef, transitionedAt }) => ({
      _tag: 'REPLACED' as const,
      reason: transitionReason,
      successorRef,
      transitionedAt,
    })),
    Match.tag('MERGE', ({ reason: transitionReason, successorRef, transitionedAt }) => ({
      _tag: 'MERGED' as const,
      reason: transitionReason,
      successorRef,
      transitionedAt,
    })),
    Match.exhaustive,
  );

  return Schema.decodeEffect(StockLocationSchema)({
    ...current,
    lifecycle,
    revision: current.revision + 1,
  }).pipe(
    Effect.mapError((cause) => {
      const failure = new StockLocationTransitionRejected({
        locationRef: current.ref,
        reason: 'INVALID_TRANSITION',
      });
      Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
      return failure;
    }),
  );
};

export const ExternalStockLocationKeySchema = Schema.Struct({
  externalValue: boundedText,
  identifierKind: boundedText,
  issuerId: ExternalStockLocationIssuerIdSchema,
  issuerKind: Schema.Literals(['EXTERNAL_BUSINESS_SYSTEM', 'ONTOS_WMS']),
  namespace: boundedText,
  tenantId: StockLocationRefSchema.fields.tenantId,
});
export type ExternalStockLocationKey = typeof ExternalStockLocationKeySchema.Type;

export const StockLocationCorrelationSchema = Schema.Struct({
  correlationId: ExternalStockLocationCorrelationIdSchema,
  locationRef: StockLocationRefSchema,
  source: ExternalStockLocationKeySchema,
}).check(
  Schema.makeFilter(
    ({ locationRef, source }) =>
      locationRef.tenantId === source.tenantId || 'A correlation target must belong to the source Tenant',
  ),
);
export type StockLocationCorrelation = typeof StockLocationCorrelationSchema.Type;

export const sameExternalStockLocationKey = (
  left: ExternalStockLocationKey,
  right: ExternalStockLocationKey,
): boolean =>
  left.tenantId === right.tenantId &&
  left.issuerKind === right.issuerKind &&
  left.issuerId === right.issuerId &&
  left.namespace === right.namespace &&
  left.identifierKind === right.identifierKind &&
  left.externalValue === right.externalValue;
