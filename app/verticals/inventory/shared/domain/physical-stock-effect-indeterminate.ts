import { Schema } from 'effect';

const PhysicalStockEffectIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PhysicalStockEffectId'));

export const PhysicalStockEffectIndeterminateReasonSchema = Schema.Literals([
  'BACKEND_OUTCOME_UNKNOWN',
  'EVIDENCE_UNVERIFIABLE',
]);

export class PhysicalStockEffectIndeterminate extends Schema.TaggedError<PhysicalStockEffectIndeterminate>()(
  'PhysicalStockEffectIndeterminate',
  {
    code: Schema.Literal('physical_stock_effect_indeterminate'),
    effectId: PhysicalStockEffectIdSchema,
    reason: PhysicalStockEffectIndeterminateReasonSchema,
    retryable: Schema.Literal(true),
  },
) {}
