import { MediaImageUploadSchema } from '@app/core-runtime/media/image-contract';
import { Schema } from 'effect';
import { ImportImageUrlSchema } from '../domain/import-image-url.ts';
import {
  ApplyCommandPayloadSchema,
  ApplyCreateCategoryCommandSchema,
  ChangeProductImagesPayloadSchema,
  MerchandiseCommandPayloadSchema,
} from './apply-command.ts';

/**
 * Separate from human catalog management and storefront checkout. A caller must hold the dedicated import
 * capability in the selected company. It cannot edit orders, prices, an existing gallery, or existing products.
 */
export const ImportSourceCatalogPayloadSchema = Schema.Struct({
  command: Schema.Union([
    Schema.TaggedStruct('CreateProduct', {
      ...ApplyCommandPayloadSchema.fields.command.fields,
      imageSrc: Schema.optionalKey(ImportImageUrlSchema),
      images: Schema.optionalKey(Schema.Array(ImportImageUrlSchema).check(Schema.isMaxLength(20))),
    }),
    ApplyCreateCategoryCommandSchema,
    Schema.TaggedStruct('ChangeProductImages', {
      change: Schema.TaggedStruct('Upload', { image: MediaImageUploadSchema }),
      id: ChangeProductImagesPayloadSchema.fields.command.fields.id,
    }),
  ]),
  expectedRevision: MerchandiseCommandPayloadSchema.fields.expectedRevision,
});
export type ImportSourceCatalogPayload = typeof ImportSourceCatalogPayloadSchema.Type;
export { ApplyCommandResultSchema as ImportSourceCatalogResultSchema } from './apply-command.ts';
export { ImportImageUrlSchema } from '../domain/import-image-url.ts';
export { isMediaImageReference } from '../domain/product-images.ts';
