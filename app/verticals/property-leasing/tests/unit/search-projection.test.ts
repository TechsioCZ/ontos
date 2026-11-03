import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  ResourceContainmentRelationshipMutation,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type {
  CoreSearchQueryRuntimeService,
  OutboxWorkerHandlerContext,
  ResourceContainmentRelationshipMutationInput,
} from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OccupancyStateSchema } from '../../shared/apis/records.ts';
import { LeasesProviderResponseSchema } from '../../shared/apis/leases-search.ts';
import { buildSearchDocuments, invalidSearchSource } from '../../src/search/projection.ts';
import type { SearchSourceSnapshot } from '../../src/search/projection.ts';
import { loadOwnerSearch } from '../../src/search/search-read.ts';
import { projectSearchSnapshot } from '../../src/services/search-projector.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherCompany = '20000000-0000-4000-8000-000000000002';
const scope = {
  authContextRef: 'job:lease-search:run:test',
  authMethod: 'system',
  correlationId: 'lease-search-test',
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const searchWithRuntime = (runtime: CoreSearchQueryRuntimeService) => (query: string) =>
  loadOwnerSearch(scope, query, 'property.leasing.occupancy').pipe(
    Effect.provideService(CoreSearchQueryRuntime, runtime),
  );
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'property.leasing',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'property.leasing',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'property.leasing.search-refresh-requested.v1',
  workerKey: 'property.leasing.refresh-search',
});
const fixture = Schema.decodeUnknownEffect(OccupancyStateSchema)({
  occupancies: [
    {
      contractRef: null,
      customerCounterpartyRef: null,
      endDate: null,
      externalBookingCorrelation: 'PRIVATE BOOKING',
      guestPartyRef: null,
      kind: 'LONG_TERM_LEASE',
      note: 'PRIVATE NOTE',
      occupancyRef: {
        moduleId: 'property.leasing',
        resourceId: '40000000-0000-4000-8000-000000000001',
        resourceType: 'property.leasing.occupancy',
        tenantId,
      },
      peopleCount: 2,
      rentTerms: { currency: 'CZK', monthlyRentMinor: 123_456, paymentDay: 10, serviceChargesMinor: 23_456 },
      startDate: '2026-11-01',
      state: 'ACTIVE',
      unitRef: {
        moduleId: 'property.portfolio',
        resourceId: '40000000-0000-4000-8000-000000000002',
        resourceType: 'property.portfolio.unit',
        tenantId,
      },
    },
  ],
}).pipe(
  Effect.map((state): SearchSourceSnapshot => ({
    companies: [{ legalEntityId, state }],
    projectionVersion: '1',
    tenantId,
  })),
);

it.effect('indexes only owner-held lease identity, lifecycle and dates, not private or foreign metadata', () =>
  Effect.gen(function* scenario() {
    const snapshot = yield* fixture;
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents.length).toBe(1);
    expect(documents[0]?.selectedLegalEntityId).toBe(legalEntityId);
    expect(documents[0]?.title).toBe(
      'Nájem od 1. 11. 2026 na dobu neurčitou · Aktivní · 40000000-0000-4000-8000-000000000001',
    );
    expect(documents[0]?.searchableText).toEqual([
      'Nájem od 1. 11. 2026 na dobu neurčitou · Aktivní · 40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'ACTIVE',
      'Aktivní',
      '2026-11-01',
    ]);
    expect(documents[0]?.searchableText.join(' ')).not.toContain('40000000-0000-4000-8000-000000000002');
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(documents)).not.toContain('PRIVATE');
    expect(documents[0]?.metadata).toEqual([]);
    expect(Exit.isFailure(yield* Effect.exit(buildSearchDocuments({ ...snapshot, tenantId: otherCompany })))).toBe(
      true,
    );
  }),
);

it.effect('excludes cancelled leases and short stays, but retains completed lease history', () =>
  Effect.gen(function* scenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    for (const occupancies of [
      company.state.occupancies.map((occupancy) => ({ ...occupancy, state: 'CANCELLED' as const })),
      company.state.occupancies.map((occupancy) => ({ ...occupancy, kind: 'SHORT_STAY' as const })),
    ]) {
      expect(
        yield* buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state: { occupancies } }] }),
      ).toEqual([]);
    }
    const completed = {
      occupancies: company.state.occupancies.map((occupancy) => ({
        ...occupancy,
        endDate: '2027-10-31',
        state: 'COMPLETED' as const,
      })),
    };
    expect(
      (yield* buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state: completed }] }))[0]?.title,
    ).toBe('Nájem od 1. 11. 2026 do 31. 10. 2027 · Ukončený · 40000000-0000-4000-8000-000000000001');
  }),
);

