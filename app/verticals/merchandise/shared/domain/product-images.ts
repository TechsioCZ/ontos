// Product gallery references and the pure rules of a gallery change. A gallery is an ordered list of image references;
// the first one is the main image the storefront shows. Uploaded images are Core Media Assets (`media:<asset>`);
// imported catalog images stay the source system's own https addresses. Neither form is ever shown to a person.
import { Option, Schema } from 'effect';

const MEDIA_REFERENCE_PREFIX = 'media:';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

/** At most this many images per product (the model's gallery limit). */
export const PRODUCT_GALLERY_LIMIT = 20;

/** Link kind of a product gallery image in Core Media. */
export const PRODUCT_IMAGE_LINK = { linkKind: 'gallery_image', moduleKey: 'demo.merchandise', resourceType: 'product' };

export const mediaImageReference = (mediaAssetId: string): string => `${MEDIA_REFERENCE_PREFIX}${mediaAssetId}`;

/** The Core Media Asset behind an uploaded-image reference; none for an external or storefront-path image. */
export const mediaAssetIdOf = (reference: string): Option.Option<string> => {
  if (!reference.startsWith(MEDIA_REFERENCE_PREFIX)) {
    return Option.none();
  }
  const id = reference.slice(MEDIA_REFERENCE_PREFIX.length).toLowerCase();
  return UUID.test(id) ? Option.some(id) : Option.none();
};

export const isMediaImageReference = (reference: string): boolean => Option.isSome(mediaAssetIdOf(reference));

/** Why a gallery change cannot apply to the current gallery. */
export const GalleryChangeProblemSchema = Schema.Literals(['changed', 'full', 'missing']);
export type GalleryChangeProblem = typeof GalleryChangeProblemSchema.Type;

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

/** Moves one image to a new position; position 0 is the main image. */
export const moveImage = <Value>(images: readonly Value[], from: number, to: number): readonly Value[] => {
  const moved = images[from];
  if (moved === undefined || to < 0 || to >= images.length || from === to) {
    return images;
  }
  const rest = images.filter((_, position) => position !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
};
