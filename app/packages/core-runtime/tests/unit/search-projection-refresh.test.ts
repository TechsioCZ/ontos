import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionDependentQuerySchema,
  CoreSearchProjectionStore,
  CoreSearchQuerySchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';
import type {
  CoreSearchLabelDependencySchema,
  CoreSearchProjectionMutationSchema,
} from '../../src/search/projection.ts';
import {
  coreSearchDocumentBodyText,
  coreSearchDocumentPayload,
  decodeCoreSearchDocumentRow,
  makePostgresCoreSearchProjectionStore,
} from '../../src/search/persistence.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const selectedLegalEntityId = '20000000-0000-4000-8000-000000000001';
const moduleId = 'demo.tasks';
const sourceRef = {
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party.registry.party',
  tenantId,
};
const context = (overrides: Partial<OutboxWorkerHandlerContext> = {}) =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'claim-1',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: moduleId,
    deliveryId: 'delivery-1',
    domainEventId: 'event-1',
    legalEntityScope: 'forbidden',
    messageId: 'message-1',
    producerModuleKey: sourceRef.moduleId,
    tenantId,
    tenantSequenceNo: 1n,
    topic: 'party.registry.party-updated.v1',
    workerKey: 'demo.tasks.refresh-party-labels',
    ...overrides,
  });
const document = (
  resourceId: string,
  projectionVersion = '1',
  searchableText: readonly string[] = ['Approved label'],
) =>
  Schema.decodeSync(CoreSearchProjectionDocumentSchema)({
    archived: false,
    facets: [],
    labelDependencies: [{ ref: sourceRef, selectedLegalEntityId, sourceRevision: '9007199254740993' }],
    metadata: [],
    projectionVersion,
    ref: { moduleId, resourceId, resourceType: 'demo.tasks.task', tenantId },
    searchableText,
    selectedLegalEntityId,
    title: `Task ${resourceId}`,
  });
const dependentQuery = Schema.decodeSync(CoreSearchProjectionDependentQuerySchema)({
  moduleId,
  selectedLegalEntityId,
  sourceRef,
  tenantId,
});
type LabelDependencyFixture = Omit<typeof CoreSearchLabelDependencySchema.Encoded, 'sourceRevision'> & {
  readonly sourceRevision: string | number;
};
type ProjectionDocumentFixture = Omit<typeof CoreSearchProjectionDocumentSchema.Encoded, 'labelDependencies'> & {
  readonly labelDependencies?: readonly LabelDependencyFixture[];
};
type ProjectionMutationFixture =
  | { readonly document: ProjectionDocumentFixture; readonly kind: 'upsert' }
  | Extract<typeof CoreSearchProjectionMutationSchema.Encoded, { readonly kind: 'delete' }>;

const batch = (mutations: readonly ProjectionMutationFixture[]) => ({ moduleId, mutations, tenantId });
const upsert = (value: ProjectionDocumentFixture): ProjectionMutationFixture => ({ document: value, kind: 'upsert' });
const withdrawal = (value: ReturnType<typeof document>, projectionVersion: string): ProjectionMutationFixture => ({
  kind: 'delete',
  projectionVersion,
  ref: value.ref,
});
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:search-refresh',
    authMethod: 'session',
    legalEntityId: selectedLegalEntityId,
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  correlationId: 'search-refresh',
};
const query = Schema.decodeSync(CoreSearchQuerySchema)({
  includeArchived: false,
  moduleId,
  query: 'approved',
  resourceType: 'demo.tasks.task',
  selectedLegalEntityId,
  tenantId,
});

it.effect('atomic owner refresh replays, ignores older observations and retains withdrawal tombstones', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const first = document('one');
  const second = document('two');
  return Effect.gen(function* replayAndWithdraw() {
    const original = batch([upsert(first), upsert(second)]);
    yield* store.applyBatch(original, context());
    yield* store.applyBatch(original, context());
    yield* store.applyBatch(batch([upsert(document('one', '2', ['Renamed label']))]), context());
    yield* store.applyBatch(original, context());
    expect(
      (yield* store.queryCandidates(query, scope)).find((value) => value.ref.resourceId === 'one')?.searchableText,
    ).toEqual(['Renamed label']);
    const withdrawn = batch([withdrawal(first, '3'), withdrawal(second, '3')]);
    yield* store.applyBatch(withdrawn, context());
    yield* store.applyBatch(withdrawn, context());
    yield* store.applyBatch(original, context());
    expect(yield* store.queryCandidates(query, scope)).toEqual([]);
    expect(yield* store.queryDependents(dependentQuery, context())).toEqual([]);
    const conflict = yield* Effect.flip(store.applyBatch(batch([upsert(document('one', '3'))]), context()));
    expect(Predicate.isTagged(conflict, 'CoreSearchProjectionInvalid')).toBe(true);
    expect(yield* store.queryCandidates(query, scope)).toEqual([]);
  });
});

it.effect(
  'a withdrawal keeps source ordering evidence and an older label cannot return under a newer target generation',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    return Effect.gen(function* retainSourceWithdrawalRevision() {
      yield* store.applyBatch(batch([upsert(document('one'))]), context());
      const withdrawn = {
        ...document('one', '2', []),
        labelDependencies: [{ ref: sourceRef, selectedLegalEntityId, sourceRevision: '9007199254740994' }],
      };
      yield* store.applyBatch(batch([upsert(withdrawn)]), context());
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      expect(yield* runtime.search(query, scope)).toEqual([]);
      expect((yield* store.queryDependents(dependentQuery, context())).length).toBe(1);
      const failure = yield* Effect.flip(
        store.applyBatch(batch([upsert(document('two')), upsert(document('one', '3'))]), context()),
      );
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
      const expectedWithdrawn = yield* Schema.decodeUnknownEffect(CoreSearchProjectionDocumentSchema)(withdrawn);
      expect(yield* store.queryDependents(dependentQuery, context())).toEqual([expectedWithdrawn]);
      expect(yield* runtime.search(query, scope)).toEqual([]);
    });
  },
);

