import type { Effect as EffectType, Option } from 'effect';
import { Effect, Schema } from 'effect';

import type { ExternalStockCorrelationPersistenceUnavailable } from './external-stock-correlation-persistence-unavailable.ts';
import type { ExternalStockCorrelationRejected } from './external-stock-correlation-rejected.ts';
import {
  InventoryBackendConfigurationSchema,
  InventoryBackendSelectionSchema,
} from './inventory-backend-configuration.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
export const ExternalStockCorrelationInstantSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const InventoryBackendOriginSchema = Schema.Struct({
  backendId: InventoryBackendSelectionSchema.fields.backendId,
  backendKind: InventoryBackendSelectionSchema.fields.backend,
});
export type InventoryBackendOrigin = typeof InventoryBackendOriginSchema.Type;

export const ExternalStockIdentifierKindSchema = Schema.Literals(['ITEM', 'LOCATION']);

/**
 * Literal external identifiers are meaningful only inside this complete qualification. The
 * selected backend is deliberately absent: cutover never re-qualifies evidence from its issuer.
 */
export const ExternalStockKeySchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  externalScope: boundedText,
  externalValue: boundedText,
  identifierKind: ExternalStockIdentifierKindSchema,
  issuer: InventoryBackendOriginSchema,
  namespace: boundedText,
  tenantId: ExternalStockCorrelationRefSchema.fields.tenantId,
});
export type ExternalStockKey = typeof ExternalStockKeySchema.Type;

export const ExternalStockItemTargetSchema = Schema.TaggedStruct('STOCK_ITEM', { ref: StockItemRefSchema });
export const ExternalStockLocationTargetSchema = Schema.TaggedStruct('STOCK_LOCATION', { ref: StockLocationRefSchema });
export const ExternalStockTargetSchema = Schema.Union([
  ExternalStockItemTargetSchema,
  ExternalStockLocationTargetSchema,
]);
export type ExternalStockTarget = typeof ExternalStockTargetSchema.Type;

export const ExternalStockCorrelationEffectivePeriodSchema = Schema.Struct({
  from: ExternalStockCorrelationInstantSchema,
  to: Schema.toEncoded(Schema.OptionFromNullOr(ExternalStockCorrelationInstantSchema)),
}).check(
  Schema.makeFilter(({ from, to }) =>
    to === null || from < to ? undefined : 'Effective Period must be non-empty and half-open',
  ),
);

export const ExternalStockCorrelationSchema = Schema.Struct({
  confirmedAt: ExternalStockCorrelationInstantSchema,
  correlationRef: ExternalStockCorrelationRefSchema,
  effectivePeriod: ExternalStockCorrelationEffectivePeriodSchema,
  externalKey: ExternalStockKeySchema,
  lifecycle: Schema.Literals(['CURRENT', 'ENDED']),
  ownerEvidenceRef: boundedText,
  revision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
  target: ExternalStockTargetSchema,
}).check(
  Schema.makeFilter((correlation) => {
    if (
      correlation.correlationRef.tenantId !== correlation.externalKey.tenantId ||
      correlation.correlationRef.tenantId !== correlation.target.ref.tenantId
    ) {
      return 'Correlation key, identity, and target must share one Tenant';
    }
    const itemTarget = Schema.is(ExternalStockItemTargetSchema)(correlation.target);
    const locationTarget = Schema.is(ExternalStockLocationTargetSchema)(correlation.target);
    if (
      (correlation.externalKey.identifierKind === 'ITEM' && !itemTarget) ||
      (correlation.externalKey.identifierKind === 'LOCATION' && !locationTarget)
    ) {
      return 'External identifier kind must match the Inventory target kind';
    }
    return (correlation.lifecycle === 'CURRENT' && correlation.effectivePeriod.to === null) ||
      (correlation.lifecycle === 'ENDED' && correlation.effectivePeriod.to !== null)
      ? undefined
      : 'Correlation lifecycle must match its Effective Period';
  }),
);
export type ExternalStockCorrelation = typeof ExternalStockCorrelationSchema.Type;

export interface ExternalStockCorrelationReader {
  readonly findEffective: (
    externalKey: ExternalStockKey,
    asOf: ExternalStockCorrelation['effectivePeriod']['from'],
  ) => EffectType.Effect<readonly ExternalStockCorrelation[], ExternalStockCorrelationPersistenceError>;
}

export const ResolvedExternalStockCorrelationSchema = Schema.TaggedStruct('RESOLVED', {
  correlationRef: ExternalStockCorrelationRefSchema,
  effectivePeriod: ExternalStockCorrelationEffectivePeriodSchema,
  externalKey: ExternalStockKeySchema,
  selectedBackendOriginMatch: Schema.Literals(['MATCHES_SELECTED_BACKEND', 'OUTSIDE_SELECTED_BACKEND']),
  target: ExternalStockTargetSchema,
});
export const UnresolvedExternalStockCorrelationSchema = Schema.TaggedStruct('UNRESOLVED', {
  asOf: ExternalStockCorrelationInstantSchema,
  externalKey: ExternalStockKeySchema,
});
export const AmbiguousExternalStockCorrelationSchema = Schema.TaggedStruct('AMBIGUOUS', {
  asOf: ExternalStockCorrelationInstantSchema,
  candidateCorrelationRefs: Schema.Array(ExternalStockCorrelationRefSchema).check(Schema.isMinLength(2)),
  externalKey: ExternalStockKeySchema,
});
export const ExternalStockCorrelationResolutionSchema = Schema.Union([
  ResolvedExternalStockCorrelationSchema,
  UnresolvedExternalStockCorrelationSchema,
  AmbiguousExternalStockCorrelationSchema,
]);
export type ExternalStockCorrelationResolution = typeof ExternalStockCorrelationResolutionSchema.Type;

