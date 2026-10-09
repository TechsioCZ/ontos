import { Effect, Schema } from 'effect';

import { ProductEvidenceReferenceSchema, ProductReasonSchema } from './product.ts';
import { ProductReferenceSchema, VariantReferenceSchema } from './product-form-separation.ts';

export const CosmeticProductCorrectionSchema = Schema.Struct({
  affectsOpenSelection: Schema.Boolean,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('COSMETIC_CORRECTION'),
  productRef: ProductReferenceSchema,
  reason: ProductReasonSchema,
  variantRef: Schema.optionalKey(VariantReferenceSchema),
});
export type CosmeticProductCorrection = typeof CosmeticProductCorrectionSchema.Type;

export const NewProductRealizationSchema = Schema.Struct({
  affectsOpenSelection: Schema.Literal(true),
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('NEW_REALIZATION'),
  newVariantRef: VariantReferenceSchema,
  productRef: ProductReferenceSchema,
  reason: ProductReasonSchema,
});
export type NewProductRealization = typeof NewProductRealizationSchema.Type;

export const NewProductChangeSchema = Schema.Struct({
  affectsOpenSelection: Schema.Literal(true),
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('NEW_PRODUCT'),
  newProductRef: ProductReferenceSchema,
  reason: ProductReasonSchema,
  /**
   * A different common business identity always replaces a named previous Product. A genuinely
   * unrelated Product is created through #414, never classified as a change, so the original
   * reference can never start denoting another thing without an explicit distinction.
   */
  previousProductRef: ProductReferenceSchema,
});
export type NewProductChange = typeof NewProductChangeSchema.Type;

export const SuccessorProductRealizationSchema = Schema.Struct({
  affectsOpenSelection: Schema.Literal(true),
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('SUCCESSOR_REALIZATION'),
  newVariantRef: VariantReferenceSchema,
  previousVariantRef: VariantReferenceSchema,
  productRef: ProductReferenceSchema,
  reason: ProductReasonSchema,
});
export type SuccessorProductRealization = typeof SuccessorProductRealizationSchema.Type;

export const VariantCreationClassificationSchema = Schema.Union([
  NewProductRealizationSchema,
  SuccessorProductRealizationSchema,
]);
export type VariantCreationClassification = typeof VariantCreationClassificationSchema.Type;

export const NewProductCreationClassificationSchema = Schema.Struct({
  affectsOpenSelection: Schema.Literal(true),
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('NEW_PRODUCT'),
  previousProductRef: ProductReferenceSchema,
  reason: ProductReasonSchema,
});
export type NewProductCreationClassification = typeof NewProductCreationClassificationSchema.Type;

export const IndependentProductCreationSchema = Schema.Struct({ kind: Schema.Literal('INDEPENDENT_PRODUCT') });
export type IndependentProductCreation = typeof IndependentProductCreationSchema.Type;

export const ProductCreationClassificationSchema = Schema.Union([
  IndependentProductCreationSchema,
  NewProductCreationClassificationSchema,
]);
export type ProductCreationClassification = typeof ProductCreationClassificationSchema.Type;

export const CompletedProductCreationClassificationSchema = Schema.Union([
  IndependentProductCreationSchema,
  NewProductChangeSchema,
]);
export type CompletedProductCreationClassification = typeof CompletedProductCreationClassificationSchema.Type;

/** Classification is an assertion about real-world meaning, not a textual diff. */
export const ProductChangeClassificationSchema = Schema.Union([
  CosmeticProductCorrectionSchema,
  NewProductRealizationSchema,
  NewProductChangeSchema,
  SuccessorProductRealizationSchema,
]);
export type ProductChangeClassification = typeof ProductChangeClassificationSchema.Type;

export class ProductChangeClassificationConflict extends Schema.TaggedError<ProductChangeClassificationConflict>()(
  'ProductChangeClassificationConflict',
  {
    code: Schema.Literal('product_change_classification_conflict'),
    reason: Schema.String,
  },
) {}

/**
 * Preserve Product identity for the same good or service. A cosmetic correction
 * preserves Variant identity; a material atomic realization must use a new one.
 * The evidence reference locates support for the assertion, not proof inferred
 * from a field-level difference.
 */