it.effect('a late batch conflict rolls back earlier upserts, withdrawals and reverse dependencies', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* rejectPartialRefresh() {
    yield* store.applyBatch(batch([upsert(document('one')), upsert(document('two'))]), context());
    const failure = yield* Effect.flip(
      store.applyBatch(
        batch([
          withdrawal(document('one'), '2'),
          upsert(document('three')),
          upsert(document('two', '1', ['Conflicting label'])),
        ]),
        context(),
      ),
    );
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    expect((yield* store.queryDependents(dependentQuery, context())).map((value) => value.ref.resourceId)).toEqual([
      'one',
      'two',
    ]);
    expect((yield* store.queryCandidates(query, scope)).map((value) => value.ref.resourceId)).toEqual(['one', 'two']);
  });
});

it.effect('refresh replaces dependency edges without retiring omitted documents or advancing rebuild floors', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* replaceDependencyEdges() {
    yield* store.applyBatch(batch([upsert(document('one')), upsert(document('two'))]), context());
    const nextSource = { ...sourceRef, resourceId: 'party-2' };
    const moved = {
      ...document('one', '2'),
      labelDependencies: [
        {
          ref: nextSource,
          selectedLegalEntityId,
          sourceRevision: '7',
        },
      ],
    };
    yield* store.applyBatch(batch([upsert(moved)]), context());
    expect((yield* store.queryDependents(dependentQuery, context())).map((value) => value.ref.resourceId)).toEqual([
      'two',
    ]);
    expect(
      (yield* store.queryDependents({ ...dependentQuery, sourceRef: nextSource }, context())).map(
        (value) => value.ref.resourceId,
      ),
    ).toEqual(['one']);
    // A new resource at the older version remains admissible: batching is not a replacement floor.
    yield* store.applyBatch(batch([upsert(document('three'))]), context());
    expect((yield* store.queryCandidates(query, scope)).length).toBe(3);
    yield* store.replace(
      {
        documents: [],
        moduleId,
        rebuildVersion: '4',
        resourceType: 'demo.tasks.task',
        tenantId,
      },
      context({ producerModuleKey: moduleId }),
    );
    yield* store.applyBatch(batch([upsert(document('unseen', '3'))]), context());
    expect(yield* store.queryCandidates(query, scope)).toEqual([]);
  });
});

it.effect(
  'consumer refresh does not authorize a source producer, forged claim, foreign tenant or public dependency read',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    return Effect.gen(function* rejectForeignAuthority() {
      for (const claim of [
        { ...context() },
        context({ consumerModuleKey: sourceRef.moduleId }),
        context({ tenantId: '10000000-0000-4000-8000-000000000002' }),
        context({ compositionRevision: 'invalid' }),
      ]) {
        expect(
          Predicate.isTagged(
            yield* Effect.flip(store.applyBatch(batch([upsert(document('one'))]), claim)),
            'CoreSearchProjectionInvalid',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(store.queryDependents(dependentQuery, claim)),
            'CoreSearchProjectionInvalid',
          ),
        ).toBe(true);
      }
      // Existing producer-authorized ingestion remains unchanged and cannot refresh foreign documents.
      expect(
        Predicate.isTagged(
          yield* Effect.flip(store.apply(upsert(document('one')), context())),
          'CoreSearchProjectionInvalid',
        ),
      ).toBe(true);
      expect(yield* store.queryCandidates(query, scope)).toEqual([]);
    });
  },
);

it.effect(
  'dependency and batch validation reject ambiguous identities and cross-company evidence before changes',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    const value = document('one');
    const { selectedLegalEntityId: fixtureCompany, ...withoutCompany } = value;
    const dependency = {
      ref: sourceRef,
      selectedLegalEntityId: fixtureCompany ?? selectedLegalEntityId,
      sourceRevision: '9007199254740993',
    };
    const unsafeNumericRevision = Number.MAX_SAFE_INTEGER + 1;
    return Effect.gen(function* rejectInvalidDependencies() {
      for (const input of [
        batch([]),
        batch([upsert(value), upsert(value)]),
        batch([upsert({ ...value, labelDependencies: [dependency, dependency] })]),
        batch([upsert(withoutCompany)]),
        batch([upsert({ ...value, labelDependencies: [{ ...dependency, sourceRevision: '01' }] })]),
        batch([upsert({ ...value, labelDependencies: [{ ...dependency, sourceRevision: unsafeNumericRevision }] })]),
        batch([
          upsert({
            ...value,
            labelDependencies: [{ ...dependency, selectedLegalEntityId: '20000000-0000-4000-8000-000000000002' }],
          }),
        ]),
        batch([
          upsert({
            ...value,
            labelDependencies: [
              { ...dependency, ref: { ...sourceRef, tenantId: '10000000-0000-4000-8000-000000000002' } },
            ],
          }),
        ]),
      ]) {
        expect(
          Predicate.isTagged(yield* Effect.flip(store.applyBatch(input, context())), 'CoreSearchProjectionInvalid'),
        ).toBe(true);
      }
      expect(yield* store.queryDependents(dependentQuery, context())).toEqual([]);
    });
  },
);

it.effect('canonical dependency keys distinguish owner/type/company and never enter public hits or matching', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* isolateCanonicalDependencies() {
    yield* store.applyBatch(batch([upsert(document('one'))]), context());
    for (const source of [
      { ...dependentQuery.sourceRef, moduleId: 'other.owner' },
      { ...dependentQuery.sourceRef, resourceType: 'party.registry.counterparty' },
      { ...dependentQuery.sourceRef, resourceId: 'party-2' },
    ]) {
      expect(yield* store.queryDependents({ ...dependentQuery, sourceRef: source }, context())).toEqual([]);
    }
    expect(
      yield* store.queryDependents(
        {
          ...dependentQuery,
          selectedLegalEntityId: '20000000-0000-4000-8000-000000000002',
        },
        context(),
      ),
    ).toEqual([]);
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const hits = yield* runtime.search(query, scope);
    expect(hits.length).toBe(1);
    expect(Object.hasOwn(hits[0] ?? {}, 'labelDependencies')).toBe(false);
    expect(yield* runtime.search({ ...query, query: '9007199254740993' }, scope)).toEqual([]);
  });
});

