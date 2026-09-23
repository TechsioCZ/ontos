import { Schema } from 'effect';

import { SizeEquivalenceAssertionSchema } from '../domain/attribute-vocabulary.ts';
import { ProductReasonSchema } from '../domain/product.ts';

export const AssertSizeEquivalencePayloadSchema = Schema.Struct({
  assertion: SizeEquivalenceAssertionSchema,
  reason: ProductReasonSchema,
});
export type AssertSizeEquivalencePayload = typeof AssertSizeEquivalencePayloadSchema.Type;

const checkedAssertionId = Schema.String.check(Schema.isUUID());
const AssertionIdSchema = checkedAssertionId.pipe(
  Schema.brand('CatalogSizeEquivalenceAssertionId'),
  Schema.decodeTo(checkedAssertionId),
);

export const AssertSizeEquivalenceResultSchema = Schema.Struct({ assertionId: AssertionIdSchema });