export const ExternalStockCorrelationResolutionInputSchema = Schema.Struct({
  asOf: ExternalStockCorrelationInstantSchema,
  externalKey: ExternalStockKeySchema,
  selectedConfiguration: InventoryBackendConfigurationSchema,
});
export type ExternalStockCorrelationResolutionInput = typeof ExternalStockCorrelationResolutionInputSchema.Type;

export type ExternalStockCorrelationPersistenceError =
  | ExternalStockCorrelationPersistenceUnavailable
  | ExternalStockCorrelationRejected;

export interface ExternalStockCorrelationPersistence extends ExternalStockCorrelationReader {
  readonly endCurrent: (input: {
    readonly current: ExternalStockCorrelation;
    readonly endedAt: ExternalStockCorrelation['effectivePeriod']['from'];
  }) => EffectType.Effect<ExternalStockCorrelation, ExternalStockCorrelationPersistenceError>;
  readonly findByRef: (
    correlationRef: ExternalStockCorrelation['correlationRef'],
  ) => EffectType.Effect<Option.Option<ExternalStockCorrelation>, ExternalStockCorrelationPersistenceError>;
  readonly insertCurrent: (
    correlation: ExternalStockCorrelation,
  ) => EffectType.Effect<ExternalStockCorrelation, ExternalStockCorrelationPersistenceError>;
  readonly replaceCurrent: (input: {
    readonly current: ExternalStockCorrelation;
    readonly endedAt: ExternalStockCorrelation['effectivePeriod']['from'];
    readonly replacement: ExternalStockCorrelation;
  }) => EffectType.Effect<ExternalStockCorrelation, ExternalStockCorrelationPersistenceError>;
  readonly saveConfirmation: (input: {
    readonly expectedRevision: number;
    readonly next: ExternalStockCorrelation;
  }) => EffectType.Effect<ExternalStockCorrelation, ExternalStockCorrelationPersistenceError>;
}

const sameBackendOrigin = (left: InventoryBackendOrigin, right: InventoryBackendOrigin): boolean =>
  left.backendKind === right.backendKind && left.backendId === right.backendId;

const selectedConfigurationAuthorizes = (input: ExternalStockCorrelationResolutionInput): boolean =>
  String(input.selectedConfiguration.tenantId) === String(input.externalKey.tenantId) &&
  input.selectedConfiguration.customerConfigurationId === input.externalKey.customerConfigurationId &&
  sameBackendOrigin(
    {
      backendId: input.selectedConfiguration.selection.backendId,
      backendKind: input.selectedConfiguration.selection.backend,
    },
    input.externalKey.issuer,
  );

/** Resolution is exact only. Missing and conflicting owner records remain explicit outcomes. */
export const makeExternalStockCorrelationResolver = (reader: ExternalStockCorrelationReader) => ({
  resolve: (
    input: ExternalStockCorrelationResolutionInput,
  ): EffectType.Effect<ExternalStockCorrelationResolution, ExternalStockCorrelationPersistenceError> =>
    reader.findEffective(input.externalKey, input.asOf).pipe(
      Effect.map((correlations) => {
        const [correlation] = correlations;
        if (correlation === undefined) {
          return { _tag: 'UNRESOLVED' as const, asOf: input.asOf, externalKey: input.externalKey };
        }
        if (correlations.length !== 1) {
          return {
            _tag: 'AMBIGUOUS' as const,
            asOf: input.asOf,
            candidateCorrelationRefs: correlations.map((candidate) => candidate.correlationRef),
            externalKey: input.externalKey,
          };
        }
        return {
          _tag: 'RESOLVED' as const,
          correlationRef: correlation.correlationRef,
          effectivePeriod: correlation.effectivePeriod,
          externalKey: input.externalKey,
          selectedBackendOriginMatch: selectedConfigurationAuthorizes(input)
            ? ('MATCHES_SELECTED_BACKEND' as const)
            : ('OUTSIDE_SELECTED_BACKEND' as const),
          target: correlation.target,
        };
      }),
    ),
});

export const EstablishExternalStockCorrelationInputSchema = Schema.Struct({
  effectiveFrom: ExternalStockCorrelationInstantSchema,
  externalKey: ExternalStockKeySchema,
  ownerEvidenceRef: boundedText,
  target: ExternalStockTargetSchema,
});
export type EstablishExternalStockCorrelationInput = typeof EstablishExternalStockCorrelationInputSchema.Type;

export const CorrectExternalStockCorrelationInputSchema = Schema.Struct({
  correctedAt: ExternalStockCorrelationInstantSchema,
  externalKey: ExternalStockKeySchema,
  ownerEvidenceRef: boundedText,
  target: ExternalStockTargetSchema,
});
export type CorrectExternalStockCorrelationInput = typeof CorrectExternalStockCorrelationInputSchema.Type;

export const EndExternalStockCorrelationInputSchema = Schema.Struct({
  endedAt: ExternalStockCorrelationInstantSchema,
  externalKey: ExternalStockKeySchema,
});
export type EndExternalStockCorrelationInput = typeof EndExternalStockCorrelationInputSchema.Type;

export const ConfirmExternalStockCorrelationInputSchema = Schema.Struct({
  confirmedAt: ExternalStockCorrelationInstantSchema,
  correlationRef: ExternalStockCorrelationRefSchema,
  ownerEvidenceRef: boundedText,
});
export type ConfirmExternalStockCorrelationInput = typeof ConfirmExternalStockCorrelationInputSchema.Type;