it('persisted dependencies round-trip exact bigint revision provenance without contributing to text', () => {
  const value = document('one');
  const payload = coreSearchDocumentPayload(value);
  const bodyText = Result.getOrThrow(coreSearchDocumentBodyText(value));
  expect(bodyText).not.toContain('9007199254740993');
  const decoded = Result.getOrThrow(
    decodeCoreSearchDocumentRow({
      bodyText,
      facetsJson: payload,
      legalEntityId: selectedLegalEntityId,
      projectionVersion: 1n,
      sourceModuleKey: moduleId,
      sourceResourceId: 'one',
      sourceResourceType: 'demo.tasks.task',
      tenantId,
      title: value.title,
    }),
  );
  expect(decoded).toEqual(value);
  expect(decoded.labelDependencies?.[0]?.sourceRevision).toBe('9007199254740993');
});

it.effect('Postgres refresh takes one release-fenced transaction and rolls back on a late conflict', () =>
  Effect.gen(function* rollbackNativeRefresh() {
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('"core"."search_index_entries"') && statement.startsWith('select')) {
        // First target is absent, second target has an equal-version tombstone: its upsert conflicts.
        return Effect.succeed(
          statements.filter((sql) => sql.startsWith('select') && sql.includes('"core"."search_index_entries"'))
            .length === 1
            ? []
            : [
                // Explicit driver-column order survives object-key sorting. The scripted PgClient
                // converts this positional row with Object.values, just like its object fixtures.
                [
                  // searchIndexEntryId
                  '60000000-0000-4000-8000-000000000001',
                  tenantId,
                  // legalEntityId
                  null,
                  moduleId,
                  'demo.tasks.task',
                  'two',
                  // title
                  '',
                  // bodyText
                  '',
                  // searchTextV1
                  null,
                  // searchFormatVersion
                  null,
                  // searchSourceVersion
                  null,
                  // deleted
                  true,
                  { schemaVersion: '2' },
                  // projectionVersion
                  '1',
                  // createdAt
                  '2026-11-04T00:00:00Z',
                  // updatedAt
                  '2026-11-04T00:00:00Z',
                ],
              ],
        );
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const failure = yield* Effect.flip(
      store.applyBatch(batch([upsert(document('one')), upsert(document('two'))]), context()),
    );
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    expect(statements.filter((statement) => statement.includes('pg_advisory_xact_lock_shared')).length).toBe(1);
    expect(
      statements.filter((statement) => statement.startsWith('insert into "core"."search_index_entries"')).length,
    ).toBe(1);
    expect(statements.filter((statement) => /^rollback$/iu.test(statement)).length).toBe(1);
    expect(statements.some((statement) => /^commit$/iu.test(statement))).toBe(false);
  }),
);

const labelRefreshOpen = (sourceRevision = '1') => ({
  legalEntityId: selectedLegalEntityId,
  moduleId,
  sourceRef,
  sourceRevision,
  tenantId,
});

/** A dependent whose recorded owner source revision is small, so the job revision is exactly the observation. */
const dependentDocument = (resourceId: string, projectionVersion = '1', sourceRevision = '1') => ({
  archived: false,
  facets: [],
  labelDependencies: [{ ref: sourceRef, selectedLegalEntityId, sourceRevision }],
  metadata: [],
  projectionVersion,
  ref: { moduleId, resourceId, resourceType: 'demo.tasks.task', tenantId },
  searchableText: ['Approved label'],
  selectedLegalEntityId,
  title: `Task ${resourceId}`,
});

it.effect(
  'durable label refresh pages dependents, commits each page with its cursor and finishes through a resweep',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    return Effect.gen(function* durableLabelRefresh() {
      yield* store.applyBatch(
        batch([upsert(dependentDocument('one')), upsert(dependentDocument('two')), upsert(dependentDocument('three'))]),
        context(),
      );
      const opened = yield* store.openLabelRefresh(labelRefreshOpen(), context());
      expect(opened).toMatchObject({
        casVersion: '1',
        cursor: Option.none(),
        epoch: '1',
        sourceRevision: '1',
        state: 'sweeping',
        sweepCursor: Option.none(),
      });

      const first = yield* store.readLabelRefreshPage({ job: opened, limit: 2 }, context());
      expect(first.documents.map((value) => value.ref.resourceId)).toEqual(['one', 'three']);
      expect(first.hasMore).toBe(true);
      const afterFirst = yield* store.commitLabelRefreshPage(
        {
          job: opened,
          mutations: first.documents.map((value) => upsert(dependentDocument(value.ref.resourceId, '2'))),
          pageEnd: first.pageEnd,
        },
        context(),
      );
      expect(afterFirst).toMatchObject({ cursor: first.pageEnd, state: 'sweeping' });
      expect((yield* store.queryCandidates(query, scope)).map((value) => value.projectionVersion)).toEqual([
        '2',
        '1',
        '2',
      ]);

      const second = yield* store.readLabelRefreshPage({ job: afterFirst, limit: 2 }, context());
      expect(second.documents.map((value) => value.ref.resourceId)).toEqual(['two']);
      expect(second.hasMore).toBe(false);
      const afterSecond = yield* store.commitLabelRefreshPage(
        {
          job: afterFirst,
          mutations: second.documents.map((value) => upsert(dependentDocument(value.ref.resourceId, '2'))),
          pageEnd: second.pageEnd,
        },
        context(),
      );
      expect(afterSecond.state).toBe('sweeping');
      const drained = yield* store.readLabelRefreshPage({ job: afterSecond, limit: 2 }, context());
      expect(drained.documents).toEqual([]);
      expect(Option.isNone(drained.pageEnd)).toBe(true);

      const resweeping = yield* store.commitLabelRefreshPage(
        { job: afterSecond, mutations: [], pageEnd: Option.none() },
        context(),
      );
      expect(resweeping.state).toBe('resweep');
      const resweep = yield* store.readLabelRefreshPage({ job: resweeping, limit: 2 }, context());
      expect(resweep.documents.map((value) => value.ref.resourceId)).toEqual(['one', 'three']);
      const afterResweep = yield* store.commitLabelRefreshPage(
        { job: resweeping, mutations: [], pageEnd: resweep.pageEnd },
        context(),
      );
      expect(afterResweep.state).toBe('resweep');
      const resweepTail = yield* store.readLabelRefreshPage({ job: afterResweep, limit: 2 }, context());
      expect(resweepTail.documents.map((value) => value.ref.resourceId)).toEqual(['two']);
      const afterResweepTail = yield* store.commitLabelRefreshPage(
        { job: afterResweep, mutations: [], pageEnd: resweepTail.pageEnd },
        context(),
      );
      expect(
        Option.isNone((yield* store.readLabelRefreshPage({ job: afterResweepTail, limit: 2 }, context())).pageEnd),
      ).toBe(true);
      const completed = yield* store.commitLabelRefreshPage(
        { job: afterResweepTail, mutations: [], pageEnd: Option.none() },
        context(),
      );
      expect(completed.state).toBe('complete');
      const terminalWork = yield* Effect.flip(
        store.commitLabelRefreshPage(
          { job: completed, mutations: [upsert(dependentDocument('one', '3'))], pageEnd: Option.none() },
          context(),
        ),
      );
      expect(Predicate.isTagged(terminalWork, 'CoreSearchProjectionInvalid')).toBe(true);
    });
  },
);

