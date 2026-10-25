import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';

import { defineCoreSearchIngestionRegistrations } from '../../src/search/ingestion-registry.ts';
import { makeCoreSearchIngestion } from '../../src/search/ingestion.ts';
import {
  CoreSearchProjectionStore,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const searchScope = (scopeTenantId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:core-search-test',
    authMethod: 'session',
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId: scopeTenantId,
  }),
  correlationId: 'core-search-test',
});
const workerContext = (overrides: Partial<OutboxWorkerHandlerContext> = {}): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: '50000000-0000-4000-8000-000000000001',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'example.records',
    deliveryId: '50000000-0000-4000-8000-000000000002',
    domainEventId: '50000000-0000-4000-8000-000000000003',
    legalEntityScope: 'forbidden',
    messageId: '50000000-0000-4000-8000-000000000004',
    producerModuleKey: 'example.records',
    tenantId,
    tenantSequenceNo: 1n,
    topic: 'example.records.party-updated.v1',
    workerKey: 'example.records.project-party-updated-to-search',
    ...overrides,
  });
const ref = {
  moduleId: 'example.records',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'example.records.record',
  tenantId,
} as const;

const document = (projectionVersion: string, title: string) => ({
  archived: false,
  facets: [],
  metadata: [],
  projectionVersion,
  ref,
  searchableText: [title],
  title,
});

const observation = (projectionVersion: string, title: string) => ({
  consumerModuleKey: 'example.records',
  mutation: { document: document(projectionVersion, title), kind: 'upsert' },
  producerModuleKey: 'example.records',
  projectionVersion,
  tenantId,
  topic: 'example.records.party-updated.v1',
  workerKey: 'example.records.project-party-updated-to-search',
});

const registrations = defineCoreSearchIngestionRegistrations(
  ['party-created', 'party-updated', 'official-identifier-added', 'official-identifier-updated'].map((event) => ({
    consumerModuleKey: 'example.records',
    producerModuleKey: 'example.records',
    topic: `example.records.${event}.v1`,
    workerKey: `example.records.project-${event}-to-search`,
  })),
);

it('freezes the registrations a producing module declares', () => {
  expect(registrations.map(({ topic }) => topic)).toEqual([
    'example.records.party-created.v1',
    'example.records.party-updated.v1',
    'example.records.official-identifier-added.v1',
    'example.records.official-identifier-updated.v1',
  ]);
  expect(Object.isFrozen(registrations)).toBe(true);
  expect(registrations.every((registration) => Object.isFrozen(registration))).toBe(true);
});

it.effect('ingestion rejects caller-created contexts and trusted claims with mismatching ownership', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store, registrations);
  const contexts = [
    { ...workerContext() },
    workerContext({ compositionRevision: 'not-a-release' }),
    workerContext({ tenantId: '10000000-0000-4000-8000-000000000002' }),
    workerContext({ producerModuleKey: 'foreign.module' }),
    workerContext({ consumerModuleKey: 'foreign.module' }),
    workerContext({ topic: 'example.records.party-created.v1' }),
    workerContext({ workerKey: 'example.records.project-party-created-to-search' }),
  ];
  return Effect.gen(function* rejectInvalidIngestionContexts() {
    for (const context of contexts) {
      const failure = yield* Effect.flip(ingestion.ingest(observation('1', 'Party'), context));
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    }
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(
      yield* runtime.search(
        {
          includeArchived: false,
          moduleId: ref.moduleId,
          query: 'party',
          resourceType: ref.resourceType,
          tenantId,
        },
        searchScope(tenantId),
      ),
    ).toEqual([]);
  });
});

it.effect('ingests duplicate and out-of-order post-commit observations idempotently', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store, registrations);

  return Effect.gen(function* ingestObservationsIdempotently() {
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* ingestion.ingest(observation('2', 'Current title'), workerContext());
    yield* ingestion.ingest(observation('2', 'Current title'), workerContext());
    yield* ingestion.ingest(observation('1', 'Stale title'), workerContext());

    const hits = yield* runtime.search(
      {
        includeArchived: false,
        moduleId: 'example.records',
        query: 'current',
        resourceType: 'example.records.record',
        tenantId,
      },
      searchScope(tenantId),
    );
    expect(hits.map(({ title }) => title)).toEqual(['Current title']);
  });
});

it.effect('identifier updates accept only their generated self-consumer worker', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store, registrations);
  const update = {
    ...observation('3', 'Updated identifier projection'),
    topic: 'example.records.official-identifier-updated.v1',
    workerKey: 'example.records.project-official-identifier-updated-to-search',
  };
  return Effect.gen(function* acceptOnlyGeneratedWorker() {
    yield* ingestion.ingest(update, workerContext({ topic: update.topic, workerKey: update.workerKey }));
    yield* ingestion.ingest(update, workerContext({ topic: update.topic, workerKey: update.workerKey }));
    const denied = yield* Effect.flip(
      ingestion.ingest(
        {
          ...update,
          workerKey: 'example.records.project-official-identifier-added-to-search',
        },
        workerContext({ topic: update.topic, workerKey: update.workerKey }),
      ),
    );
    expect(Predicate.isTagged(denied, 'CoreSearchProjectionInvalid')).toBe(true);
  });
});

it.effect('rejects undeclared topics and sequence/document identity mismatches', () => {
  const ingestion = makeCoreSearchIngestion(makeInMemoryCoreSearchProjectionStore(), registrations);
  const invalidObservations = [
    { ...observation('1', 'Party'), topic: 'example.records.undeclared.v1' },
    { ...observation('1', 'Party'), producerModuleKey: 'foreign.module' },
    {
      ...observation('1', 'Party'),
      workerKey: 'example.records.project-party-created-to-search',
    },
    { ...observation('1', 'Party'), projectionVersion: '2' },
    {
      ...observation('1', 'Party'),
      mutation: {
        document: {
          ...document('1', 'Party'),
          ref: { ...ref, moduleId: 'foreign.module' },
        },
        kind: 'upsert',
      },
    },
  ];
  return Effect.gen(function* testInvalidObservations() {
    const failures = yield* Effect.forEach(
      invalidObservations,
      (invalidObservation) => Effect.flip(ingestion.ingest(invalidObservation, workerContext())),
      { concurrency: 'unbounded' },
    );
    for (const failure of failures) {
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    }
  });
});