export const classifyProductChange = (
  change: ProductChangeClassification,
): Effect.Effect<ProductChangeClassification, ProductChangeClassificationConflict> => {
  if (change.kind === 'NEW_PRODUCT') {
    if (change.previousProductRef.tenantId !== change.newProductRef.tenantId) {
      return Effect.fail(
        new ProductChangeClassificationConflict({
          code: 'product_change_classification_conflict',
          reason: 'Product successor references must belong to the same Tenant',
        }),
      );
    }
    if (change.previousProductRef.resourceId === change.newProductRef.resourceId) {
      return Effect.fail(
        new ProductChangeClassificationConflict({
          code: 'product_change_classification_conflict',
          reason: 'A different Product must have a new Product identity',
        }),
      );
    }
    return Effect.succeed(change);
  }
  const productTenantId = change.productRef.tenantId;
  let variantRefs: readonly { tenantId: string }[];
  if (change.kind === 'COSMETIC_CORRECTION') {
    variantRefs = change.variantRef === undefined ? [] : [change.variantRef];
  } else if (change.kind === 'NEW_REALIZATION') {
    variantRefs = [change.newVariantRef];
  } else {
    variantRefs = [change.previousVariantRef, change.newVariantRef];
  }

  if (variantRefs.some((reference) => reference.tenantId !== productTenantId)) {
    return Effect.fail(
      new ProductChangeClassificationConflict({
        code: 'product_change_classification_conflict',
        reason: 'Product and Variant references must belong to the same Tenant',
      }),
    );
  }
  if (
    change.kind === 'SUCCESSOR_REALIZATION' &&
    change.previousVariantRef.resourceId === change.newVariantRef.resourceId
  ) {
    return Effect.fail(
      new ProductChangeClassificationConflict({
        code: 'product_change_classification_conflict',
        reason: 'A material successor must have a new Variant identity',
      }),
    );
  }
  return Effect.succeed(change);
};

const classificationConflict = (reason: string) =>
  new ProductChangeClassificationConflict({ code: 'product_change_classification_conflict', reason });

const sameReference = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
): boolean => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameEvidenceRefs = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((reference, index) => reference === right[index]);

/** Complete the caller's predecessor decision after the server allocates the new Product identity. */
export const completeProductCreationClassification = (
  classification: ProductCreationClassification,
  newProductRef: typeof ProductReferenceSchema.Type,
): Effect.Effect<CompletedProductCreationClassification, ProductChangeClassificationConflict> => {
  if (classification.kind === 'INDEPENDENT_PRODUCT') {
    return Effect.succeed(classification);
  }
  const completed: NewProductChange = { ...classification, newProductRef };
  return classifyProductChange(completed).pipe(Effect.as(completed));
};

/** Bind a material Variant decision to the exact identity created by the owning Action. */
export const requireVariantCreationClassification = (input: {
  readonly classification: VariantCreationClassification;
  readonly evidenceRefs: readonly string[];
  readonly productRef: typeof ProductReferenceSchema.Type;
  readonly reason: string;
  readonly variantRef: typeof VariantReferenceSchema.Type;
}): Effect.Effect<VariantCreationClassification, ProductChangeClassificationConflict> =>
  classifyProductChange(input.classification).pipe(
    Effect.flatMap(() => {
      const { classification } = input;
      if (
        !sameReference(classification.productRef, input.productRef) ||
        !sameReference(classification.newVariantRef, input.variantRef)
      ) {
        return Effect.fail(classificationConflict('Variant creation classification must identify the created form'));
      }
      if (
        classification.reason !== input.reason ||
        !sameEvidenceRefs(classification.evidenceRefs, input.evidenceRefs)
      ) {
        return Effect.fail(
          classificationConflict('Variant creation classification must retain the Action reason and evidence'),
        );
      }
      return Effect.succeed(classification);
    }),
  );

/**
 * Import and Local Override may correct an existing Product or Variant fact, but a classification
 * describing a new real-world Product or realization must be routed to its owning creation Action.
 */
export const requireExistingCatalogFactChangeClassification = (input: {
  readonly classification: ProductChangeClassification | undefined;
  readonly evidenceRef: string;
  readonly reason?: string;
  readonly target: {
    readonly resourceId: string;
    readonly targetKind: 'PRODUCT' | 'VARIANT';
    readonly tenantId: string;
  };
}): Effect.Effect<CosmeticProductCorrection, ProductChangeClassificationConflict> => {
  if (input.classification === undefined) {
    return Effect.fail(
      classificationConflict('A changed Product or Variant fact requires an explicit evidenced classification'),
    );
  }
  return classifyProductChange(input.classification).pipe(
    Effect.flatMap((classification) => {
      if (classification.kind !== 'COSMETIC_CORRECTION') {
        return Effect.fail(
          classificationConflict('A new Product or realization must use the owning Product or Variant creation Action'),
        );
      }
      if (!classification.evidenceRefs.includes(input.evidenceRef)) {
        return Effect.fail(
          classificationConflict('Change classification must retain the operation evidence reference'),
        );
      }
      if (input.reason !== undefined && classification.reason !== input.reason) {
        return Effect.fail(classificationConflict('Change classification must retain the operation reason'));
      }
      const target = { resourceId: input.target.resourceId, tenantId: input.target.tenantId };
      if (input.target.targetKind === 'PRODUCT') {
        if (classification.variantRef !== undefined || !sameReference(classification.productRef, target)) {
          return Effect.fail(classificationConflict('Product change classification must identify the exact Product'));
        }
      } else if (classification.variantRef === undefined || !sameReference(classification.variantRef, target)) {
        return Effect.fail(classificationConflict('Variant change classification must identify the exact Variant'));
      }
      return Effect.succeed(classification);
    }),
  );
};
