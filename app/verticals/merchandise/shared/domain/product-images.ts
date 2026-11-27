// Product gallery references, the photo library and the pure rules of a gallery change. A gallery is an ordered list of
// image references; the first one is the main image the storefront shows. Uploaded images are Core Media Assets
// (`media:<asset>`); imported catalog images stay the source system's own https addresses. Neither form is ever shown to
// a person.
import { Option, Schema } from 'effect';

const MEDIA_REFERENCE_PREFIX = 'media:';
export const MediaImageReferenceSchema = Schema.String.check(
  Schema.isPattern(/^media:[\da-fA-F]{8}-[\da-fA-F]{4}-[1-8][\da-fA-F]{3}-[89abAB][\da-fA-F]{3}-[\da-fA-F]{12}$/u),
);

/** At most this many images per product (the model's gallery limit). */
export const PRODUCT_GALLERY_LIMIT = 20;

/** At most this many references in a product's photo library; the longest-unused ones leave first. */
export const PRODUCT_PHOTO_LIBRARY_LIMIT = 200;

interface PhotoHolder {
  readonly images?: readonly string[];
  readonly imageSrc?: string;
  readonly photoLibrary?: readonly string[];
  readonly variants?: readonly { readonly imageSrc?: string }[];
}

/** The photos the product shows now: its gallery, its main image and every variant's image, each once. */
export const shownPhotosOf = (product: PhotoHolder): readonly string[] => [
  ...new Set(
    [
      ...(product.images ?? []),
      product.imageSrc ?? '',
      ...(product.variants ?? []).map((variant) => variant.imageSrc ?? ''),
    ].filter((reference) => reference.trim() !== ''),
  ),
];

/**
 * The server-kept photo library of a product after a write: every photo it showed before or shows now, so any
 * operator can give a variant an earlier photo again. Photos no longer shown come first, the shown ones last.
 */
export const photoLibraryAfter = (before: PhotoHolder | undefined, after: PhotoHolder): readonly string[] => {
  const shown = shownPhotosOf(after);
  const current = new Set(shown);
  const earlier = [...(before?.photoLibrary ?? []), ...(before === undefined ? [] : shownPhotosOf(before))];
  return [...new Set([...earlier.filter((reference) => !current.has(reference)), ...shown])].slice(
    -PRODUCT_PHOTO_LIBRARY_LIMIT,
  );
};

/** Link kind of a product gallery image in Core Media. */
export const PRODUCT_IMAGE_LINK = { linkKind: 'gallery_image', moduleKey: 'demo.merchandise', resourceType: 'product' };

export const mediaImageReference = (mediaAssetId: string): string => `${MEDIA_REFERENCE_PREFIX}${mediaAssetId}`;

export const isMediaImageReference = Schema.is(MediaImageReferenceSchema);

/** The Core Media Asset behind an uploaded-image reference; none for an external or storefront-path image. */
export const mediaAssetIdOf = (reference: string): Option.Option<string> =>
  isMediaImageReference(reference)
    ? Option.some(reference.slice(MEDIA_REFERENCE_PREFIX.length).toLowerCase())
    : Option.none();

/** Appends an uploaded image; the gallery holds at most `PRODUCT_GALLERY_LIMIT` images. */
export const appendImage = (gallery: readonly string[], reference: string): Option.Option<readonly string[]> => {
  if (gallery.includes(reference)) {
    return Option.some(gallery);
  }
  return gallery.length >= PRODUCT_GALLERY_LIMIT ? Option.none() : Option.some([...gallery, reference]);
};

/**
 * A reorder names the whole gallery in its new order. It applies only when it is a permutation of the current
 * gallery, so a reorder made against an older gallery never drops or resurrects an image.
 */
export const reorderGallery = (
  gallery: readonly string[],
  order: readonly string[],
): Option.Option<readonly string[]> => {
  const current = new Set(gallery);
  return order.length === gallery.length &&
    new Set(order).size === order.length &&
    order.every((reference) => current.has(reference))
    ? Option.some([...order])
    : Option.none();
};

export const removeImage = (gallery: readonly string[], reference: string): Option.Option<readonly string[]> =>
  gallery.includes(reference) ? Option.some(gallery.filter((entry) => entry !== reference)) : Option.none();

/** Puts a removed image back at its former position (undo); an image already present stays where it is. */
export const restoreImage = (
  gallery: readonly string[],
  reference: string,
  position: number,
): Option.Option<readonly string[]> => {
  if (gallery.includes(reference)) {
    return Option.some(gallery);
  }
  if (gallery.length >= PRODUCT_GALLERY_LIMIT) {
    return Option.none();
  }
  const at = Math.max(0, Math.min(position, gallery.length));
  return Option.some([...gallery.slice(0, at), reference, ...gallery.slice(at)]);
};

/**
 * The gallery a `Set` saves: no image twice, at most `PRODUCT_GALLERY_LIMIT`. An image the gallery does not have yet
 * must be an uploaded picture (`media:<asset>`); an outside address can only stay where it already is.
 */
export const setGallery = (gallery: readonly string[], images: readonly string[]): Option.Option<readonly string[]> => {
  const current = new Set(gallery);
  return images.length <= PRODUCT_GALLERY_LIMIT &&
    new Set(images).size === images.length &&
    images.every((reference) => current.has(reference) || isMediaImageReference(reference))
    ? Option.some([...images])
    : Option.none();
};

/** Moves one image to a new position; position 0 is the main image. */
export const moveImage = <Value>(images: readonly Value[], from: number, to: number): readonly Value[] => {
  const moved = images[from];
  if (moved === undefined || to < 0 || to >= images.length || from === to) {
    return images;
  }
  const rest = images.filter((_, position) => position !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
};
