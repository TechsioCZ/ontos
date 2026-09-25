import { Schema } from 'effect';

import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { InventorySourceAssertionEvaluationSchema } from './inventory-source-assertion.ts';
import { StockPositionSchema } from './stock-position.ts';

const sourceInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const sourceReference = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

export const SourceAssertionConditionSchema = Schema.TaggedStruct('SOURCE_ASSERTION', {
  evaluation: InventorySourceAssertionEvaluationSchema,
});
export const OmittedSourceConditionSchema = Schema.TaggedStruct('OMITTED', {
  batchRef: sourceReference,
  observedAt: sourceInstant,
});
export const UnavailableSourceConditionSchema = Schema.TaggedStruct('UNAVAILABLE', {
  observedAt: sourceInstant,
  sourceReference,
});
export const OwnerUnknownSourceConditionSchema = Schema.TaggedStruct('OWNER_UNKNOWN', {
  observedAt: sourceInstant,
  ownerEvidenceRef: sourceReference,
});
export const MissingSourceConditionSchema = Schema.TaggedStruct('MISSING', {
  observedAt: sourceInstant,
  reason: Schema.Literals(['CORRELATION_NOT_FOUND', 'NO_USABLE_EVIDENCE']),
});
export const ConflictingSourceConditionSchema = Schema.TaggedStruct('CONFLICTING', {
  evidenceRefs: Schema.NonEmptyArray(sourceReference).check(
    Schema.makeFilter((refs) =>
      refs.length >= 2 && new Set(refs).size === refs.length
        ? undefined
        : 'Conflicting source evidence requires at least two distinct evidence references',
    ),
  ),
  observedAt: sourceInstant,
});

/** Source transport/assessment conditions stay separate from Stock Position quantity evidence. */
export const StockSourceConditionSchema = Schema.Union([
  SourceAssertionConditionSchema,
  OmittedSourceConditionSchema,
  UnavailableSourceConditionSchema,
  OwnerUnknownSourceConditionSchema,
  MissingSourceConditionSchema,
  ConflictingSourceConditionSchema,
]);
export type StockSourceCondition = typeof StockSourceConditionSchema.Type;

export const StockSourceCurrentnessInputSchema = Schema.Struct({
  evaluatedAt: sourceInstant,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  ownerCurrentThrough: sourceInstant,
  position: StockPositionSchema,
  sourceCondition: StockSourceConditionSchema,
});
export type StockSourceCurrentnessInput = typeof StockSourceCurrentnessInputSchema.Type;

export const StockSourceCurrentnessResultSchema = Schema.Struct({
  establishesCurrentStockGuarantee: Schema.Boolean,
  hasCurrentStockGuarantee: Schema.Boolean,
  position: StockPositionSchema,
  reconciliationRequired: Schema.Boolean,
  sourceCondition: StockSourceConditionSchema,
});
export type StockSourceCurrentnessResult = typeof StockSourceCurrentnessResultSchema.Type;

export class StockSourceCurrentnessRejected extends Schema.TaggedError<StockSourceCurrentnessRejected>()(
  'StockSourceCurrentnessRejected',
  {
    code: Schema.Literal('stock_source_currentness_rejected'),
    reason: Schema.Literals([
      'ASSERTION_POSITION_MISMATCH',
      'ASSERTION_QUANTITY_MISMATCH',
      'AUTHORITY_SCOPE_MISMATCH',
      'INVALID_INPUT',
      'INVALID_POSITION_TRANSITION',
      'POSITION_NOT_CURRENT',
    ]),
  },
) {}