it.effect('a newer source revision supersedes an older in-flight label refresh token', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* supersedeLabelRefreshToken() {
    yield* store.applyBatch(batch([upsert(dependentDocument('one'))]), context());
    const first = yield* store.openLabelRefresh(labelRefreshOpen('1'), context());
    const second = yield* store.openLabelRefresh(labelRefreshOpen('2'), context());
    expect(BigInt(second.epoch)).toBe(BigInt(first.epoch) + 1n);
    expect(second).toMatchObject({
      cursor: Option.none(),
      sourceRevision: '2',
      state: 'sweeping',
      sweepCursor: Option.none(),
    });
    // Resuming an unchanged revision is idempotent and keeps the same token.
    expect(yield* store.openLabelRefresh(labelRefreshOpen('2'), context())).toEqual(second);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          store.commitLabelRefreshPage({ job: first, mutations: [], pageEnd: Option.none() }, context()),
        ),
        'CoreSearchProjectionInvalid',
      ),
    ).toBe(true);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(store.readLabelRefreshPage({ job: first, limit: 2 }, context())),
        'CoreSearchProjectionInvalid',
      ),
    ).toBe(true);
  });
});

it.effect('retains the source-revision barrier after the dependent target and its edge are deleted', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* retainBarrierAfterDeletion() {
    yield* store.applyBatch(batch([upsert(document('one'))]), context());
    yield* store.applyBatch(batch([withdrawal(document('one'), '2')]), context());
    expect(yield* store.queryDependents(dependentQuery, context())).toEqual([]);
    const rollback = yield* Effect.flip(
      store.applyBatch(
        batch([
          upsert({
            ...document('one', '3'),
            labelDependencies: [{ ref: sourceRef, selectedLegalEntityId, sourceRevision: '5' }],
          }),
        ]),
        context(),
      ),
    );
    expect(Predicate.isTagged(rollback, 'CoreSearchProjectionInvalid')).toBe(true);
    expect(yield* store.queryCandidates(query, scope)).toEqual([]);
  });
});

it.effect('a relation inserted behind the committed cursor is still refreshed by the final resweep', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* resweepCatchesLateRelation() {
    yield* store.applyBatch(batch([upsert(dependentDocument('b')), upsert(dependentDocument('d'))]), context());
    const opened = yield* store.openLabelRefresh(labelRefreshOpen(), context());
    const first = yield* store.readLabelRefreshPage({ job: opened, limit: 1 }, context());
    expect(first.documents.map((value) => value.ref.resourceId)).toEqual(['b']);
    const afterFirst = yield* store.commitLabelRefreshPage(
      { job: opened, mutations: [], pageEnd: first.pageEnd },
      context(),
    );
    // A new dependent appears behind the committed cursor and cannot be seen by the forward sweep.
    yield* store.applyBatch(batch([upsert(dependentDocument('a'))]), context());
    const second = yield* store.readLabelRefreshPage({ job: afterFirst, limit: 1 }, context());
    expect(second.documents.map((value) => value.ref.resourceId)).toEqual(['d']);
    const afterSecond = yield* store.commitLabelRefreshPage(
      { job: afterFirst, mutations: [], pageEnd: second.pageEnd },
      context(),
    );
    expect(Option.isNone((yield* store.readLabelRefreshPage({ job: afterSecond, limit: 1 }, context())).pageEnd)).toBe(
      true,
    );
    const resweeping = yield* store.commitLabelRefreshPage(
      { job: afterSecond, mutations: [], pageEnd: Option.none() },
      context(),
    );
    expect(resweeping.state).toBe('resweep');
    const resweep = yield* store.readLabelRefreshPage({ job: resweeping, limit: 1 }, context());
    expect(resweep.documents.map((value) => value.ref.resourceId)).toEqual(['a']);
    const afterResweep = yield* store.commitLabelRefreshPage(
      { job: resweeping, mutations: [upsert(dependentDocument('a', '2'))], pageEnd: resweep.pageEnd },
      context(),
    );
    // The relation inserted behind the forward cursor is refreshed by the resweep.
    expect(
      (yield* store.queryCandidates(query, scope)).find((value) => value.ref.resourceId === 'a')?.projectionVersion,
    ).toBe('2');
    const resweepTail = yield* store.readLabelRefreshPage({ job: afterResweep, limit: 1 }, context());
    expect(resweepTail.documents.map((value) => value.ref.resourceId)).toEqual(['b']);
  });
});

