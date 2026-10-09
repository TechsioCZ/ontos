import { Schema } from 'effect';

import {
  ProductUnitRefSchema,
  ProductUnitRuleRevisionSchema,
  ProductUnitTargetDivisibilitySchema,
} from '../resources/product-unit.ts';

export const ProductUnitReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);
export const ProductUnitEvidenceRefsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
).check(Schema.isMinLength(1));
export const ProductUnitAuditEvidenceSchema = Schema.Struct({
  evidenceRefs: ProductUnitEvidenceRefsSchema,
  reason: ProductUnitReasonSchema,
});
export const ProductUnitRuleInputSchema = Schema.Struct({
  rounding: Schema.Literals(['UP', 'DOWN', 'HALF_UP']),
  step: Schema.String.check(Schema.isPattern(/^(?!0(?:\.0+)?$)(?:0|[1-9]\d*)(?:\.\d+)?$/u)),
});
export const ProductUnitExpectedCurrentSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  unit: ProductUnitRefSchema,
});
export const ProductUnitMutationResultSchema = Schema.Struct({
  ruleRevision: ProductUnitRuleRevisionSchema,
  targetDivisibility: Schema.optionalKey(ProductUnitTargetDivisibilitySchema),
  unit: ProductUnitRefSchema,
});

export class ProductUnitActionError extends Schema.TaggedError<ProductUnitActionError>()('ProductUnitActionError', {
  code: Schema.Literals(['product_unit_invalid', 'product_unit_stale', 'product_unit_unavailable']),
  reason: Schema.String,
}) {}
export const ProductUnitActionErrorSchema = ProductUnitActionError;
