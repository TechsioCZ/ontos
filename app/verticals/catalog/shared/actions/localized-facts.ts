import { Schema } from 'effect';

import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { CatalogLocaleSchema } from '../domain/product-descriptive-facts.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const FactualNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(240));
const FactualDescriptionSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const FactsSchema = Schema.Struct({
  description: Schema.optionalKey(FactualDescriptionSchema),
  name: Schema.optionalKey(FactualNameSchema),
}).check(
  Schema.makeFilter(({ description, name }) =>
    name === undefined && description === undefined ? 'At least one factual text value is required' : undefined,
  ),
);
const ChangeFields = {
  evidenceRefs: Schema.Array(ProductEvidenceReferenceSchema),
  expectedRevision: RevisionSchema,
  locale: CatalogLocaleSchema,
  reason: ProductReasonSchema,
};

export const SetProductLocalizedFactsPayloadSchema = Schema.Struct({
  ...ChangeFields,
  facts: FactsSchema,
  productRef: ProductRefSchema,
});
export type SetProductLocalizedFactsPayload = typeof SetProductLocalizedFactsPayloadSchema.Type;
export const RemoveProductLocalizedFactsPayloadSchema = Schema.Struct({
  ...ChangeFields,
  productRef: ProductRefSchema,
});
export type RemoveProductLocalizedFactsPayload = typeof RemoveProductLocalizedFactsPayloadSchema.Type;
export const SetVariantLocalizedFactsPayloadSchema = Schema.Struct({
  ...ChangeFields,
  facts: FactsSchema,
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
});
export type SetVariantLocalizedFactsPayload = typeof SetVariantLocalizedFactsPayloadSchema.Type;
export const RemoveVariantLocalizedFactsPayloadSchema = Schema.Struct({
  ...ChangeFields,
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
});
export type RemoveVariantLocalizedFactsPayload = typeof RemoveVariantLocalizedFactsPayloadSchema.Type;

export const LocalizedFactsChangeResultSchema = Schema.Struct({ changed: Schema.Boolean, revision: RevisionSchema });
