// Where the staff screens get a product image from. Uploaded images come through the governed media read (each
// read is access evidence) and become in-memory object URLs; an asset's content never changes, so one fetched
// rendition is reused for the whole session. Imported catalog images keep their source system's https address.
import { Cache, Data, Duration, Effect, Exit, Option, Random } from 'effect';
import { Base64 } from 'effect/encoding';
import { constVoid } from 'effect/Function';
import { useEffect, useState } from 'react';
import type { MediaRendition } from '@app/core-runtime/media/image-contract';
import { executeMedia } from '../../../../api/media-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { mediaAssetIdOf } from '../../../../../shared/domain/product-images.ts';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { AKROS_STOREFRONT_ORIGIN } from '../../../../../shared/storefront-urls.ts';

export type ImageSource =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly src: string; readonly status: 'ready' };

/** The address of an image that is not a Core Media Asset; none when nothing can serve it. */
export const externalImageUrl = (reference: string): string | undefined => {
  if (reference.startsWith('https://')) {
    return reference;
  }
  return reference.startsWith('/akros/') && AKROS_STOREFRONT_ORIGIN !== undefined
    ? `${AKROS_STOREFRONT_ORIGIN}${reference}`
    : undefined;
};

/** One rendition of one product image; equal keys share one cached object URL. */
class MediaKey extends Data.Class<{
  readonly productId: ProductId;
  readonly reference: string;
  readonly rendition: MediaRendition;
}> {}

const correlationId = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second]) => `merchandise:media:${first}:${second}`,
);

const fetchObjectUrl = Effect.fn('MerchandiseMedia.fetchObjectUrl')(function* fetchObjectUrl(request: MediaKey) {
  const correlation = yield* correlationId;
  const image = yield* executeMedia(
    { image: request.reference, productId: request.productId, rendition: request.rendition },
    correlation,
  );
  const bytes = yield* Effect.fromResult(Base64.decode(image.contentBase64));
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: image.mimeType }));
});

// Successful renditions stay for the session (asset bytes are immutable); a failed read is retried on next view.
const objectUrls = browserRuntime.runSync(
  Cache.makeWith(fetchObjectUrl, {
    capacity: 500,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  }),
);

/** Registers a just-uploaded picture's local preview so the new tile never flashes empty. */
export const rememberLocalPreview = (
  productId: ProductId,
  reference: string,
  rendition: MediaRendition,
  url: string,
) => {
  browserRuntime.runSync(Cache.set(objectUrls, new MediaKey({ productId, reference, rendition }), url));
};

export const useImageSource = (productId: ProductId, reference: string, rendition: MediaRendition): ImageSource => {
  const media = Option.isSome(mediaAssetIdOf(reference));
  const external = media ? undefined : externalImageUrl(reference);
  const key = `${rendition}|${productId}|${reference}`;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly url: string | null } | null>(null);
  useEffect(() => {
    if (!media) {
      return constVoid;
    }
    let current = true;
    browserRuntime.runFork(
      Cache.get(objectUrls, new MediaKey({ productId, reference, rendition })).pipe(
        Effect.match({
          onFailure: (error) => {
            if (current) {
              setLoaded({ key, url: null });
            }
            return error;
          },
          onSuccess: (url) => {
            if (current) {
              setLoaded({ key, url });
            }
            return url;
          },
        }),
      ),
    );
    return () => {
      current = false;
    };
  }, [key, media, productId, reference, rendition]);
  if (!media) {
    return external === undefined ? { status: 'missing' } : { src: external, status: 'ready' };
  }
  if (loaded?.key !== key) {
    return { status: 'loading' };
  }
  return loaded.url === null ? { status: 'missing' } : { src: loaded.url, status: 'ready' };
};
