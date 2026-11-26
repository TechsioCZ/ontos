import type { coreOperations } from '@app/core-runtime/sdk/core';
import type { CallOutcome, OperationInput, OperationOutput } from '@app/core-runtime/sdk';
import { Array as Arr, Data, Effect, Match, Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '@app/catalog-selection-contracts/catalog-resource-reference';

import { sameCatalogDocumentResourceRef } from '../../shared/domain/catalog-media-assignment.ts';
import type { CatalogDocumentResourceRef } from '../../shared/domain/catalog-media-assignment.ts';
import type { CatalogDocumentOwnerAnswer } from '../persistence/catalog-document-reads.ts';

/*
 * Catalog's binding of the owner-evidence port to Core Media (#1443, ADR-0031): the one place that turns Core's
 * Current V1 answer into `CatalogDocumentAvailability`. Core answers through the SDK `call` (relaying the requester
 * to the Shell host that holds the object store); this adapter never reaches a Core table, a provider or a credential.
 *
 * What it guarantees, whatever Core answers:
 * - a ref that Core Media does not own gets NO evidence (Catalog's own logic then keeps it unresolved and the read
 *   fails safe), and no ref is ever sent to an owner that does not own it;
 * - Core is asked once per distinct Resource, and each entry is judged at the place of its own request, in Core's
 *   request order; entries are never re-paired by identity, so a swapped answer proves nothing (#1443 G, #1446 13):
 *   - the requested ref: the owner's own state;
 *   - another ref: the evidence keeps that other ref and is never AVAILABLE, so Catalog says RESOURCE_MISMATCH;
 *   - no entry: no evidence, so Catalog says OWNER_CHECK_REQUIRED, which its public response cannot carry;
 * - entries nobody asked for fail the whole call;
 * - AVAILABLE only from an AVAILABLE entry carrying revision 1 for that very ref (Core's own schema already refuses
 *   another revision or a `revisionId`); the revision is Core's, Catalog adds none;
 * - a refused call (the requester lacks the Current capability) is FORBIDDEN for every ref; a missing, rejected or
 *   unavailable answer fails the call, which Catalog answers as `read_handler_unavailable`.
 */

const CORE_MEDIA_MODULE_ID = 'core.media' as const;
const CORE_MEDIA_ASSET_RESOURCE_TYPE = 'core.media.asset' as const;

/** Core could not give a trustworthy answer: the read stays unavailable, nothing is promoted. */
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

/** What the entry at the place of `requested` proves about it. */
const answerOf = Effect.fn('CoreMediaOwner.answerOf')(function* answerOf(
  requested: CatalogDocumentResourceRef,
  entry: AssetCurrentResponse['entries'][number],
): Effect.fn.Return<CatalogDocumentOwnerAnswer, CoreMediaCurrentUnavailable> {
  const resourceRef = { ...entry.resourceRef };
  if (!sameCatalogDocumentResourceRef(requested, resourceRef)) {
    return { evidence: { kind: 'CURRENT_UNVERIFIED', resourceRef }, requested };
  }
  if (entry.kind !== 'AVAILABLE') {
    return { evidence: { kind: entry.kind, resourceRef: requested }, requested };
  }
  // Core's own schema pins the revision to 1; Catalog only gives it its branded type, it never adds one.
  const revision = yield* decodeRevision(entry.current.revision).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(new CoreMediaCurrentUnavailable({ reason: 'Core answered an unreadable revision' })),
    ),
  );
  return {
    evidence: { current: { resourceRef: requested, revision }, kind: 'AVAILABLE', resourceRef: requested },
    requested,
  };
});

/** One answer per entry, at its request's place; a requested ref past the last entry has no answer. */
const answered = Effect.fn('CoreMediaOwner.answered')(function* answered(
  requested: readonly CatalogDocumentResourceRef[],
  response: AssetCurrentResponse,
) {
  if (response.entries.length > requested.length) {
    return yield* new CoreMediaCurrentUnavailable({ reason: 'Core answered entries nobody asked for' });
  }
  return yield* Effect.forEach(Arr.zip(requested, response.entries), ([ref, entry]) => answerOf(ref, entry), {
    concurrency: 1,
  });
});

/** The owner's answers for the Core Media refs among `resources`, from Core's Current V1. */
export const coreMediaOwnerAvailability = Effect.fn('CoreMediaOwner.readCurrentAvailability')(
  function* coreMediaOwnerAvailability(
    owner: CoreMediaOwnerCall,
    resources: readonly CatalogDocumentResourceRef[],
  ): Effect.fn.Return<readonly CatalogDocumentOwnerAnswer[], CoreMediaCurrentUnavailable> {
    const requested = Arr.dedupeWith(resources.filter(isCoreMediaAsset), sameCatalogDocumentResourceRef);
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
        Effect.succeed(
          requested.map((ref): CatalogDocumentOwnerAnswer => ({
            evidence: { kind: 'FORBIDDEN', resourceRef: ref },
            requested: ref,
          })),
        ),
      ),
      Match.tag('NotFound', 'Rejected', 'Unavailable', () =>
        Effect.fail(new CoreMediaCurrentUnavailable({ reason: 'Core Media Current is unavailable' })),
      ),
      Match.exhaustive,
    );
  },
);
