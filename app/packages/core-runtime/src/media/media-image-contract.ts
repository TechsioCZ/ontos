// Core Media contract: the browser-safe half of the governed file store. Upload shapes, limits, rendition names and
// content-signature detection live here so browser code and shared APIs never import the server store.
import { Schema } from 'effect';

/** Image types Core accepts, detected from content, never from a filename or a client-supplied MIME type. */
export const MEDIA_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MediaImageMimeType = (typeof MEDIA_IMAGE_MIME_TYPES)[number];

/** Stored byte limits per rendition. The browser prepares renditions; Core re-validates every byte. */
export const MEDIA_IMAGE_LIMITS = {
  fullMaxBytes: 5 * 1024 * 1024,
  maxDimension: 4096,
  thumbnailMaxBytes: 512 * 1024,
} as const;

export const MEDIA_RENDITIONS = ['full', 'thumbnail'] as const;
export const MediaRenditionSchema = Schema.Literals(MEDIA_RENDITIONS);
export type MediaRendition = typeof MediaRenditionSchema.Type;

const DimensionSchema = Schema.Int.check(Schema.isBetween({ maximum: MEDIA_IMAGE_LIMITS.maxDimension, minimum: 1 }));
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

const renditionInput = (maxBytes: number) =>
  Schema.Struct({
    contentBase64: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(base64Length(maxBytes))),
    height: Schema.optionalKey(DimensionSchema),
    width: Schema.optionalKey(DimensionSchema),
  });

/** One uploaded image: the full rendition and an optional thumbnail of the same picture. */
export const MediaImageUploadSchema = Schema.Struct({
  filename: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  full: renditionInput(MEDIA_IMAGE_LIMITS.fullMaxBytes),
  thumbnail: Schema.optionalKey(renditionInput(MEDIA_IMAGE_LIMITS.thumbnailMaxBytes)),
});
export type MediaImageUpload = typeof MediaImageUploadSchema.Type;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

/** The image type proven by the content's signature; undefined for anything Core does not accept. */
export const detectImageMimeType = (bytes: Uint8Array): MediaImageMimeType | undefined => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return undefined;
};
