import {
  CoreSearchQueryRuntime,
  CoreSearchIngestion,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchWorkerSnapshot,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { buildSearchDocuments, publishSearchSnapshot } from '../../src/services/search-projection.ts';
import { OpportunityRefSchema } from '../../shared/resources/opportunity.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';
import { loadSearch } from '../../src/services/search-read.ts';
import { searchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import { company, context, otherCompany, otherTenant, ref, scope, snapshot } from './search-fixtures.ts';

it.effect('indexes titles and technical identifiers with exact tenant, resource type and company', () =>
  Effect.gen(function* test() {
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents).toMatchObject([
      {
        archived: false,
        ref,
        searchableText: [snapshot.records[0]?.title, ref.resourceId],
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
it.effect('lifecycle update, archive, deletion and rebuild are version fenced', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const publish = (next: typeof snapshot) =>
      publishSearchSnapshot(context, next).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
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
it.effect('publishes 201 documents with zero ingests/applies and one atomic replace', () =>
  Effect.gen(function* test() {
    const records = yield* Effect.forEach(
      Array.from({ length: 201 }, (_, index) => index + 1),
      (index) =>
        Schema.decodeEffect(OpportunityRefSchema)({
          ...ref,
          resourceId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        }).pipe(
          Effect.map((recordRef) => ({ archived: false, legalEntityId: company, ref: recordRef, title: 'Nabídka' })),
        ),
    );
    const store = makeInMemoryCoreSearchProjectionStore();
    const operations: string[] = [];
    yield* publishSearchSnapshot(context, { ...snapshot, records }).pipe(
      Effect.provideService(CoreSearchIngestion, {
        ingest: () => Effect.die('Snapshot publication must not ingest individual documents'),
      }),
      Effect.provideService(CoreSearchProjectionStore, {
        ...store,
        apply: () => Effect.die('Snapshot publication must not apply individual documents'),
        replace: (replacement, claim) => {
          operations.push('replace');
          expect(claim).toBe(context);
          return store.replace(replacement, claim);
        },
      }),
    );
    expect(operations).toEqual(['replace']);
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const hits = yield* loadSearch(scope, 'nabidka').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
    expect(hits).toHaveLength(201);
  }),
);
it.effect('returns verified Core relevance v1 scores and never invents one', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* publishSearchSnapshot(context, snapshot).pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const exact = yield* loadSearch(scope, ref.resourceId).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
    expect(exact[0]?.relevance).toEqual({ score: 1000, version: '1' });
    const token = yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
    expect(token[0]?.relevance?.version).toBe('1');
    expect(token[0]?.relevance?.score).toBeGreaterThan(0);
    expect(token[0]?.relevance?.score).toBeLessThan(1000);
  }),
);
it.effect('indexes only approved owner fields, not notes, amounts or invented relationship labels', () =>
  Effect.gen(function* test() {
    const record = {
      amountMinor: 999_999,
      archived: false,
      customerLabel: 'Nepublikovaný zákazník',
      expectedCloseDate: '2027-02-28',
      legalEntityId: company,
      note: 'Tajná poznámka',
      ownerLabel: 'Nepublikovaný obchodník',
      ref,
      stage: 'PROPOSAL' as const,
      title: 'Nabídka kávy',
    };
    const documents = yield* buildSearchDocuments({ ...snapshot, records: [record] });
    expect(documents[0]?.searchableText).toEqual([
      record.title,
      ref.resourceId,
      record.expectedCloseDate,
      record.stage,
    ]);
    expect(documents[0]?.metadata).toEqual([]);
    expect(documents[0]?.aliases).toEqual([]);
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* publishSearchSnapshot(context, { ...snapshot, records: [record] }).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
    );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const query of [ref.resourceId, '2027-02-28', 'proposal', 'kavy']) {
      const hits = yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
      expect(hits).toMatchObject([{ ref, selectedLegalEntityId: company, title: record.title }]);
      expect(hits[0]?.relevance?.version).toBe('1');
      expect(hits[0]?.relevance?.score).toBeGreaterThan(0);
      expect(hits[0]?.relevance?.score).toBeLessThanOrEqual(1000);
    }
    for (const query of [record.note, record.customerLabel, record.ownerLabel, String(record.amountMinor)]) {
      expect(yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([]);
    }
  }),
);
it.effect('a replacement failure leaves the complete previous projection intact; retry succeeds', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* publishSearchSnapshot(context, snapshot).pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const next = {
      ...snapshot,
      projectionVersion: '2',
      records: [{ archived: false, legalEntityId: company, ref, title: 'Nová nabídka' }],
    };
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const unavailable = new CoreSearchProjectionUnavailable({
      code: 'core_search_projection_unavailable',
      reason: 'Injected persistence failure',
    });
    const failedReplace = yield* publishSearchSnapshot(context, next).pipe(
      Effect.provideService(CoreSearchProjectionStore, { ...store, replace: () => Effect.fail(unavailable) }),
      Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
      Effect.exit,
    );
    expect(Exit.isFailure(failedReplace)).toBe(true);
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
    expect(yield* loadSearch(scope, 'nova').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([]);
    yield* publishSearchSnapshot(context, next).pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    expect(yield* loadSearch(scope, 'nova').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toHaveLength(
      1,
    );
  }),
);
it.effect('empty replacement prunes deletions, retains the floor and ignores stale upserts and snapshots', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const publish = (next: typeof snapshot) =>
      publishSearchSnapshot(context, next).pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* publish(snapshot);
    yield* publish({ ...snapshot, projectionVersion: '3', records: [] });
    const documents = yield* buildSearchDocuments(snapshot);
    for (const document of documents) {
      yield* store.apply({ document: { ...document, projectionVersion: '2' }, kind: 'upsert' }, context);
      yield* store.apply({ document: { ...document, projectionVersion: '3' }, kind: 'upsert' }, context);
    }
    yield* publish({ ...snapshot, projectionVersion: '2' });
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    yield* publish({ ...snapshot, projectionVersion: '4' });
    yield* store.apply({ kind: 'delete', projectionVersion: '6', ref }, context);
    yield* publish({ ...snapshot, projectionVersion: '5' });
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    yield* publish({ ...snapshot, projectionVersion: '7' });
    const conflict = yield* publish({
      ...snapshot,
      projectionVersion: '7',
      records: [{ archived: false, legalEntityId: company, ref, title: 'Konflikt' }],
    }).pipe(Effect.exit);
    expect(Exit.isFailure(conflict)).toBe(true);
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
  }),
);
it.effect('rejects invalid snapshots and worker identities before replacement, including empty snapshots', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const invalidSnapshots = [
      { ...snapshot, tenantId: otherTenant },
      { ...snapshot, projectionVersion: '0', records: [] },
      {
        ...snapshot,
        records: [...snapshot.records, { archived: false, legalEntityId: otherCompany, ref, title: 'Duplicate' }],
      },
      { ...snapshot, records: [{ archived: false, legalEntityId: '', ref, title: 'Invalid company' }] },
    ];
    for (const invalid of invalidSnapshots) {
      const outcome = yield* publishSearchSnapshot(context, invalid).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.exit,
      );
      expect(Exit.isFailure(outcome)).toBe(true);
    }
    const invalidContexts = [
      { ...context, producerModuleKey: 'demo.foreign' },
      { ...context, consumerModuleKey: 'demo.foreign' },
      { ...context, workerKey: 'demo.foreign.worker' },
      { ...context, topic: 'demo.foreign.changed.v1' },
      { ...context, compositionRevision: '' },
    ];
    for (const invalid of invalidContexts) {
      const outcome = yield* publishSearchSnapshot(invalid, { ...snapshot, records: [] }).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.exit,
      );
      expect(Exit.isFailure(outcome)).toBe(true);
    }
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
