import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';

import {
  CORE_SEARCH_INGESTION_REGISTRATIONS,
  CORE_SEARCH_PARTY_LIFECYCLE_TOPICS,
  makeCoreSearchIngestion,
} from '../../src/search/ingestion.ts';
import {
  CoreSearchProjectionStore,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const workerContext = (overrides: Partial<OutboxWorkerHandlerContext> = {}): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: '50000000-0000-4000-8000-000000000001',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'party.registry',
    deliveryId: '50000000-0000-4000-8000-000000000002',
    domainEventId: '50000000-0000-4000-8000-000000000003',
    legalEntityScope: 'forbidden',
    messageId: '50000000-0000-4000-8000-000000000004',
    producerModuleKey: 'party.registry',
    tenantId,
    tenantSequenceNo: 1n,
    topic: 'party.registry.party-updated.v1',
    workerKey: 'party.registry.project-party-updated-to-search',
    ...overrides,
  });
const ref = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
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
  consumerModuleKey: 'party.registry',
  mutation: { document: document(projectionVersion, title), kind: 'upsert' },
  producerModuleKey: 'party.registry',
  projectionVersion,
  tenantId,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
});

it('declares one immutable Core registration for every closed Party lifecycle topic', () => {
  expect(CORE_SEARCH_INGESTION_REGISTRATIONS.map(({ topic }) => topic)).toEqual(CORE_SEARCH_PARTY_LIFECYCLE_TOPICS);
  expect(Object.isFrozen(CORE_SEARCH_INGESTION_REGISTRATIONS)).toBe(true);
  expect(
    CORE_SEARCH_INGESTION_REGISTRATIONS.every(
      (registration) =>
        Object.isFrozen(registration) &&
        registration.consumerModuleKey === 'party.registry' &&
        registration.producerModuleKey === 'party.registry',
    ),
  ).toBe(true);
});

it.effect('ingestion rejects caller-created contexts and trusted claims with mismatching ownership', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store);
  const contexts = [
    { ...workerContext() },
    workerContext({ compositionRevision: 'not-a-release' }),
    workerContext({ tenantId: '10000000-0000-4000-8000-000000000002' }),
    workerContext({ producerModuleKey: 'foreign.module' }),
    workerContext({ consumerModuleKey: 'foreign.module' }),
    workerContext({ topic: 'party.registry.party-created.v1' }),
    workerContext({ workerKey: 'party.registry.project-party-created-to-search' }),
  ];
  return Effect.gen(function* rejectInvalidIngestionContexts() {
    for (const context of contexts) {
      const failure = yield* Effect.flip(ingestion.ingest(observation('1', 'Party'), context));
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    }
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(
      yield* runtime.search({
        includeArchived: false,
        moduleId: ref.moduleId,
        query: 'party',
        resourceType: ref.resourceType,
        tenantId,
      }),
    ).toEqual([]);
  });
});

it.effect('ingests duplicate and out-of-order post-commit observations idempotently', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store);

  return Effect.gen(function* ingestObservationsIdempotently() {
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* ingestion.ingest(observation('2', 'Current title'), workerContext());
    yield* ingestion.ingest(observation('2', 'Current title'), workerContext());
    yield* ingestion.ingest(observation('1', 'Stale title'), workerContext());

    const hits = yield* runtime.search({
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'current',
      resourceType: 'party.registry.party',
      tenantId,
    });
    expect(hits.map(({ title }) => title)).toEqual(['Current title']);
  });
});

it.effect('identifier updates accept only their generated self-consumer worker', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store);
  const update = {
    ...observation('3', 'Updated identifier projection'),
    topic: 'party.registry.official-identifier-updated.v1',
    workerKey: 'party.registry.project-official-identifier-updated-to-search',
  };
  return Effect.gen(function* acceptOnlyGeneratedWorker() {
    yield* ingestion.ingest(update, workerContext({ topic: update.topic, workerKey: update.workerKey }));
    yield* ingestion.ingest(update, workerContext({ topic: update.topic, workerKey: update.workerKey }));
    const denied = yield* Effect.flip(
      ingestion.ingest(
        {
          ...update,
          workerKey: 'party.registry.project-official-identifier-added-to-search',
        },
        workerContext({ topic: update.topic, workerKey: update.workerKey }),
      ),
    );
    expect(Predicate.isTagged(denied, 'CoreSearchProjectionInvalid')).toBe(true);
  });
});

it.effect('rejects undeclared topics and sequence/document identity mismatches', () => {
  const ingestion = makeCoreSearchIngestion(makeInMemoryCoreSearchProjectionStore());
  const invalidObservations = [
    { ...observation('1', 'Party'), topic: 'party.registry.undeclared.v1' },
    { ...observation('1', 'Party'), producerModuleKey: 'foreign.module' },
    {
      ...observation('1', 'Party'),
      workerKey: 'party.registry.project-party-created-to-search',
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
