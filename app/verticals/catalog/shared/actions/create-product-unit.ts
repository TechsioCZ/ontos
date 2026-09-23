import { Schema } from 'effect';

import { ProductUnitRefSchema } from '../resources/product-unit.ts';
import {
  ProductUnitEvidenceRefsSchema,
  ProductUnitMutationResultSchema,
  ProductUnitReasonSchema,
  ProductUnitRuleInputSchema,
} from './product-unit-contract.ts';

export const CreateProductUnitPayloadSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isTrimmed()),
  evidenceRefs: ProductUnitEvidenceRefsSchema,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isTrimmed()),
  reason: ProductUnitReasonSchema,
  rule: ProductUnitRuleInputSchema,
  unitRef: ProductUnitRefSchema,
});
export type CreateProductUnitPayload = typeof CreateProductUnitPayloadSchema.Type;
export const CreateProductUnitResultSchema = ProductUnitMutationResultSchema;
export type CreateProductUnitResult = typeof CreateProductUnitResultSchema.Type;
