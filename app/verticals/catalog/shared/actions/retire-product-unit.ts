import { Schema } from 'effect';

import {
  ProductUnitEvidenceRefsSchema,
  ProductUnitExpectedCurrentSchema,
  ProductUnitMutationResultSchema,
  ProductUnitReasonSchema,
} from './product-unit-contract.ts';

export const RetireProductUnitPayloadSchema = Schema.Struct({
  evidenceRefs: ProductUnitEvidenceRefsSchema,
  expectedCurrent: ProductUnitExpectedCurrentSchema,
  reason: ProductUnitReasonSchema,
});
export type RetireProductUnitPayload = typeof RetireProductUnitPayloadSchema.Type;
export const RetireProductUnitResultSchema = ProductUnitMutationResultSchema;
export type RetireProductUnitResult = typeof RetireProductUnitResultSchema.Type;