it.effect('stamp repair reports its keyset continuation without touching lifecycle versions or payload', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* stampRepairContinuation() {
    yield* store.applyBatch(batch([upsert(document('one')), upsert(document('two'))]), context());
    const repaired = yield* store.repairDerivedRepresentation(
      { moduleId, resourceType: 'demo.tasks.task', tenantId },
      context(),
    );
    expect(repaired).toMatchObject({ complete: true, cursor: Option.none(), repaired: 0, resweep: false, scanned: 2 });
    expect((yield* store.queryCandidates(query, scope)).map((value) => value.projectionVersion)).toEqual(['1', '1']);
    const resweep = yield* store.repairDerivedRepresentation(
      { moduleId, resourceType: 'demo.tasks.task', resweep: true, tenantId },
      context(),
    );
    expect(resweep.resweep).toBe(true);
    const paged = yield* store.repairDerivedRepresentation(
      { limit: 1, moduleId, resourceType: 'demo.tasks.task', tenantId },
      context(),
    );
    expect(paged).toMatchObject({ complete: false, scanned: 1 });
    expect(Option.isSome(paged.cursor)).toBe(true);
  });
});

it.effect('stamp repair replaces only derived evidence under a locked compare-and-set row', () =>
  Effect.gen(function* stampRepairPostgres() {
    const statements: string[] = [];
    const payload = {
      archived: false,
      facets: [],
      labelDependencies: [{ ref: sourceRef, selectedLegalEntityId, sourceRevision: '9007199254740993' }],
      metadata: [],
      schemaVersion: '2',
      searchableText: ['Approved label'],
    };
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.startsWith('select') && statement.includes('"core"."search_index_entries"')) {
        return Effect.succeed([
          [
            '60000000-0000-4000-8000-000000000001',
            tenantId,
            selectedLegalEntityId,
            moduleId,
            'demo.tasks.task',
            'one',
            'Task one',
            'task one\napproved label',
            null,
            null,
            null,
            false,
            payload,
            '1',
            '2026-11-04T00:00:00Z',
            '2026-11-04T00:00:00Z',
          ],
        ]);
      }
      if (statement.startsWith('update "core"."search_index_entries"')) {
        return Effect.succeed([{ search_index_entry_id: '60000000-0000-4000-8000-000000000001' }]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const result = yield* store.repairDerivedRepresentation(
      { moduleId, resourceType: 'demo.tasks.task', tenantId },
      context(),
    );
    expect(result).toMatchObject({ complete: true, cursor: Option.none(), repaired: 1, resweep: false, scanned: 1 });
    const repairSelects = statements.filter(
      (statement) => statement.startsWith('select') && statement.includes('"core"."search_index_entries"'),
    );
    expect(repairSelects.length).toBe(1);
    expect(repairSelects[0] ?? '').toContain('for update');
    const updates = statements.filter((statement) => statement.startsWith('update "core"."search_index_entries"'));
    expect(updates.length).toBe(1);
    const update = updates[0] ?? '';
    const setClause =
      /^update "core"\."search_index_entries" set (?<set>.*?) where /u.exec(update)?.groups?.['set'] ?? '';
    const whereClause = / where (?<where>.*)$/u.exec(update)?.groups?.['where'] ?? '';
    // Exactly the three derived columns are written; lifecycle version, payload, tombstone, title and
    // company scope never appear in the SET clause.
    expect(
      setClause
        .split(', ')
        .map((assignment) => assignment.split(' = ')[0])
        .toSorted((left, right) => (left ?? '').localeCompare(right ?? '')),
    ).toEqual(['"search_format_version"', '"search_source_version"', '"search_text_v1"']);
    expect(setClause).not.toContain('"projection_version"');
    expect(setClause).not.toContain('"facets_json"');
    expect(setClause).not.toContain('"deleted"');
    expect(setClause).not.toContain('"body_text"');
    expect(setClause).not.toContain('"title"');
    expect(setClause).not.toContain('"legal_entity_id"');
    // The concurrency guard is a compare-and-set on the exact persisted lifecycle version in WHERE.
    expect(whereClause).toContain('"search_index_entry_id"');
    expect(whereClause).toContain('"projection_version"');
    expect(statements.filter((statement) => /^commit$/iu.test(statement)).length).toBe(1);
    expect(statements.filter((statement) => /^rollback$/iu.test(statement)).length).toBe(0);
  }),
);

const repairOpen = { moduleId, resourceType: 'demo.tasks.task', tenantId };

it.effect('durable stamp repair resumes from its persisted cursor and completes through a resweep', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* durableDerivedRepair() {
    yield* store.applyBatch(batch([upsert(document('a')), upsert(document('b')), upsert(document('c'))]), context());
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    expect(opened).toMatchObject({
      casVersion: '1',
      cursor: Option.none(),
      epoch: '1',
      state: 'sweeping',
      sweepCursor: Option.none(),
    });
    // Restart: opening again resumes the exact persisted token instead of restarting the sweep.
    expect(yield* store.openDerivedRepairJob(repairOpen, context())).toEqual(opened);

    const preview = yield* store.readDerivedRepairPage({ job: opened, limit: 2 }, context());
    expect(preview.resourceIds).toEqual(['a', 'b']);
    expect(preview.hasMore).toBe(true);
    const first = yield* store.commitDerivedRepairPage({ job: opened, limit: 2 }, context());
    expect(first).toMatchObject({ scanned: 2 });
    expect(first.job).toMatchObject({ cursor: preview.pageEnd, state: 'sweeping' });

    const second = yield* store.commitDerivedRepairPage({ job: first.job, limit: 2 }, context());
    expect(second.scanned).toBe(1);
    expect(second.job.state).toBe('sweeping');
    const drained = yield* store.commitDerivedRepairPage({ job: second.job, limit: 2 }, context());
    expect(drained).toMatchObject({ scanned: 0 });
    expect(drained.job.state).toBe('resweep');
    expect(Option.isNone(drained.job.sweepCursor)).toBe(true);

    const resweepFirst = yield* store.commitDerivedRepairPage({ job: drained.job, limit: 2 }, context());
    expect(resweepFirst.scanned).toBe(2);
    expect(resweepFirst.job.state).toBe('resweep');
    const resweepSecond = yield* store.commitDerivedRepairPage({ job: resweepFirst.job, limit: 2 }, context());
    expect(resweepSecond.scanned).toBe(1);
    const resweepDrained = yield* store.commitDerivedRepairPage({ job: resweepSecond.job, limit: 2 }, context());
    expect(resweepDrained.scanned).toBe(0);
    expect(resweepDrained.job.state).toBe('complete');
    // A completed job is terminal and idempotent.
    const terminal = yield* store.commitDerivedRepairPage({ job: resweepDrained.job, limit: 2 }, context());
    expect(terminal).toMatchObject({ repaired: 0, scanned: 0 });
    expect(terminal.job).toEqual(resweepDrained.job);
  });
});

