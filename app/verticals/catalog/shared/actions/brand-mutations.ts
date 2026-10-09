import { Schema } from 'effect';

import { BrandRefSchema } from '../resources/brand.ts';
import { ProductRefSchema } from '../resources/product.ts';

const ReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const EvidenceRefsSchema = Schema.NonEmptyArray(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
);
const BrandNameSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isTrimmed());
const ExpectedRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
const ExpectedProductBrandRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const EvidenceSchema = Schema.Struct({ evidenceRefs: EvidenceRefsSchema, reason: ReasonSchema });

export const BrandAuditEvidenceSchema = EvidenceSchema;
export const CreateBrandPayloadSchema = Schema.Struct({
  brandRef: BrandRefSchema,
  evidenceRefs: EvidenceRefsSchema,
  name: BrandNameSchema,
  reason: ReasonSchema,
});
export type CreateBrandPayload = typeof CreateBrandPayloadSchema.Type;

export const RenameBrandPayloadSchema = Schema.Struct({
  brandRef: BrandRefSchema,
  evidenceRefs: EvidenceRefsSchema,
  expectedRevision: ExpectedRevisionSchema,
  name: BrandNameSchema,
  reason: ReasonSchema,
});
export type RenameBrandPayload = typeof RenameBrandPayloadSchema.Type;

export const RetireBrandPayloadSchema = Schema.Struct({
  brandRef: BrandRefSchema,
  evidenceRefs: EvidenceRefsSchema,
  expectedRevision: ExpectedRevisionSchema,
  reason: ReasonSchema,
});
export type RetireBrandPayload = typeof RetireBrandPayloadSchema.Type;

export const ReactivateBrandPayloadSchema = RetireBrandPayloadSchema;
export type ReactivateBrandPayload = typeof ReactivateBrandPayloadSchema.Type;

export const ProductBrandAssignmentSchema = Schema.Union([
  Schema.Struct({ brandRef: BrandRefSchema, kind: Schema.Literal('brand') }),
  Schema.Struct({ kind: Schema.Literal('unknown') }),
  Schema.Struct({ kind: Schema.Literal('confirmed_unbranded') }),
]);
export const SetProductBrandPayloadSchema = Schema.Struct({
  assignment: ProductBrandAssignmentSchema,
  evidenceRefs: EvidenceRefsSchema,
  expectedRevision: ExpectedProductBrandRevisionSchema,
  productRef: ProductRefSchema,
  reason: ReasonSchema,
});
export type SetProductBrandPayload = typeof SetProductBrandPayloadSchema.Type;

export const BrandMutationResultSchema = Schema.Struct({ brandRef: BrandRefSchema, revision: ExpectedRevisionSchema });
export const ProductBrandMutationResultSchema = Schema.Struct({
  assignment: ProductBrandAssignmentSchema,
  productRef: ProductRefSchema,
  revision: ExpectedRevisionSchema,
});

export class BrandActionError extends Schema.TaggedError<BrandActionError>()('BrandActionError', {
  code: Schema.Literals(['brand_invalid', 'brand_stale', 'brand_not_found', 'brand_unavailable']),
  reason: Schema.String,
}) {}

export const BrandActionErrorSchema = BrandActionError;
