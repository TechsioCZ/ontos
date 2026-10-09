import { Schema } from 'effect';

import {
  ProductUnitEvidenceRefsSchema,
  ProductUnitExpectedCurrentSchema,
  ProductUnitMutationResultSchema,
  ProductUnitReasonSchema,
  ProductUnitRuleInputSchema,
} from './product-unit-contract.ts';

export const ReviseProductUnitPayloadSchema = Schema.Struct({
  evidenceRefs: ProductUnitEvidenceRefsSchema,
  expectedCurrent: ProductUnitExpectedCurrentSchema,
  reason: ProductUnitReasonSchema,
  rule: ProductUnitRuleInputSchema,
});
export type ReviseProductUnitPayload = typeof ReviseProductUnitPayloadSchema.Type;
export const ReviseProductUnitResultSchema = ProductUnitMutationResultSchema;
export type ReviseProductUnitResult = typeof ReviseProductUnitResultSchema.Type;