it.effect('a stale stamp-repair token is rejected without advancing the job', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* rejectStaleRepairToken() {
    yield* store.applyBatch(batch([upsert(document('a'))]), context());
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    const advanced = yield* store.commitDerivedRepairPage({ job: opened, limit: 1 }, context());
    const staleCas = yield* Effect.flip(store.commitDerivedRepairPage({ job: opened, limit: 1 }, context()));
    expect(Predicate.isTagged(staleCas, 'CoreSearchProjectionInvalid')).toBe(true);
    const staleEpoch = yield* Effect.flip(
      store.commitDerivedRepairPage({ job: { ...advanced.job, epoch: '9' }, limit: 1 }, context()),
    );
    expect(Predicate.isTagged(staleEpoch, 'CoreSearchProjectionInvalid')).toBe(true);
    const staleRead = yield* Effect.flip(store.readDerivedRepairPage({ job: opened, limit: 1 }, context()));
    expect(Predicate.isTagged(staleRead, 'CoreSearchProjectionInvalid')).toBe(true);
    // The rejected attempts left the persisted token exactly where the successful commit put it.
    expect(yield* store.readDerivedRepairPage({ job: advanced.job, limit: 1 }, context())).toMatchObject({
      resourceIds: [],
    });
  });
});

it.effect('a completed stamp-repair generation is only re-swept by an explicit restart, never by a plain open', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* restartCompletedRepair() {
    yield* store.applyBatch(batch([upsert(document('a')), upsert(document('b'))]), context());
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    // Drain the initial campaign through its resweep to completion.
    const first = yield* store.commitDerivedRepairPage({ job: opened, limit: 10 }, context());
    const drained = yield* store.commitDerivedRepairPage({ job: first.job, limit: 10 }, context());
    const resweep = yield* store.commitDerivedRepairPage({ job: drained.job, limit: 10 }, context());
    const resweepDrained = yield* store.commitDerivedRepairPage({ job: resweep.job, limit: 10 }, context());
    const completed = yield* store.commitDerivedRepairPage({ job: resweepDrained.job, limit: 10 }, context());
    expect(completed.job.state).toBe('complete');
    // An ordinary open resumes the completed generation byte-for-byte and never restarts it.
    expect(yield* store.openDerivedRepairJob(repairOpen, context())).toEqual(completed.job);
    // A row damaged after completion sits behind the finished cursor and needs a new campaign.
    yield* store.applyBatch(batch([upsert(document('c'))]), context());
    const generation = { casVersion: completed.job.casVersion, epoch: completed.job.epoch };
    const restarted = yield* store.openDerivedRepairJob({ ...repairOpen, expectedGeneration: generation }, context());
    expect(BigInt(restarted.epoch)).toBe(BigInt(completed.job.epoch) + 1n);
    expect(BigInt(restarted.casVersion)).toBe(BigInt(completed.job.casVersion) + 1n);
    expect(restarted).toMatchObject({ cursor: Option.none(), state: 'sweeping', sweepCursor: Option.none() });
    // The new campaign re-walks the whole unit, including the row the completed sweep never saw.
    const preview = yield* store.readDerivedRepairPage({ job: restarted, limit: 10 }, context());
    expect(preview.resourceIds).toEqual(['a', 'b', 'c']);
  });
});

it.effect('a duplicate stamp-repair restart is idempotent while a mismatched generation is rejected', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* replaySafeRestart() {
    yield* store.applyBatch(batch([upsert(document('a')), upsert(document('b'))]), context());
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    const generation = { casVersion: opened.casVersion, epoch: opened.epoch };
    const restarted = yield* store.openDerivedRepairJob({ ...repairOpen, expectedGeneration: generation }, context());
    expect(restarted).toMatchObject({
      casVersion: '2',
      cursor: Option.none(),
      epoch: '2',
      state: 'sweeping',
      sweepCursor: Option.none(),
    });
    // Replaying the identical restart returns the campaign it already created without advancing again.
    expect(yield* store.openDerivedRepairJob({ ...repairOpen, expectedGeneration: generation }, context())).toEqual(
      restarted,
    );
    const advanced = yield* store.commitDerivedRepairPage({ job: restarted, limit: 10 }, context());
    expect(advanced.job).toMatchObject({ casVersion: '3', epoch: '2' });
    // A delayed duplicate still returns the live campaign and never resets its committed cursor.
    expect(yield* store.openDerivedRepairJob({ ...repairOpen, expectedGeneration: generation }, context())).toEqual(
      advanced.job,
    );
    // A restart computed from a stale CAS of the live generation is rejected, not applied.
    const staleCas = yield* Effect.flip(
      store.openDerivedRepairJob(
        { ...repairOpen, expectedGeneration: { casVersion: '1', epoch: advanced.job.epoch } },
        context(),
      ),
    );
    expect(Predicate.isTagged(staleCas, 'CoreSearchProjectionInvalid')).toBe(true);
    // A restart naming a generation newer than the durable one is likewise stale.
    const staleNewer = yield* Effect.flip(
      store.openDerivedRepairJob({ ...repairOpen, expectedGeneration: { casVersion: '9', epoch: '9' } }, context()),
    );
    expect(Predicate.isTagged(staleNewer, 'CoreSearchProjectionInvalid')).toBe(true);
    // The rejected requests left the live generation and its committed cursor untouched.
    expect(yield* store.readDerivedRepairPage({ job: advanced.job, limit: 10 }, context())).toMatchObject({
      resourceIds: [],
    });
  });
});

