import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchIngestion,
  CoreSearchQueryRuntime,
  ResourceContainmentRelationshipMutation,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
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
import { buildSearchDocuments } from '../../src/search/projection.ts';
import type { SearchSourceSnapshot } from '../../src/search/projection.ts';
import { loadOwnerSearch } from '../../src/search/search-read.ts';
import { projectSearchSnapshot } from '../../src/services/search-projector.ts';
import { searchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';

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

it.effect('indexes lease business dates, not private notes, rent, booking references or technical IDs', () =>
  Effect.gen(function* scenario() {
    const snapshot = yield* fixture;
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents.length).toBe(1);
    expect(documents[0]?.selectedLegalEntityId).toBe(legalEntityId);
    expect(documents[0]?.title).toBe('Nájem od 1. 11. 2026 na dobu neurčitou');
    expect(documents[0]?.searchableText).toEqual(['Nájem od 1. 11. 2026 na dobu neurčitou', '2026-11-01']);
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
    ).toBe('Nájem od 1. 11. 2026 do 31. 10. 2027');
  }),
);

it.effect('refreshes updates, tombstones withdrawals/deletion, rebuilds idempotently and contains each resource', () =>
  Effect.gen(function* scenario() {
    let snapshot: SearchSourceSnapshot = yield* fixture;
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const touches: ResourceContainmentRelationshipMutationInput[] = [];
    const project = (claim: OutboxWorkerHandlerContext, rebuild: boolean) =>
      projectSearchSnapshot(snapshot, claim, rebuild).pipe(
        Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
        Effect.provideService(CoreSearchProjectionStore, store),
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
    expect((yield* search()).length).toBe(1);
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
    expect(queries[0]).toMatchObject({ selectedLegalEntityId: legalEntityId, tenantId });
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

it.effect('rejects duplicate resource identities across companies before containment or publication', () =>
  Effect.gen(function* duplicateCompanyScenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const duplicate = { ...snapshot, companies: [company, { ...company, legalEntityId: otherCompany }] };
    expect(Exit.isFailure(yield* Effect.exit(buildSearchDocuments(duplicate)))).toBe(true);
  }),
);
