import {
  CoreSearchQueryRuntime,
  CoreSearchIngestion,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchWorkerSnapshot,
  ResourceContainmentMutationUnavailable,
  ResourceContainmentRelationshipMutation,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionStoreService, ResourceContainmentRelationshipMutationInput } from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { buildSearchDocuments, publishSearchSnapshot } from '../../src/services/search-projection.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';
import type { SearchSnapshot } from '../../src/services/search-source.ts';
import { CalendarDateSchema, ProjectIdSchema } from '../../shared/apis/records.ts';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import { loadSearch } from '../../src/services/search-read.ts';
import { searchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import { company, context, otherCompany, otherTenant, ref, scope, snapshot } from './search-fixtures.ts';

it.effect('indexes only approved task evidence with exact tenant, resource type and company', () =>
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

const taskRef = (id: string) => Schema.decodeSync(TaskRefSchema)({ ...ref, resourceId: id });
const publishWithStore = (store: CoreSearchProjectionStoreService, next: SearchSnapshot) =>
  publishSearchSnapshot(context, next).pipe(
    Effect.provideService(CoreSearchProjectionStore, store),
    Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
    Effect.provideService(ResourceContainmentRelationshipMutation, { touch: () => Effect.void }),
  );
const publicationFailure = () =>
  new CoreSearchProjectionUnavailable({
    code: 'core_search_projection_unavailable',
    reason: 'Test publication failure',
  });
const containmentFailure = () => new ResourceContainmentMutationUnavailable({ reason: 'Test containment failure' });

it.effect('finds actual task identifiers, owner ID, local project ID, due date and approved enum text', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const dueDate = yield* Schema.decodeEffect(CalendarDateSchema)('2026-11-04');
    const projectId = yield* Schema.decodeEffect(ProjectIdSchema)('task-project-42');
    const next: SearchSnapshot = {
      ...snapshot,
      records: [
        {
          archived: false,
          dueDate,
          legalEntityId: company,
          ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId },
          priority: 'HIGH',
          projectId,
          ref,
          state: 'IN_PROGRESS',
          title: 'Příprava kanceláře',
        },
      ],
    };
    yield* publishWithStore(store, next);
    for (const [query, score] of [
      ['priprava', 800],
      [ref.resourceId, 1000],
      [scope.principalId, 100],
      [projectId, 100],
      [dueDate, 100],
      ['IN_PROGRESS', 100],
      ['HIGH', 100],
    ] as const) {
      const hits = yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
      expect(hits).toEqual([
        { ref, relevance: { score, version: '1' }, selectedLegalEntityId: company, title: 'Příprava kanceláře' },
      ]);
    }
    for (const query of ['fabricated-customer', 'fabricated-assignee']) {
      expect(yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([]);
    }
    const foreign = yield* buildSearchDocuments({
      ...next,
      records: next.records.map((record) => ({
        ...record,
        ownerPrincipalRef: { principalId: scope.principalId, tenantId: otherTenant },
      })),
    }).pipe(Effect.exit);
    expect(Exit.isFailure(foreign)).toBe(true);
  }),
);

it.effect('performs zero individual ingests/applies and one complete replacement for zero, one and 205 tasks', () =>
  Effect.gen(function* test() {
    for (const count of [0, 1, 205]) {
      const backing = makeInMemoryCoreSearchProjectionStore();
      let applies = 0;
      let ingests = 0;
      let replacements = 0;
      const order: string[] = [];
      const batches: ResourceContainmentRelationshipMutationInput[] = [];
      const store: CoreSearchProjectionStoreService = {
        ...backing,
        apply: (input, claim) =>
          Effect.sync(() => {
            applies += 1;
          }).pipe(Effect.andThen(backing.apply(input, claim))),
        replace: (input, claim) =>
          Effect.sync(() => {
            replacements += 1;
            order.push('replace');
          }).pipe(Effect.andThen(backing.replace(input, claim))),
      };
      const ingestion = makeCoreSearchIngestion(store, searchIngestionRegistrations);
      const next: SearchSnapshot = {
        ...snapshot,
        records: Array.from({ length: count }, (_, index) => ({
          archived: false,
          legalEntityId: index % 2 === 0 ? company : otherCompany,
          ref: taskRef(`task-${index}`),
          title: `Úkol ${index}`,
        })),
      };
      yield* publishSearchSnapshot(context, next).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(CoreSearchIngestion, {
          ingest: (input, claim) =>
            Effect.sync(() => {
              ingests += 1;
            }).pipe(Effect.andThen(ingestion.ingest(input, claim))),
        }),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: (batch) =>
            Effect.sync(() => {
              batches.push(batch);
              order.push('containment');
            }),
        }),
      );
      expect({ applies, ingests, replacements }).toEqual({ applies: 0, ingests: 0, replacements: 1 });
      let expectedBatchSizes: readonly number[] = [];
      if (count === 1) {
        expectedBatchSizes = [1];
      } else if (count > 1) {
        expectedBatchSizes = [100, 100, 5];
      }
      expect(batches.map((batch) => batch.relationships.length)).toEqual(expectedBatchSizes);
      expect(order).toEqual([...batches.map(() => 'containment'), 'replace']);
      expect(batches.flatMap((batch) => batch.relationships)).toHaveLength(count);
      expect(batches.every((batch) => batch.relationships.every((edge) => edge.relation === 'module'))).toBe(true);
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      expect(
        yield* loadSearch(scope, 'ukol').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
      ).toHaveLength(Math.ceil(count / 2));
      expect(
        yield* loadSearch({ ...scope, legalEntityId: otherCompany }, 'ukol').pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
        ),
      ).toHaveLength(Math.floor(count / 2));
    }
  }),
);

