import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  ResourceContainmentRelationshipMutation,
  coreSearchIngestionRegistryLayer,
  defineCoreSearchIngestionRegistrations,
  ownerResourceModuleContainment,
} from '@app/core-runtime';
import type { OperationalScope, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Array as Arr, Context, Effect, Layer, Schema } from 'effect';
import type { AgreementsState } from '../../shared/apis/records.ts';
import { SearchSource } from './search-source.ts';
import { searchUnavailable as unavailable } from '../../shared/domain/search-projection-error.ts';

const moduleId = 'legal.agreements';
export const searchIngestionRegistrations = defineCoreSearchIngestionRegistrations([
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'legal.agreements.search-changed.v1',
    workerKey: 'legal.agreements.project-search',
  },
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'legal.agreements.search-rebuild-requested.v1',
    workerKey: 'legal.agreements.rebuild-search',
  },
]);
export const SearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(searchIngestionRegistrations);
export interface SearchSnapshot {
  readonly companies: readonly { readonly legalEntityId: string; readonly state: AgreementsState }[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}

/** Only the public subject and human contract kind. No notes, signers, rent, contacts or file contents. */
export const buildSearchDocuments = Effect.fn('Agreements.buildSearchDocuments')(function* build(
  snapshot: SearchSnapshot,
) {
  if (
    snapshot.companies.some(({ state }) =>
      state.contracts.some(({ contractRef }) => contractRef.tenantId !== snapshot.tenantId),
    )
  ) {
    return yield* unavailable();
  }
  const documents = snapshot.companies.flatMap(({ legalEntityId, state }) =>
    state.contracts.flatMap((contract) => {
      if (contract.lifecycleState === 'TERMINATED' || contract.lifecycleState === 'EXPIRED') {
        return [];
      }
      const title = contract.subject ?? (contract.kind === 'LEASE' ? 'Nájemní smlouva' : 'Smlouva');
      return [
        {
          archived: false,
          facets: [],
          metadata: [],
          projectionVersion: snapshot.projectionVersion,
          ref: contract.contractRef,
          searchableText: [title],
          selectedLegalEntityId: legalEntityId,
          title,
        },
      ];
    }),
  );
  return yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(documents).pipe(
    Effect.mapError(unavailable),
  );
});
export const createSearchProjector = Effect.gen(function* createProjector() {
  const sourcePort = yield* SearchSource;
  const store = yield* CoreSearchProjectionStore;
  const containment = yield* ResourceContainmentRelationshipMutation;
  return {
    project: Effect.fn('Agreements.projectSearch')(function* project(context: OutboxWorkerHandlerContext) {
      const source = yield* sourcePort.load(context);
      if (source.tenantId !== context.tenantId) {
        return yield* unavailable();
      }
      const documents = yield* buildSearchDocuments(source);
      // All snapshot SQL has committed. Containment is a governed, idempotent module_access TOUCH, never a grant.
      const relationships = yield* Effect.forEach(
        documents,
        (document) => {
          const relationship =
            document.selectedLegalEntityId === undefined
              ? undefined
              : ownerResourceModuleContainment(source.tenantId, document.selectedLegalEntityId, document.ref);
          return relationship === undefined ? Effect.fail(unavailable()) : Effect.succeed(relationship);
        },
        { concurrency: 1 },
      );
      yield* Effect.forEach(Arr.chunksOf(relationships, 100), (batch) => containment.touch({ relationships: batch }), {
        concurrency: 1,
        discard: true,
      }).pipe(Effect.mapError(unavailable));
      // Every event replaces a Core-versioned full owner snapshot, removing deleted or ended contracts.
      yield* Effect.forEach(
        ['legal.agreements.contract'],
        (resourceType) =>
          store.replace(
            {
              documents: documents.filter((document) => document.ref.resourceType === resourceType),
              moduleId,
              rebuildVersion: source.projectionVersion,
              resourceType,
              tenantId: source.tenantId,
            },
            context,
          ),
        { concurrency: 1, discard: true },
      ).pipe(Effect.mapError(unavailable));
      return yield* Effect.void;
    }),
  };
});
export class SearchProjector extends Context.Service<SearchProjector, Effect.Success<typeof createSearchProjector>>()(
  '@app/legal-agreements/services/search-projection/SearchProjector',
) {}
export const SearchProjectorLive = Layer.effect(SearchProjector, createSearchProjector);

export const loadSearchHits = Effect.fn('Agreements.loadSearchHits')(function* load(
  scope: OperationalScope,
  resourceType: 'legal.agreements.contract',
  input: { readonly includeArchived?: boolean; readonly query: string },
) {
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  const runtime = yield* CoreSearchQueryRuntime;
  const hits = yield* runtime.search(
    {
      includeArchived: false,
      moduleId,
      query: input.query,
      resourceType,
      selectedLegalEntityId: scope.legalEntityId,
      tenantId: scope.tenantId,
    },
    scope,
  );
  return yield* Effect.forEach(
    hits,
    (hit) => {
      if (
        hit.ref.moduleId !== moduleId ||
        hit.ref.resourceType !== resourceType ||
        hit.ref.tenantId !== scope.tenantId ||
        hit.selectedLegalEntityId !== scope.legalEntityId ||
        hit.archived
      ) {
        return Effect.fail(unavailable());
      }
      return Effect.succeed({ ref: hit.ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title });
    },
    { concurrency: 1 },
  );
});
