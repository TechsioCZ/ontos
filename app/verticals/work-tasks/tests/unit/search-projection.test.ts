import {
  CoreSearchQueryRuntime,
  CoreSearchIngestion,
  CoreSearchProjectionStore,
  CoreSearchWorkerSnapshot,
  ResourceContainmentRelationshipMutation,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { ResourceContainmentRelationshipMutationInput } from '@app/core-runtime';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import { buildSearchDocuments, publishSearchSnapshot } from '../../src/services/search-projection.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';
import { loadSearch } from '../../src/services/search-read.ts';
import { searchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import { company, context, otherCompany, otherTenant, ref, scope, snapshot } from './search-fixtures.ts';

it.effect('indexes only human titles with exact tenant, resource type and company', () =>
  Effect.gen(function* test() {
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents).toMatchObject([
      {
        archived: false,
        ref,
        searchableText: [snapshot.records[0]?.title],
        selectedLegalEntityId: company,
        title: snapshot.records[0]?.title,
      },
    ]);
    expect(documents[0]?.metadata).toEqual([]);
    expect(documents[0]?.aliases).toEqual([]);
  }),
);
it.effect('fails foreign tenants and duplicate identities across companies before publishing', () =>
  Effect.gen(function* test() {
    const foreign = yield* buildSearchDocuments({ ...snapshot, tenantId: otherTenant }).pipe(Effect.exit);
    expect(Exit.isFailure(foreign)).toBe(true);
    const duplicate = yield* buildSearchDocuments({
      ...snapshot,
      records: [...snapshot.records, { archived: false, legalEntityId: otherCompany, ref, title: 'Foreign' }],
    }).pipe(Effect.exit);
    expect(Exit.isFailure(duplicate)).toBe(true);
  }),
);
it.effect('lifecycle update, archive, deletion and rebuild are version fenced and repair containment', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const relationships: ResourceContainmentRelationshipMutationInput[] = [];
    const publish = (next: typeof snapshot) =>
      publishSearchSnapshot(context, next).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: (batch) =>
            Effect.sync(() => {
              relationships.push(batch);
            }),
        }),
      );
    yield* publish(snapshot);
    yield* publish(snapshot);
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
    expect(
      yield* loadSearch({ ...scope, legalEntityId: otherCompany }, 'cerstva').pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
    expect(
      yield* loadSearch({ ...scope, tenantId: otherTenant }, 'cerstva').pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
    expect(relationships[0]?.relationships).toMatchObject([
      { container: { objectType: 'module_access' }, relation: 'module' },
    ]);
    expect(relationships.every((batch) => batch.relationships.every((edge) => edge.relation === 'module'))).toBe(true);
    yield* publish({
      ...snapshot,
      projectionVersion: '2',
      records: [{ archived: false, legalEntityId: company, ref, title: 'Nová nabídka' }],
    });
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    expect(yield* loadSearch(scope, 'nova').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toHaveLength(
      1,
    );
    yield* publish({
      ...snapshot,
      projectionVersion: '3',
      records: [{ archived: true, legalEntityId: company, ref, title: 'Nová nabídka' }],
    });
    expect(yield* loadSearch(scope, 'nova').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([]);
    yield* publish({ ...snapshot, projectionVersion: '4', records: [] });
    yield* publish(snapshot);
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
  }),
);
it.effect('rejects a mismatched trusted snapshot before attempting owner SQL', () =>
  Effect.gen(function* test() {
    const outcome = yield* loadSearchSnapshot(context).pipe(
      Effect.provideService(CoreSearchWorkerSnapshot, {
        read: (_context, read) =>
          read({
            eventWatermark: '1',
            forLegalEntity: () => Effect.die('Unexpected owner SQL'),
            legalEntityIds: [company],
            projectionVersion: '1',
            tenant: () => Effect.die('Unexpected tenant SQL'),
            tenantId: otherTenant,
          }),
      }),
      Effect.exit,
    );
    expect(Exit.isFailure(outcome)).toBe(true);
  }),
);
