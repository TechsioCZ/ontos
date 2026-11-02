import {
  CoreSearchProjectionStore,
  CoreSearchIngestion,
  ResourceContainmentRelationshipMutation,
  CoreSearchProjectionUnavailable,
  ReadHandlerUnavailable,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { ResourceContainmentRelationshipMutationInput } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { SearchSource } from '../../src/services/search-source.service.ts';
import { expect, it } from 'effect-rstest';
import {
  buildSearchDocuments,
  makeSearchProjection,
  searchIngestionRegistrations,
} from '../../src/services/search-projection.service.ts';
import { companyId, context, otherCompanyId, rebuildContext, scope, snapshot, state } from './search-fixtures.ts';

it.effect('indexes client/contact names and company scope, but no private contact values or notes', () =>
  Effect.gen(function* projectionTest() {
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents.map((doc) => [doc.ref.resourceType, doc.title, doc.selectedLegalEntityId])).toEqual([
      ['demo.crm.client', 'Železárny Hanák', companyId],
      ['demo.crm.contact', 'Jiří Novotný', companyId],
    ]);
    expect(documents[0]?.searchableText).toEqual(['Železárny Hanák', '12345678']);
    expect(documents[1]?.searchableText).toEqual(['Jiří Novotný']);
    expect(JSON.stringify(documents)).not.toContain('private');
    expect(JSON.stringify(documents)).not.toContain('@example');
  }),
);

it.effect('updates, removes, rebuilds, contains, and rejects stale delivery without cross-company matches', () =>
  Effect.gen(function* projectionTest() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const search = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    let current = snapshot;
    const touched: ResourceContainmentRelationshipMutationInput[] = [];
    const projector = yield* makeSearchProjection.pipe(
      Effect.provideService(SearchSource, { load: () => Effect.succeed(current) }),
      Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(ResourceContainmentRelationshipMutation, {
        touch: (input) =>
          Effect.sync(() => {
            touched.push(input);
          }),
      }),
    );
    const find = (resourceType: string, query: string, selectedLegalEntityId = companyId) =>
      search.search(
        {
          includeArchived: false,
          moduleId: 'demo.crm',
          query,
          resourceType,
          selectedLegalEntityId,
          tenantId: scope.tenantId,
        },
        { ...scope, legalEntityId: selectedLegalEntityId },
      );
    yield* projector.project(context, { entityIds: ['client-1', 'contact-1'] });
    expect((yield* find('demo.crm.client', 'zelezarny')).length).toBe(1);
    expect((yield* find('demo.crm.contact', 'jiri')).length).toBe(1);
    expect(yield* find('demo.crm.client', 'hanak', otherCompanyId)).toEqual([]);
    expect(
      Schema.is(CoreSearchProjectionUnavailable)(
        yield* search
          .search(
            {
              includeArchived: false,
              moduleId: 'demo.crm',
              query: 'hanak',
              resourceType: 'demo.crm.client',
              selectedLegalEntityId: companyId,
              tenantId: otherCompanyId,
            },
            scope,
          )
          .pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      touched
        .flatMap((input) => input.relationships)
        .every((edge) => edge.relation === 'module' && edge.container.objectType === 'module_access'),
    ).toBe(true);
    expect(touched.flatMap((input) => input.relationships).length).toBe(2);
    current = {
      ...snapshot,
      companies: [
        {
          legalEntityId: companyId,
          state: {
            ...state,
            clients: {
              ...state.clients,
              contacts: [],
              items: state.clients.items.map((client) => ({ ...client, name: 'Nové železárny' })),
            },
          },
        },
      ],
      projectionVersion: '2',
    };
    yield* projector.project(context, { entityIds: ['client-1', 'contact-1'] });
    expect(yield* find('demo.crm.client', 'hanak')).toEqual([]);
    expect((yield* find('demo.crm.client', 'nove')).length).toBe(1);
    expect(yield* find('demo.crm.contact', 'jiri')).toEqual([]);
    current = { ...snapshot, companies: [], projectionVersion: '3' };
    yield* projector.project(rebuildContext, { rebuild: true });
    yield* projector.project(rebuildContext, { rebuild: true });
    current = snapshot;
    yield* projector.project(context, { entityIds: ['client-1'] });
    expect(yield* find('demo.crm.client', 'hanak')).toEqual([]);
  }),
);

it.effect('archives contacts with their client and fails a foreign snapshot before external writes', () =>
  Effect.gen(function* projectionTest() {
    const docs = yield* buildSearchDocuments({
      ...snapshot,
      companies: [
        {
          legalEntityId: companyId,
          state: {
            ...state,
            clients: {
              ...state.clients,
              items: state.clients.items.map((client) => ({ ...client, status: 'archived' as const })),
            },
          },
        },
      ],
    });
    expect(docs.every((doc) => doc.archived)).toBe(true);
    const store = makeInMemoryCoreSearchProjectionStore();
    const projector = yield* makeSearchProjection.pipe(
      Effect.provideService(SearchSource, { load: () => Effect.succeed({ ...snapshot, tenantId: otherCompanyId }) }),
      Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(ResourceContainmentRelationshipMutation, {
        touch: () => Effect.die('No foreign containment'),
      }),
    );
    expect(
      Schema.is(ReadHandlerUnavailable)(yield* projector.project(context, { entityIds: [] }).pipe(Effect.flip)),
    ).toBe(true);
  }),
);

it.effect('duplicate owner IDs across companies fail before any containment or index mutation', () =>
  Effect.gen(function* rejectDuplicateIdentity() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const projector = yield* makeSearchProjection.pipe(
      Effect.provideService(SearchSource, {
        load: () =>
          Effect.succeed({ ...snapshot, companies: [...snapshot.companies, { legalEntityId: otherCompanyId, state }] }),
      }),
      Effect.provideService(CoreSearchIngestion, { ingest: () => Effect.die('No partial duplicate ingestion') }),
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(ResourceContainmentRelationshipMutation, {
        touch: () => Effect.die('No duplicate containment'),
      }),
    );
    expect(
      Schema.is(ReadHandlerUnavailable)(
        yield* projector.project(context, { entityIds: ['client-1'] }).pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);