it.effect('a restart supersedes the previous generation token for both read and commit', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* restartSupersedesOldToken() {
    yield* store.applyBatch(batch([upsert(document('a'))]), context());
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    const restarted = yield* store.openDerivedRepairJob(
      { ...repairOpen, expectedGeneration: { casVersion: opened.casVersion, epoch: opened.epoch } },
      context(),
    );
    const staleRead = yield* Effect.flip(store.readDerivedRepairPage({ job: opened, limit: 1 }, context()));
    expect(Predicate.isTagged(staleRead, 'CoreSearchProjectionInvalid')).toBe(true);
    const staleCommit = yield* Effect.flip(store.commitDerivedRepairPage({ job: opened, limit: 1 }, context()));
    expect(Predicate.isTagged(staleCommit, 'CoreSearchProjectionInvalid')).toBe(true);
    // The new campaign is still at its fresh first page, so the rejected commit wrote nothing.
    expect(yield* store.readDerivedRepairPage({ job: restarted, limit: 1 }, context())).toMatchObject({
      resourceIds: ['a'],
    });
  });
});

it.effect('a row inserted behind the repair cursor is still repaired by the resweep', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* repairResweepCatchesLateRow() {
    yield* store.applyBatch(batch([upsert(document('b')), upsert(document('d'))]), context());
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    const first = yield* store.commitDerivedRepairPage({ job: opened, limit: 1 }, context());
    expect(first.scanned).toBe(1);
    // A dependent appears behind the committed cursor and cannot be seen by the forward sweep.
    yield* store.applyBatch(batch([upsert(document('a'))]), context());
    const forward = yield* store.readDerivedRepairPage({ job: first.job, limit: 1 }, context());
    expect(forward.resourceIds).toEqual(['d']);
    const second = yield* store.commitDerivedRepairPage({ job: first.job, limit: 1 }, context());
    expect(second.scanned).toBe(1);
    const drained = yield* store.commitDerivedRepairPage({ job: second.job, limit: 1 }, context());
    expect(drained.job.state).toBe('resweep');
    const resweep = yield* store.readDerivedRepairPage({ job: drained.job, limit: 1 }, context());
    expect(resweep.resourceIds).toEqual(['a']);
    const resweepCommit = yield* store.commitDerivedRepairPage({ job: drained.job, limit: 1 }, context());
    expect(resweepCommit.scanned).toBe(1);
  });
});

it.effect('stamp repair never changes a persisted document, its lifecycle version or its payload', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  return Effect.gen(function* repairKeepsLifecycle() {
    yield* store.applyBatch(batch([upsert(document('a', '7')), upsert(document('b', '7'))]), context());
    const before = yield* store.queryDependents(dependentQuery, context());
    const beforeCandidates = yield* store.queryCandidates(query, scope);
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    const committed = yield* store.commitDerivedRepairPage({ job: opened, limit: 10 }, context());
    expect(committed).toMatchObject({ repaired: 0, scanned: 2 });
    expect(yield* store.queryDependents(dependentQuery, context())).toEqual(before);
    expect(yield* store.queryCandidates(query, scope)).toEqual(beforeCandidates);
    expect((yield* store.queryCandidates(query, scope)).map((value) => value.projectionVersion)).toEqual(['7', '7']);
  });
});

