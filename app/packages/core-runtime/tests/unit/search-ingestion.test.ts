// @effect-diagnostics asyncFunction:off
/* eslint-disable no-await-in-loop -- Each invalid observation is evaluated independently against one store. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  CORE_SEARCH_INGESTION_REGISTRATIONS,
  CORE_SEARCH_PARTY_LIFECYCLE_TOPICS,
  makeCoreSearchIngestion,
} from '../../src/search/ingestion.ts';
import {
  makeCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
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

test('declares one immutable Core registration for every closed Party lifecycle topic', () => {
  assert.deepEqual(
    CORE_SEARCH_INGESTION_REGISTRATIONS.map(({ topic }) => topic),
    CORE_SEARCH_PARTY_LIFECYCLE_TOPICS,
  );
  assert.equal(Object.isFrozen(CORE_SEARCH_INGESTION_REGISTRATIONS), true);
  assert.equal(
    CORE_SEARCH_INGESTION_REGISTRATIONS.every(
      (registration) =>
        Object.isFrozen(registration) &&
        registration.consumerModuleKey === 'party.registry' &&
        registration.producerModuleKey === 'party.registry',
    ),
    true,
  );
});

test('ingests duplicate and out-of-order post-commit observations idempotently', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store);
  const runtime = makeCoreSearchQueryRuntime(store);

  await Effect.runPromise(ingestion.ingest(observation('2', 'Current title')));
  await Effect.runPromise(ingestion.ingest(observation('2', 'Current title')));
  await Effect.runPromise(ingestion.ingest(observation('1', 'Stale title')));

  const hits = await Effect.runPromise(
    runtime.search({
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'current',
      resourceType: 'party.registry.party',
      tenantId,
    }),
  );
  assert.deepEqual(
    hits.map(({ title }) => title),
    ['Current title'],
  );
});

test('identifier updates accept only their generated self-consumer worker', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const ingestion = makeCoreSearchIngestion(store);
  const update = {
    ...observation('3', 'Updated identifier projection'),
    topic: 'party.registry.official-identifier-updated.v1',
    workerKey: 'party.registry.project-official-identifier-updated-to-search',
  };
  await Effect.runPromise(ingestion.ingest(update));
  await Effect.runPromise(ingestion.ingest(update));
  const denied = await Effect.runPromise(
    Effect.flip(
      ingestion.ingest({
        ...update,
        workerKey: 'party.registry.project-official-identifier-added-to-search',
      }),
    ),
  );
  assert.equal(denied._tag, 'CoreSearchProjectionInvalid');
});

test('rejects undeclared topics and sequence/document identity mismatches', async () => {
  const ingestion = makeCoreSearchIngestion(makeInMemoryCoreSearchProjectionStore());
  for (const invalid of [
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
  ]) {
    const failure = await Effect.runPromise(Effect.flip(ingestion.ingest(invalid)));
    assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
  }
});
