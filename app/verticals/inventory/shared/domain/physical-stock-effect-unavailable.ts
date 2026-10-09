import { Schema } from 'effect';

const PhysicalStockEffectIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PhysicalStockEffectId'));

export class PhysicalStockEffectUnavailable extends Schema.TaggedError<PhysicalStockEffectUnavailable>()(
  'PhysicalStockEffectUnavailable',
  {
    code: Schema.Literal('physical_stock_effect_unavailable'),
    effectId: Schema.optionalKey(PhysicalStockEffectIdSchema),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
