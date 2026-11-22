import type { coreOperations } from '@app/core-runtime/sdk/core';
import type { CallOutcome, OperationInput, OperationOutput } from '@app/core-runtime/sdk';
import { Data, Effect, Match, Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '@app/catalog-selection-contracts/catalog-resource-reference';

import { sameCatalogDocumentResourceRef } from '../../shared/domain/catalog-media-assignment.ts';
import type {
  CatalogDocumentAvailability,
  CatalogDocumentResourceRef,
} from '../../shared/domain/catalog-media-assignment.ts';

/*
 * Catalog's binding of the owner-evidence port to Core Media (#1443, ADR-0031): the one place that turns Core's
 * Current V1 answer into `CatalogDocumentAvailability`. Core answers through the SDK `call` (relaying the requester
 * to the Shell host that holds the object store); this adapter never reaches a Core table, a provider or a credential.
 *
 * What it guarantees, whatever Core answers:
 * - a ref that Core Media does not own gets NO evidence (Catalog's own logic then keeps it unresolved and the read
 *   fails safe), and no ref is ever sent to an owner that does not own it;
 * - exactly one entry per requested ref, the same ref, in the same order: anything else fails the whole call instead
 *   of inventing, swapping or dropping an entry, so an unmatched assignment can never look available;
 * - AVAILABLE only from an AVAILABLE entry carrying revision 1 for that very ref (Core's own schema already refuses
 *   another revision or a `revisionId`); the revision is Core's, Catalog adds none;
 * - a refused call (the requester lacks the Current capability) is FORBIDDEN for every ref; a missing, rejected or
 *   unavailable answer fails the call, which Catalog answers as `read_handler_unavailable`.
 */

const CORE_MEDIA_MODULE_ID = 'core.media' as const;
const CORE_MEDIA_ASSET_RESOURCE_TYPE = 'core.media.asset' as const;

/** Core could not give a complete, trustworthy answer: the read stays unavailable, nothing is promoted. */
export class CoreMediaCurrentUnavailable extends Data.TaggedError('CoreMediaCurrentUnavailable')<{
  readonly reason: string;
}> {}

type AssetCurrentRequest = OperationInput<typeof coreOperations.assetCurrent>;
type AssetCurrentResponse = OperationOutput<typeof coreOperations.assetCurrent>;

export interface CoreMediaOwnerCall {
  readonly call: (payload: AssetCurrentRequest) => Effect.Effect<CallOutcome<AssetCurrentResponse>>;
}

const isCoreMediaAsset = (ref: CatalogDocumentResourceRef): boolean =>
  ref.moduleId === CORE_MEDIA_MODULE_ID && ref.resourceType === CORE_MEDIA_ASSET_RESOURCE_TYPE;

const decodeRevision = Schema.decodeUnknownEffect(CatalogRevisionNumberSchema);

/** One entry per requested ref, the same ref in the same order, or the whole answer is refused. */
const answered = Effect.fn('CoreMediaOwner.answered')(function* answered(
  requested: readonly CatalogDocumentResourceRef[],
  response: AssetCurrentResponse,
) {
  const { entries } = response;
  if (entries.length !== requested.length) {
    return yield* new CoreMediaCurrentUnavailable({ reason: 'Core answered another number of entries' });
  }
  return yield* Effect.forEach(
    requested,
    Effect.fn('CoreMediaOwner.availabilityOf')(function* availabilityOf(
      ref: CatalogDocumentResourceRef,
      index: number,
    ) {
      const entry = entries[index];
      if (entry === undefined || !sameCatalogDocumentResourceRef(ref, { ...entry.resourceRef })) {
        return yield* new CoreMediaCurrentUnavailable({ reason: 'Core answered another ref than the requested one' });
      }
      if (entry.kind !== 'AVAILABLE') {
        return { kind: entry.kind, resourceRef: ref } satisfies CatalogDocumentAvailability;
      }
      // Core's own schema pins the revision to 1; Catalog only gives it its branded type, it never adds one.
      const revision = yield* decodeRevision(entry.current.revision).pipe(
        Effect.catchTag('SchemaError', () =>
          Effect.fail(new CoreMediaCurrentUnavailable({ reason: 'Core answered an unreadable revision' })),
        ),
      );
      return {
        current: { resourceRef: ref, revision },
        kind: 'AVAILABLE',
        resourceRef: ref,
      } satisfies CatalogDocumentAvailability;
    }),
    { concurrency: 1 },
  );
});

/** The owner-availability evidence for the Core Media refs among `resources`, from Core's Current V1. */
export const coreMediaOwnerAvailability = Effect.fn('CoreMediaOwner.readCurrentAvailability')(
  function* coreMediaOwnerAvailability(
    owner: CoreMediaOwnerCall,
    resources: readonly CatalogDocumentResourceRef[],
  ): Effect.fn.Return<readonly CatalogDocumentAvailability[], CoreMediaCurrentUnavailable> {
    const requested = resources.filter(isCoreMediaAsset);
    const [first, ...rest] = requested.map(({ resourceId, tenantId }) => ({
      moduleId: CORE_MEDIA_MODULE_ID,
      resourceId,
      resourceType: CORE_MEDIA_ASSET_RESOURCE_TYPE,
      tenantId,
    }));
    if (first === undefined) {
      return [];
    }
    const outcome = yield* owner.call({ mediaAssetRefs: [first, ...rest] });
    return yield* Match.value(outcome).pipe(
      Match.tag('Ok', ({ value }) => answered(requested, value)),
      // The requester is refused the capability: every ref is forbidden for them, none is absent or available.
      Match.tag('Forbidden', () =>
        Effect.succeed(requested.map((ref): CatalogDocumentAvailability => ({ kind: 'FORBIDDEN', resourceRef: ref }))),
      ),
      Match.tag('NotFound', 'Rejected', 'Unavailable', () =>
        Effect.fail(new CoreMediaCurrentUnavailable({ reason: 'Core Media Current is unavailable' })),
      ),
      Match.exhaustive,
    );
  },
);
