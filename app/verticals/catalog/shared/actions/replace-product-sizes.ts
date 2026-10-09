import { Schema } from 'effect';

import { SizeUsageListSchema } from '../domain/attribute-vocabulary.ts';
import { ProductReasonSchema } from '../domain/product.ts';

export const ReplaceProductSizesPayloadSchema = Schema.Struct({
  evidenceRefs: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed())),
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 })),
  list: SizeUsageListSchema,
  reason: ProductReasonSchema,
});
export type ReplaceProductSizesPayload = typeof ReplaceProductSizesPayloadSchema.Type;

export const ReplaceProductSizesResultSchema = Schema.Struct({ revision: Schema.Number.check(Schema.isInt()) });