it.effect('Postgres stamp repair commits repaired stamps and its durable cursor in one transaction', () =>
  Effect.gen(function* durableRepairPostgres() {
    const statements: string[] = [];
    const payload = {
      archived: false,
      facets: [],
      labelDependencies: [{ ref: sourceRef, selectedLegalEntityId, sourceRevision: '9007199254740993' }],
      metadata: [],
      schemaVersion: '2',
      searchableText: [],
    };
    // search_index_entries columns in table order.
    const indexRow = [
      '60000000-0000-4000-8000-000000000001',
      tenantId,
      selectedLegalEntityId,
      moduleId,
      'demo.tasks.task',
      'one',
      'Task one',
      'task one',
      null,
      null,
      null,
      false,
      payload,
      '1',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    // search_derived_repair_jobs columns in table order.
    const jobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '1',
      '1',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const advancedJobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '1',
      '2',
      '["demo.tasks.task","one"]',
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([jobRow]);
      }
      if (statement.startsWith('select') && statement.includes('"core"."search_index_entries"')) {
        return Effect.succeed([indexRow]);
      }
      if (statement.startsWith('update "core"."search_index_entries"')) {
        return Effect.succeed([{ search_index_entry_id: '60000000-0000-4000-8000-000000000001' }]);
      }
      if (statement.startsWith('update "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([advancedJobRow]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const opened = yield* store.openDerivedRepairJob(repairOpen, context());
    expect(opened).toMatchObject({ casVersion: '1', epoch: '1', state: 'sweeping' });
    const progress = yield* store.commitDerivedRepairPage({ job: opened, limit: 10 }, context());
    expect(progress).toMatchObject({ repaired: 1, scanned: 1 });
    expect(progress.job).toMatchObject({
      casVersion: '2',
      cursor: Option.some('["demo.tasks.task","one"]'),
      state: 'sweeping',
    });

    const stampUpdates = statements.filter((statement) => statement.startsWith('update "core"."search_index_entries"'));
    expect(stampUpdates.length).toBe(1);
    const stampUpdate = stampUpdates[0] ?? '';
    const stampSet = /set (?<set>.*?) where /u.exec(stampUpdate)?.groups?.['set'] ?? '';
    expect(
      stampSet
        .split(', ')
        .map((assignment) => assignment.split(' = ')[0])
        .toSorted((left, right) => (left ?? '').localeCompare(right ?? '')),
    ).toEqual(['"search_format_version"', '"search_source_version"', '"search_text_v1"']);
    expect(stampSet).not.toContain('"projection_version"');
    expect(stampSet).not.toContain('"facets_json"');
    expect(stampSet).not.toContain('"deleted"');
    expect(/ where (?<where>.*)$/u.exec(stampUpdate)?.groups?.['where'] ?? '').toContain('"projection_version"');

    const jobUpdates = statements.filter((statement) =>
      statement.startsWith('update "core"."search_derived_repair_jobs"'),
    );
    expect(jobUpdates.length).toBe(1);
    const jobSet = /set (?<set>.*?) where /u.exec(jobUpdates[0] ?? '')?.groups?.['set'] ?? '';
    expect(jobSet).toContain('"cas_version"');
    expect(jobSet).toContain('"cursor"');
    expect(jobSet).toContain('"state"');
    expect(jobSet).toContain('"sweep_cursor"');
    // The repair job never rewrites its generation or identity.
    expect(jobSet).not.toContain('"epoch"');
    expect(jobSet).not.toContain('"source_module_key"');
    expect(jobSet).not.toContain('"source_resource_type"');
    // Two fenced operations (open, then one committed page). The stamp update and the durable cursor
    // update are in the same transaction and are committed together, with no rollback.
    const stampIndex = statements.findIndex((statement) =>
      statement.startsWith('update "core"."search_index_entries"'),
    );
    const jobIndex = statements.findIndex((statement) =>
      statement.startsWith('update "core"."search_derived_repair_jobs"'),
    );
    const commitAfterJob = statements.findIndex((statement, index) => index > jobIndex && /^commit$/iu.test(statement));
    expect(stampIndex).toBeGreaterThan(-1);
    expect(jobIndex).toBeGreaterThan(stampIndex);
    expect(commitAfterJob).toBeGreaterThan(jobIndex);
    expect(statements.filter((statement) => /^commit$/iu.test(statement)).length).toBe(2);
    expect(statements.filter((statement) => /^rollback$/iu.test(statement)).length).toBe(0);
  }),
);

it.effect('Postgres stamp repair rejects a stale CAS token before writing anything', () =>
  Effect.gen(function* staleRepairPostgres() {
    const statements: string[] = [];
    // The persisted job has already advanced to cas_version 2.
    const jobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '1',
      '2',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([jobRow]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const staleJob = {
      casVersion: '1',
      cursor: Option.none(),
      epoch: '1',
      moduleId,
      resourceType: 'demo.tasks.task',
      state: 'sweeping' as const,
      sweepCursor: Option.none(),
      tenantId,
    };
    const failure = yield* Effect.flip(store.commitDerivedRepairPage({ job: staleJob, limit: 10 }, context()));
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    expect(statements.some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(false);
    expect(statements.filter((statement) => /^rollback$/iu.test(statement)).length).toBe(1);
  }),
);

it.effect('Postgres stamp repair restart advances the generation under a compare-and-set predicate', () =>
  Effect.gen(function* restartRepairPostgres() {
    const statements: string[] = [];
    const jobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '1',
      '1',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const restartedRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '2',
      '2',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([jobRow]);
      }
      if (statement.startsWith('update "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([restartedRow]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const restarted = yield* store.openDerivedRepairJob(
      { ...repairOpen, expectedGeneration: { casVersion: '1', epoch: '1' } },
      context(),
    );
    expect(restarted).toMatchObject({ casVersion: '2', cursor: Option.none(), epoch: '2', state: 'sweeping' });
    const updates = statements.filter((statement) =>
      statement.startsWith('update "core"."search_derived_repair_jobs"'),
    );
    expect(updates.length).toBe(1);
    const set = /set (?<set>.*?) where /u.exec(updates[0] ?? '')?.groups?.['set'] ?? '';
    expect(set).toContain('"cas_version"');
    expect(set).toContain('"cursor"');
    expect(set).toContain('"epoch"');
    expect(set).toContain('"state"');
    expect(set).toContain('"sweep_cursor"');
    // The compare-and-set predicate names the exact generation the caller observed.
    const where = / where (?<where>.*)$/u.exec(updates[0] ?? '')?.groups?.['where'] ?? '';
    expect(where).toContain('"epoch"');
    expect(where).toContain('"cas_version"');
    // Restart never touches index rows, their lifecycle or their derived stamps.
    expect(statements.some((statement) => statement.startsWith('update "core"."search_index_entries"'))).toBe(false);
    expect(statements.some((statement) => /^(?:insert|delete) /u.test(statement))).toBe(false);
  }),
);

it.effect('Postgres stamp repair rejects a stale restart and leaves the generation untouched', () =>
  Effect.gen(function* staleRestartPostgres() {
    const statements: string[] = [];
    // The live generation progressed to cas_version 5 without a restart.
    const jobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '1',
      '5',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([jobRow]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const failure = yield* Effect.flip(
      store.openDerivedRepairJob({ ...repairOpen, expectedGeneration: { casVersion: '1', epoch: '1' } }, context()),
    );
    expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
    expect(statements.some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(false);
    expect(statements.filter((statement) => /^rollback$/iu.test(statement)).length).toBe(1);
  }),
);

it.effect('Postgres stamp repair returns the campaign a duplicate restart already created without a write', () =>
  Effect.gen(function* duplicateRestartPostgres() {
    const statements: string[] = [];
    // The persisted job is already the epoch 2 campaign that restart produced.
    const jobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '2',
      '2',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([jobRow]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const resumed = yield* store.openDerivedRepairJob(
      { ...repairOpen, expectedGeneration: { casVersion: '1', epoch: '1' } },
      context(),
    );
    expect(resumed).toMatchObject({ casVersion: '2', epoch: '2' });
    expect(statements.some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(false);
  }),
);

it.effect('Postgres stamp repair first open resumes the winner when its insert loses a race', () =>
  Effect.gen(function* racedCreateRepairPostgres() {
    const statements: string[] = [];
    const jobRow = [
      tenantId,
      moduleId,
      'demo.tasks.task',
      '1',
      '1',
      null,
      null,
      'sweeping',
      '2026-11-04T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ];
    let jobSelects = 0;
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (statement.includes('from "core"."application_composition_authority"')) {
        return Effect.succeed([{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }]);
      }
      if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
        return Effect.succeed([{ legal_entity_id: '', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."search_derived_repair_jobs"')) {
        jobSelects += 1;
        // The first read sees no row; the re-read after the lost insert finds the winner's row.
        return Effect.succeed(jobSelects === 1 ? [] : [jobRow]);
      }
      if (statement.startsWith('insert into "core"."search_derived_repair_jobs"')) {
        return Effect.succeed([]);
      }
      return Effect.succeed([]);
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const resumed = yield* store.openDerivedRepairJob(repairOpen, context());
    expect(resumed).toMatchObject({ casVersion: '1', epoch: '1', state: 'sweeping' });
    const inserts = statements.filter((statement) =>
      statement.startsWith('insert into "core"."search_derived_repair_jobs"'),
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0] ?? '').toContain('on conflict do nothing');
  }),
);
