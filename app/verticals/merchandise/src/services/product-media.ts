// Product gallery images in Core Media: the side effects of a gallery change inside the merchandise Action
// transaction, and the governed delivery of one gallery image. The gallery order itself stays product state.
import {
  readLinkedMediaRendition,
  relinkMediaToResource,
  storeLinkedMediaImage,
  unlinkMediaFromResource,
} from '@app/core-runtime';
import type {
  MediaRendition,
  MediaStoreUnavailable,
  MediaUploadRejected,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { eq } from 'drizzle-orm';
import { Effect, Match, Option, Predicate } from 'effect';
import type { ProductImageChange } from '../../shared/actions/apply-command.ts';
import {
  PRODUCT_IMAGE_LINK,
  appendImage,
  mediaAssetIdOf,
  mediaImageReference,
  removeImage,
  reorderGallery,
  restoreImage,
} from '../../shared/domain/product-images.ts';
import type { Product } from '../../shared/domain/merchandise-model.ts';
import { MerchandiseLifecycleConflict } from '../../shared/errors/merchandise-lifecycle-conflict.ts';
import { MerchandisePersistenceUnavailable } from '../../shared/errors/merchandise-persistence-unavailable.ts';
import { products } from '../database/schema.ts';
import { loadProducts } from './merchandise-store.ts';
import type { StoreScope } from './merchandise-store.ts';

const conflict = (reason: string) =>
  new MerchandiseLifecycleConflict({ code: 'merchandise_lifecycle_conflict', reason });
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new MerchandisePersistenceUnavailable({
      code: 'merchandise_persistence_unavailable',
      reason: 'Merchandise persistence is temporarily unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );

const target = (productId: string) => ({ ...PRODUCT_IMAGE_LINK, resourceId: productId });

/** Core rejects only content the browser already refused; a forged or damaged upload is a plain conflict. */
const mediaFailure = (failure: MediaStoreUnavailable | MediaUploadRejected) =>
  Match.value(failure).pipe(
    Match.tag('MediaStoreUnavailable', unavailable),
    Match.tag('MediaUploadRejected', () => conflict('Obrázek nelze uložit')),
    Match.exhaustive,
  );

/**
 * The gallery after one change. Uploads are stored and linked in Core Media before the product state changes,
 * removals end the Core link, an undo links the same sealed asset again; all in the caller's transaction.
 */
export const galleryAfterChange = Effect.fn('Merchandise.galleryAfterChange')(function* galleryAfterChange(
  transaction: ScopedTransactionExecutor,
  input: {
    readonly actionInvocationId: string;
    readonly change: ProductImageChange;
    readonly principalId: string;
    readonly product: Product;
  },
) {
  const gallery = input.product.images ?? [];
  const link = target(input.product.id);
  const outcome: Option.Option<readonly string[]> = yield* Match.value(input.change).pipe(
    Match.tagsExhaustive({
      Remove: Effect.fn('Merchandise.removeGalleryImage')(function* remove({ image }) {
        const next = removeImage(gallery, image);
        if (Option.isSome(next)) {
          yield* unlinkMediaFromResource(transaction, {
            mediaAssetIds: Option.toArray(mediaAssetIdOf(image)),
            target: link,
          }).pipe(Effect.mapError(mediaFailure));
        }
        return next;
      }),
      Reorder: ({ images }) => Effect.succeed(reorderGallery(gallery, images)),
      Restore: Effect.fn('Merchandise.restoreGalleryImage')(function* restore({ image, position }) {
        const assetId = mediaAssetIdOf(image);
        if (Option.isNone(assetId)) {
          return restoreImage(gallery, image, position);
        }
        const relinked = yield* relinkMediaToResource(transaction, {
          actionInvocationId: input.actionInvocationId,
          mediaAssetId: assetId.value,
          principalId: input.principalId,
          target: link,
        }).pipe(Effect.mapError(mediaFailure));
        return relinked ? restoreImage(gallery, image, position) : Option.none();
      }),
      Upload: Effect.fn('Merchandise.uploadGalleryImage')(function* upload({ image }) {
        const reference = mediaImageReference(input.actionInvocationId);
        const next = appendImage(gallery, reference);
        if (Option.isNone(next)) {
          return next;
        }
        yield* storeLinkedMediaImage(transaction, {
          actionInvocationId: input.actionInvocationId,
          ingestionSource: 'user',
          // The invocation id is unique per Action and replays return the recorded result, so it names the asset.
          mediaAssetId: input.actionInvocationId,
          principalId: input.principalId,
          target: link,
          upload: image,
        }).pipe(Effect.mapError(mediaFailure));
        return next;
      }),
    }),
  );
  if (Option.isNone(outcome)) {
    return yield* conflict(
      Predicate.isTagged(input.change, 'Upload') || Predicate.isTagged(input.change, 'Restore')
        ? 'Produkt už má největší povolený počet obrázků'
        : 'Obrázky produktu se mezitím změnily',
    );
  }
  return outcome.value;
});

/**
 * One rendition of an image the product's gallery lists, when the image is a Core Media Asset linked to it.
 * The storefront service key receives images of published, active products only.
 */
export const readProductImage = Effect.fn('Merchandise.readProductImage')(function* readProductImage(
  transaction: ScopedTransactionExecutor,
  store: StoreScope,
  input: {
    readonly image: string;
    readonly productId: string;
    readonly rendition: MediaRendition;
    readonly storefront: boolean;
  },
) {
  const assetId = mediaAssetIdOf(input.image);
  if (Option.isNone(assetId)) {
    return Option.none();
  }
  const [hydrated] = yield* loadProducts(transaction, store, eq(products.id, input.productId), {
    variants: false,
  }).pipe(Effect.mapError(unavailable));
  const product = hydrated?.product;
  if (
    product === undefined ||
    !(product.images ?? []).includes(input.image) ||
    (input.storefront && (!product.active || product.published === false || product.demoArchive !== undefined))
  ) {
    return Option.none();
  }
  return yield* readLinkedMediaRendition(transaction, {
    mediaAssetId: assetId.value,
    rendition: input.rendition,
    target: target(product.id),
  }).pipe(Effect.mapError(unavailable));
});