it.effect('refreshes updates, tombstones withdrawals/deletion, rebuilds idempotently and contains each resource', () =>
  Effect.gen(function* scenario() {
    let snapshot: SearchSourceSnapshot = yield* fixture;
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const touches: ResourceContainmentRelationshipMutationInput[] = [];
    const publications: unknown[] = [];
    const project = (claim: OutboxWorkerHandlerContext, rebuild: boolean) =>
      projectSearchSnapshot(snapshot, claim, rebuild).pipe(
        Effect.provideService(CoreSearchProjectionStore, {
          ...store,
          apply: () => Effect.fail(invalidSearchSource()),
          replace: (input, claimContext) => {
            publications.push(input);
            return store.replace(input, claimContext);
          },
        }),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: (input) =>
            Effect.sync(() => {
              touches.push(input);
            }),
        }),
      );
    const search = () =>
      loadOwnerSearch(scope, 'najem', 'property.leasing.occupancy').pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      );
    yield* project(context, false);
    expect(publications.length).toBe(1);
    expect((yield* search()).length).toBe(1);
    for (const query of ['40000000-0000-4000-8000-000000000001', '2026-11-01', 'aktivni']) {
      expect(
        (yield* loadOwnerSearch(scope, query, 'property.leasing.occupancy').pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        )).length,
      ).toBe(1);
    }
    expect(touches[0]?.relationships.length).toBe(1);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(touches)).toContain('module_access');
    expect(
      yield* loadOwnerSearch({ ...scope, legalEntityId: otherCompany }, 'najem', 'property.leasing.occupancy').pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
    expect(
      yield* loadOwnerSearch({ ...scope, tenantId: otherCompany }, 'najem', 'property.leasing.occupancy').pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
      ),
    ).toEqual([]);
    const old = snapshot;
    snapshot = {
      ...snapshot,
      companies: snapshot.companies.map((company) => ({
        ...company,
        state: {
          ...company.state,
          occupancies: company.state.occupancies.map((occupancy) => ({ ...occupancy, endDate: '2027-01-31' })),
        },
      })),
      projectionVersion: '2',
    };
    yield* project(context, false);
    expect((yield* search())[0]?.title).toContain('31. 1. 2027');
    snapshot = { ...snapshot, companies: [], projectionVersion: '3' };
    yield* project(context, false);
    snapshot = old;
    yield* project(context, false);
    expect(yield* search()).toEqual([]);
    snapshot = { ...snapshot, companies: [], projectionVersion: '4' };
    const rebuild = attestOutboxWorkerHandlerContext({
      ...context,
      topic: 'property.leasing.search-rebuild-requested.v1',
      workerKey: 'property.leasing.rebuild-search',
    });
    yield* project(rebuild, true);
    yield* project(rebuild, true);
    expect(yield* search()).toEqual([]);
  }),
);

it.effect('returns verified Core relevance v1 scores and never invents one', () =>
  Effect.gen(function* relevanceScenario() {
    const snapshot = yield* fixture;
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* projectSearchSnapshot(snapshot, context, false).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(ResourceContainmentRelationshipMutation, { touch: () => Effect.void }),
    );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const search = searchWithRuntime(runtime);
    const exact = yield* search('40000000-0000-4000-8000-000000000001');
    expect(exact[0]?.relevance).toEqual({ score: 1000, version: '1' });
    const prefix = yield* search('najem');
    expect(prefix[0]?.relevance?.version).toBe('1');
    expect(prefix[0]?.relevance?.score).toBeGreaterThan(0);
    expect(prefix[0]?.relevance?.score).toBeLessThan(1000);
  }),
);

it.effect('requires selected company and tenant in wire results and drops stale foreign-company hits', () =>
  Effect.gen(function* scenario() {
    const documents = yield* buildSearchDocuments(yield* fixture);
    const document = yield* Effect.fromNullishOr(documents[0]);
    const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
      document,
      { ...document, selectedLegalEntityId: otherCompany },
      { ...document, ref: { ...document.ref, tenantId: otherCompany } },
    ]);
    const queries: unknown[] = [];
    const runtime = {
      search: (query: Parameters<CoreSearchQueryRuntimeService['search']>[0]) => {
        queries.push(query);
        return Effect.succeed(hits);
      },
    };
    const result = yield* loadOwnerSearch(scope, 'najem', 'property.leasing.occupancy').pipe(
      Effect.provideService(CoreSearchQueryRuntime, runtime),
    );
    expect(result.length).toBe(1);
    expect(result[0]?.selectedLegalEntityId).toBe(legalEntityId);
    expect(result[0]).not.toHaveProperty('relevance');
    expect(queries[0]).toMatchObject({ includeRelevance: true, selectedLegalEntityId: legalEntityId, tenantId });
    expect(Schema.is(LeasesProviderResponseSchema)(result)).toBe(true);
    expect(Schema.is(LeasesProviderResponseSchema)([{ ref: document.ref, title: document.title }])).toBe(false);
    const { legalEntityId: _company, ...withoutCompany } = scope;
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          loadOwnerSearch(withoutCompany, 'najem', 'property.leasing.occupancy').pipe(
            Effect.provideService(CoreSearchQueryRuntime, runtime),
          ),
        ),
      ),
    ).toBe(true);
    expect(queries.length).toBe(1);
  }),
);

