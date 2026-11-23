import { MediaImageUploadSchema } from '@app/core-runtime/media/image-contract';
import { ImportImageUrlSchema } from '@app/merchandise/contracts/import-source-catalog';
import {
  ApplyCommandPayloadSchema,
  ApplyCreateCategoryCommandSchema,
  ChangeProductImagesPayloadSchema,
} from '@app/merchandise/contracts/apply-command';
import { Schema } from 'effect';
export { DemoCatalogRevisionResponseSchema as SymmyDemoCatalogRevisionResponseSchema } from '@app/merchandise/apis/demo-catalog-revision';

const text = (max: number) => Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(max));
const category = ApplyCreateCategoryCommandSchema.fields;
const product = ApplyCommandPayloadSchema.fields.command.fields;
const revision = ApplyCommandPayloadSchema.fields.expectedRevision;

/** URL references are not fetched by Shell. Bytes use the bounded, signature-verified CoreMedia upload path. */
export const SymmyDemoImageUrlSchema = ImportImageUrlSchema;

export const SymmyDemoCategoriesBatchRequestSchema = Schema.Struct({
  categories: Schema.NonEmptyArray(
    Schema.Struct({
      code: text(100),
      name: category.name,
      parentCode: Schema.optionalKey(text(100)),
      published: category.published,
      slug: category.slug,
    }),
  ).check(Schema.isMaxLength(16)),
  expectedRevision: revision,
});
export type SymmyDemoCategoriesBatchRequest = typeof SymmyDemoCategoriesBatchRequestSchema.Type;

export const SymmyDemoProductsBatchRequestSchema = Schema.Struct({
  expectedRevision: revision,
  products: Schema.NonEmptyArray(
    Schema.Struct({
      active: Schema.Boolean,
      category: product.category,
      categoryCode: Schema.optionalKey(text(100)),
      categoryId: Schema.optionalKey(text(300)),
      description: product.description,
      images: Schema.optionalKey(Schema.Array(SymmyDemoImageUrlSchema).check(Schema.isMaxLength(20))),
      lowStockThreshold: product.lowStockThreshold,
      name: product.name,
      priceMinor: product.priceMinor,
      published: product.published,
      sku: product.sku,
      slug: product.slug,
      stockTracked: product.stockTracked,
      taxClassificationCode: product.taxClassificationCode,
      unit: product.unit,
    }).check(
      Schema.makeFilter(({ categoryCode, categoryId }) =>
        categoryCode !== undefined && categoryId !== undefined
          ? 'Name a category code or native id, not both'
          : undefined,
      ),
    ),
  ).check(Schema.isMaxLength(16)),
});
export type SymmyDemoProductsBatchRequest = typeof SymmyDemoProductsBatchRequestSchema.Type;

export const SymmyDemoMediaUploadRequestSchema = Schema.Struct({
  expectedRevision: revision,
  image: MediaImageUploadSchema,
  productId: ChangeProductImagesPayloadSchema.fields.command.fields.id,
});
export type SymmyDemoMediaUploadRequest = typeof SymmyDemoMediaUploadRequestSchema.Type;

/** Native owner ids, never engineered Catalog references. The company is always the credential's selected company. */
export const SymmyDemoCatalogBatchResponseSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      entityId: text(300),
      image: Schema.optionalKey(text(500)),
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      outcome: Schema.Literal('APPLIED'),
      revision,
    }),
  ),
  legalEntityId: Schema.String.check(Schema.isUUID()),
  ownerModuleId: Schema.Literal('demo.merchandise'),
  revision,
  tenantId: Schema.String.check(Schema.isUUID()),
});