it.effect('a failed replacement leaves the entire old generation searchable and retry publishes all changes', () =>
  Effect.gen(function* test() {
    const backing = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, backing));
    yield* publishWithStore(backing, snapshot);
    const next: SearchSnapshot = {
      ...snapshot,
      projectionVersion: '2',
      records: [
        { archived: false, legalEntityId: company, ref, title: 'Změněný úkol' },
        { archived: false, legalEntityId: company, ref: taskRef('new-task'), title: 'Přidaný úkol' },
      ],
    };
    const failing: CoreSearchProjectionStoreService = { ...backing, replace: () => Effect.fail(publicationFailure()) };
    const failed = yield* publishWithStore(failing, next).pipe(Effect.exit);
    expect(Exit.isFailure(failed)).toBe(true);
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
    for (const query of ['zmeneny', 'pridany']) {
      expect(yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([]);
    }
    yield* publishWithStore(backing, next);
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    for (const query of ['zmeneny', 'pridany']) {
      expect(yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toHaveLength(
        1,
      );
    }
  }),
);

it.effect('containment failure never publishes, and a retry repairs containment before replacing', () =>
  Effect.gen(function* test() {
    const backing = makeInMemoryCoreSearchProjectionStore();
    yield* publishWithStore(backing, snapshot);
    let replacements = 0;
    let touches = 0;
    const store: CoreSearchProjectionStoreService = {
      ...backing,
      replace: (input, claim) =>
        Effect.sync(() => {
          replacements += 1;
        }).pipe(Effect.andThen(backing.replace(input, claim))),
    };
    const next: SearchSnapshot = {
      ...snapshot,
      projectionVersion: '2',
      records: Array.from({ length: 101 }, (_, index) => ({
        archived: false,
        legalEntityId: company,
        ref: taskRef(`replacement-${index}`),
        title: `Nový úkol ${index}`,
      })),
    };
    const failed = yield* publishSearchSnapshot(context, next).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, searchIngestionRegistrations)),
      Effect.provideService(ResourceContainmentRelationshipMutation, {
        touch: () =>
          Effect.sync(() => {
            touches += 1;
          }).pipe(
            Effect.andThen(Effect.suspend(() => (touches === 2 ? Effect.fail(containmentFailure()) : Effect.void))),
          ),
      }),
      Effect.exit,
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect({ replacements, touches }).toEqual({ replacements: 0, touches: 2 });
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, backing));
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
    expect(yield* loadSearch(scope, 'novy').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([]);
    yield* publishWithStore(store, next);
    expect(replacements).toBe(1);
    expect(yield* loadSearch(scope, 'novy').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toHaveLength(
      101,
    );
  }),
);

it.effect('equal-generation conflicts are atomic; empty rebuilds fence stale snapshots and unseen late upserts', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    yield* publishWithStore(store, snapshot);
    yield* publishWithStore(store, snapshot);
    const conflict = yield* publishWithStore(store, {
      ...snapshot,
      records: [{ archived: false, legalEntityId: company, ref, title: 'Konflikt' }],
    }).pipe(Effect.exit);
    expect(Exit.isFailure(conflict)).toBe(true);
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
    yield* publishWithStore(store, { ...snapshot, projectionVersion: '3', records: [] });
    yield* publishWithStore(store, snapshot);
    const staleDocuments = yield* buildSearchDocuments({
      ...snapshot,
      projectionVersion: '2',
      records: [{ archived: false, legalEntityId: company, ref: taskRef('late-task'), title: 'Opožděný úkol' }],
    });
    for (const document of staleDocuments) {
      yield* store.apply({ document, kind: 'upsert' }, context);
    }
    expect(yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    expect(yield* loadSearch(scope, 'opozdeny').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
      [],
    );
    yield* publishWithStore(store, { ...snapshot, projectionVersion: '4' });
    expect(
      yield* loadSearch(scope, 'cerstva').pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
    ).toHaveLength(1);
  }),
);

it.effect('rejects unregistered or unattested claims and oversized snapshots before external mutation', () =>
  Effect.gen(function* test() {
    let mutations = 0;
    const backing = makeInMemoryCoreSearchProjectionStore();
    const store: CoreSearchProjectionStoreService = {
      ...backing,
      replace: (input, claim) =>
        Effect.sync(() => {
          mutations += 1;
        }).pipe(Effect.andThen(backing.replace(input, claim))),
    };
    const oversized: SearchSnapshot = {
      ...snapshot,
      records: Array.from({ length: 10_001 }, (_, index) => ({
        archived: false,
        legalEntityId: company,
        ref: taskRef(`oversized-${index}`),
        title: 'Úkol',
      })),
    };
    const scenarios = [
      { claim: { ...context }, next: snapshot },
      { claim: attestOutboxWorkerHandlerContext({ ...context, workerKey: 'work.tasks.other-search' }), next: snapshot },
      { claim: attestOutboxWorkerHandlerContext({ ...context, consumerModuleKey: 'foreign.module' }), next: snapshot },
      { claim: attestOutboxWorkerHandlerContext({ ...context, producerModuleKey: 'foreign.module' }), next: snapshot },
      { claim: attestOutboxWorkerHandlerContext({ ...context, compositionRevision: 'invalid' }), next: snapshot },
      { claim: context, next: { ...snapshot, tenantId: otherTenant } },
      { claim: context, next: oversized },
    ];
    const mutatingContainment = {
      touch: () =>
        Effect.sync(() => {
          mutations += 1;
        }),
    };
    for (const { claim, next } of scenarios) {
      const result = yield* publishSearchSnapshot(claim, next).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(ResourceContainmentRelationshipMutation, mutatingContainment),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
    expect(mutations).toBe(0);
  }),
);