it.effect('distinguishes same-date leases and finds each exact owner ID without inventing relation labels', () =>
  Effect.gen(function* identityScenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const occupancy = yield* Effect.fromNullishOr(company.state.occupancies[0]);
    const secondId = '40000000-0000-4000-8000-000000000003';
    const state = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
      occupancies: [occupancy, { ...occupancy, occupancyRef: { ...occupancy.occupancyRef, resourceId: secondId } }],
    });
    const next = { ...snapshot, companies: [{ legalEntityId, state }] };
    const documents = yield* buildSearchDocuments(next);
    expect(new Set(documents.map(({ title }) => title)).size).toBe(2);
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* projectSearchSnapshot(next, context, false).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(ResourceContainmentRelationshipMutation, { touch: () => Effect.void }),
    );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const search = searchWithRuntime(runtime);
    expect((yield* search(secondId)).map(({ ref }) => ref.resourceId)).toEqual([secondId]);
    for (const query of ['PRIVATE', '123456', occupancy.unitRef.resourceId, 'Praha']) {
      expect(yield* search(query)).toEqual([]);
    }
    yield* projectSearchSnapshot(
      {
        ...next,
        companies: [
          {
            legalEntityId,
            state: { occupancies: state.occupancies.map((lease) => ({ ...lease, state: 'CANCELLED' as const })) },
          },
        ],
        projectionVersion: '2',
      },
      context,
      false,
    ).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(ResourceContainmentRelationshipMutation, { touch: () => Effect.void }),
    );
    expect(yield* search(secondId)).toEqual([]);
  }),
);

it.effect('preserves Core relevance order after excluding wrong-company, wrong-type and archived hits', () =>
  Effect.gen(function* orderingScenario() {
    const documents = yield* buildSearchDocuments(yield* fixture);
    const document = yield* Effect.fromNullishOr(documents[0]);
    const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
      { ...document, title: 'Zvolený nájem' },
      { ...document, selectedLegalEntityId: otherCompany, title: 'Cizí společnost' },
      { ...document, archived: true, title: 'Archivovaný nájem' },
      { ...document, ref: { ...document.ref, resourceType: 'property.leasing.other' }, title: 'Nesprávný typ' },
      { ...document, ref: { ...document.ref, moduleId: 'other.owner' }, title: 'Nesprávný modul' },
      { ...document, title: 'Abecedně první' },
    ]);
    const result = yield* loadOwnerSearch(scope, 'najem', 'property.leasing.occupancy').pipe(
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
    );
    expect(result.map(({ title }) => title)).toEqual(['Zvolený nájem', 'Abecedně první']);
    expect(result[0]).not.toHaveProperty('relevance');
  }),
);

it.effect('rejects malformed or duplicate company snapshots even when no live lease would be published', () =>
  Effect.gen(function* emptySnapshotScenario() {
    const snapshot = yield* fixture;
    for (const invalid of [
      { ...snapshot, companies: [], projectionVersion: '0' },
      { ...snapshot, companies: [], tenantId: 'not-a-tenant' },
      { ...snapshot, companies: [{ legalEntityId: 'not-a-company', state: { occupancies: [] } }] },
      {
        ...snapshot,
        companies: [
          { legalEntityId, state: { occupancies: [] } },
          { legalEntityId, state: { occupancies: [] } },
        ],
      },
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(buildSearchDocuments(invalid)))).toBe(true);
    }
  }),
);

it.effect('does not publish any replacement when resource containment is unavailable', () =>
  Effect.gen(function* containmentScenario() {
    const snapshot = yield* fixture;
    const store = makeInMemoryCoreSearchProjectionStore();
    let replacements = 0;
    const exit = yield* Effect.exit(
      projectSearchSnapshot(snapshot, context, false).pipe(
        Effect.provideService(CoreSearchProjectionStore, {
          ...store,
          replace: () => {
            replacements += 1;
            return Effect.void;
          },
        }),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: () => Effect.die('unavailable containment'),
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(replacements).toBe(0);
  }),
);

it.effect('rejects duplicate resource identities across companies before containment or publication', () =>
  Effect.gen(function* duplicateCompanyScenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const duplicate = { ...snapshot, companies: [company, { ...company, legalEntityId: otherCompany }] };
    expect(Exit.isFailure(yield* Effect.exit(buildSearchDocuments(duplicate)))).toBe(true);
  }),
);
