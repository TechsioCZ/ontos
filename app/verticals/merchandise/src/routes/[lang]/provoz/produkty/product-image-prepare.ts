// Prepares a chosen picture for upload in the browser: decodes it (honouring EXIF orientation), drops metadata,
// and encodes a full rendition (longest side ≤ 2000 px) and a thumbnail (≤ 480 px). Core re-validates every byte.
import { Base64 } from 'effect/encoding';
import { Duration, Effect, Schema } from 'effect';
import type { MediaImageUpload } from '@app/core-runtime';

/** What a person may choose; anything else is refused before upload with a Czech message. */
export const ACCEPTED_IMAGE_TYPES = { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] };
/** Largest original a person may choose; the prepared renditions are far smaller. */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

const FULL_EDGE = 2000;
const THUMBNAIL_EDGE = 480;

export class ImagePreparationFailed extends Schema.TaggedError<ImagePreparationFailed>()('ImagePreparationFailed', {
  reason: Schema.String,
}) {}

const failed = (reason: string) => () => new ImagePreparationFailed({ reason });

/** Browser image work is local but unbounded on a huge or hostile file; it never blocks the gallery forever. */
const LOCAL_WORK_LIMIT = Duration.seconds(30);

const fit = (width: number, height: number, edge: number) => {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { height: Math.max(1, Math.round(height * scale)), width: Math.max(1, Math.round(width * scale)) };
};

const draw = (image: HTMLImageElement, size: { readonly height: number; readonly width: number }, opaque: boolean) => {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  if (context === null) {
    return Effect.fail(new ImagePreparationFailed({ reason: 'Canvas is unavailable' }));
  }
  if (opaque) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, size.width, size.height);
  return Effect.succeed(canvas);
};

const toBlob = (canvas: OffscreenCanvas, type: 'image/jpeg' | 'image/webp', quality: number) =>
  Effect.tryPromise({
    catch: failed(`${type} encoding failed`),
    try: canvas.convertToBlob.bind(canvas, { quality, type }),
  }).pipe(
    Effect.timeoutOrElse({ duration: LOCAL_WORK_LIMIT, orElse: () => Effect.fail(failed('Encoding timed out')()) }),
  );

const encode = Effect.fn('ProductImagePrepare.encode')(function* encode(
  image: HTMLImageElement,
  edge: number,
  quality: number,
) {
  const size = fit(image.naturalWidth, image.naturalHeight, edge);
  let blob = yield* toBlob(yield* draw(image, size, false), 'image/webp', quality);
  // A browser without a WebP encoder returns PNG; JPEG keeps photos small there (transparency becomes white).
  if (blob.type !== 'image/webp') {
    blob = yield* toBlob(yield* draw(image, size, true), 'image/jpeg', quality);
  }
  const buffer = yield* Effect.tryPromise({
    catch: failed('Encoded image unreadable'),
    try: blob.arrayBuffer.bind(blob),
  }).pipe(Effect.timeoutOrElse({ duration: LOCAL_WORK_LIMIT, orElse: () => Effect.fail(failed('Read timed out')()) }));
  return { contentBase64: Base64.encode(new Uint8Array(buffer)), height: size.height, width: size.width };
});

/** Decodes the chosen file in an image element (browsers apply its EXIF orientation); the object URL is released. */
const decodeImage = (file: File) =>
  Effect.acquireUseRelease(
    Effect.sync(() => URL.createObjectURL(file)),
    (url) =>
      Effect.callback<HTMLImageElement, ImagePreparationFailed>((resume) => {
        const image = new Image();
        image.addEventListener('load', () => resume(Effect.succeed(image)), { once: true });
        image.addEventListener('error', () => resume(Effect.fail(failed('The picture cannot be decoded')())), {
          once: true,
        });
        image.src = url;
        return Effect.sync(() => {
          image.src = '';
        });
      }).pipe(
        Effect.timeoutOrElse({ duration: LOCAL_WORK_LIMIT, orElse: () => Effect.fail(failed('Decoding timed out')()) }),
      ),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );

/** The upload of one picture; fails when the browser cannot decode it (a damaged or disguised file). */
export const prepareImageUpload = (file: File): Effect.Effect<MediaImageUpload, ImagePreparationFailed> =>
  decodeImage(file).pipe(
    Effect.flatMap((image) =>
      Effect.all([encode(image, FULL_EDGE, 0.86), encode(image, THUMBNAIL_EDGE, 0.8)], { concurrency: 1 }),
    ),
    Effect.map(([full, thumbnail]) => ({ filename: file.name, full, thumbnail })),
  );
