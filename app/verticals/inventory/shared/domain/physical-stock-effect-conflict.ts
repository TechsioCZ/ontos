import { Schema } from 'effect';

const PhysicalStockEffectIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PhysicalStockEffectId'));

export class PhysicalStockEffectConflict extends Schema.TaggedError<PhysicalStockEffectConflict>()(
  'PhysicalStockEffectConflict',
  {
    code: Schema.Literal('physical_stock_effect_conflict'),
    effectId: PhysicalStockEffectIdSchema,
    reason: Schema.Literal('EFFECT_ID_CONFLICT'),
  },
) {}
