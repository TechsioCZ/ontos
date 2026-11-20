import { Match, Schema } from 'effect';

import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import type { MediaAssetRef } from '../resources/media-asset.ts';
import type { MediaStatOutcome } from './verified-read.ts';

/*
 * Current V1 of a Media Asset (#1443, ADR-0031): the owner-issued answer Catalog's `CatalogDocumentOwnerAvailabilityPort`
 * asks for. A confirmed, usable Media Asset has exactly one logical V1 and it is automatically Current with
 * `revision = 1`; the number is a constant of that rule, derived from the asset and stored nowhere (no version
 * table, no pointer, no V2). It is NEVER the provider's version reference, and there is no `revisionId`.
 *
 * The wire shape is the one of Catalog's `CatalogDocumentAvailability` minus `FORBIDDEN`: a tenant-wide capability
 * decides the whole call, so a principal without it is refused by the governed Read (and the consumer reports
 * FORBIDDEN for every ref); no entry can carry it. Exactly one entry answers each requested ref, in request order.
 *
 * This file is browser-safe schemas and data only: nothing here names a storage value.
 */

/** The one revision of the one logical version of a Launch Media Asset. */
export const MEDIA_CURRENT_REVISION = 1;

/**
 * The refs to answer. Non-empty and otherwise unbounded on purpose: no per-set number is invented here, so the
 * ceilings are the platform's existing ones (request body size and the read execution budget).
 */
export const AssetCurrentRequestSchema = Schema.Struct({
  mediaAssetRefs: Schema.NonEmptyArray(MediaAssetRefSchema),
});

const AssetCurrentRevisionSchema = Schema.Struct({
  resourceRef: MediaAssetRefSchema,
  revision: Schema.Literal(MEDIA_CURRENT_REVISION),
});

const sameRef = (left: MediaAssetRef, right: MediaAssetRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const AvailableEntrySchema = Schema.Struct({
  current: AssetCurrentRevisionSchema,
  kind: Schema.Literal('AVAILABLE'),
  resourceRef: MediaAssetRefSchema,
}).check(
  Schema.makeFilter(({ current, resourceRef }) =>
    sameRef(current.resourceRef, resourceRef) ? undefined : 'The Current of an asset names that asset',
  ),
);

const UnconfirmedEntrySchema = Schema.Struct({
  kind: Schema.Literals(['ABSENT', 'CURRENT_UNVERIFIED', 'UNAVAILABLE']),
  resourceRef: MediaAssetRefSchema,
});

const AssetCurrentEntrySchema = Schema.Union([AvailableEntrySchema, UnconfirmedEntrySchema]);
export type AssetCurrentEntry = typeof AssetCurrentEntrySchema.Type;

export const AssetCurrentResponseSchema = Schema.Struct({ entries: Schema.Array(AssetCurrentEntrySchema) });

/**
 * The state of one requested ref, from what Core found (ledger A13). The asset must be absent in the trusted tenant
 * (also another tenant's id: the two are one answer), or a stat of a stored object judged it:
 * - `present` is the only AVAILABLE: a ready, sealed identity whose stored object the provider confirms now;
 * - a provider that cannot answer is UNAVAILABLE (retry; nothing durable changes);
 * - every other result (not ready, failed, object missing, size or version pin differs) is CURRENT_UNVERIFIED:
 *   the asset exists, but V1 is not confirmed usable, and nothing is claimed about corruption.
 */
export const currentEntryOf = (resourceRef: MediaAssetRef, found: 'absent' | MediaStatOutcome): AssetCurrentEntry => {
  if (found === 'absent') {
    return { kind: 'ABSENT', resourceRef };
  }
  return Match.value(found).pipe(
    Match.discriminatorsExhaustive('outcome')({
      inconsistent_metadata: (): AssetCurrentEntry => ({ kind: 'CURRENT_UNVERIFIED', resourceRef }),
      missing_object: (): AssetCurrentEntry => ({ kind: 'CURRENT_UNVERIFIED', resourceRef }),
      present: (): AssetCurrentEntry => ({
        current: { resourceRef, revision: MEDIA_CURRENT_REVISION },
        kind: 'AVAILABLE',
        resourceRef,
      }),
      unavailable: (): AssetCurrentEntry => ({ kind: 'UNAVAILABLE', resourceRef }),
    }),
  );
};
