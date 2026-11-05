import { Schema } from 'effect';

export const AccessCatalogReleaseErrorCodeSchema = Schema.Literals([
  /** A declaration, field group or module of the installed set is not a valid catalog entry. */
  'access_catalog_release_declarations_refused',
  /** The built entries are not a snapshot the model accepts (duplicate keys, unknown shape). */
  'access_catalog_release_snapshot_refused',
  /** The release store could not publish or read back the release. */
  'access_catalog_release_store_refused',
]);

export type AccessCatalogReleaseErrorCode = typeof AccessCatalogReleaseErrorCodeSchema.Type;

/** A release that could not be built. The reason names the declaration or the entry that refused it. */
export class AccessCatalogReleaseError extends Schema.TaggedError<AccessCatalogReleaseError>()(
  'AccessCatalogReleaseError',
  {
    code: AccessCatalogReleaseErrorCodeSchema,
    reason: Schema.String,
  },
) {}

export const releaseRefusal = (code: AccessCatalogReleaseErrorCode, reason: string): AccessCatalogReleaseError =>
  new AccessCatalogReleaseError({ code, reason });
