import {
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchQuerySchema,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchAuthorization, OperationalScope, ReadPrepareContext } from '@app/core-runtime';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { getReadHandler, makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { NodeCrypto } from '@effect/platform-node';
import { PgDialect } from 'drizzle-orm/pg-core';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { selectCoreSearchCandidates } from '../../../../packages/core-runtime/src/search/indexed-query.ts';
import { searchVisibilitySql } from '../../../../packages/core-runtime/src/search/visibility.ts';
import { coreRelations, searchIndexEntries } from '../../../../packages/core-runtime/src/db/schema.ts';
import { sql } from 'drizzle-orm';
import { loadMarkets, marketsRead } from '../../src/search/markets.provider.ts';
import { commerceMarketCatalogBackendRegistration } from '../../vertical.runtime-declaration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const companyId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const firstId = '44444444-4444-4444-8444-444444444444';
const secondId = '55555555-5555-4555-8555-555555555555';
const thirdId = '66666666-6666-4666-8666-666666666666';
const moduleId = 'commerce.market-catalog';
const resourceType = 'commerce.market-catalog.market';
const operationTime = new Date('2026-06-01T00:00:00.000Z');
const scope: OperationalScope = {
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: 'better-auth-session:market-search-list',
  authMethod: 'session',
  correlationId: 'market-search-list',
  legalEntityId: companyId,
  principalId,
  tenantId,
};
const principal = {
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: scope.authContextRef,
  authMethod: 'session',
  legalEntityId: companyId,
  principalId,
  tenantId,
} as const;
const worker = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleId,
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: moduleId,
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.market-catalog.market-created.v1',
  workerKey: 'commerce.market-catalog.project-market-created-to-search',
});
const condition = (value: typeof ListAccessConditionSchema.Encoded) =>
  Schema.decodeUnknownSync(ListAccessConditionSchema)(value);
const keys = (...recordKeys: [string, ...string[]]) => condition({ _tag: 'RecordKeyIn', recordKeys });
const clause = (...conditions: [ListAccessCondition, ...ListAccessCondition[]]) => ({ conditions });
const predicate = (...conditions: [ListAccessCondition, ...ListAccessCondition[]]): ListAccessPredicate => ({
  groups: [{ clauses: [clause(...conditions)] }],
});
const normalizeParameters = (text: string) => text.replaceAll(/\$\d+/gu, '?');
// These are explicit answers scripted at the gate, not a fallback fabricated by owner code.
const scopeWide: ListAccessPredicate = { groups: [] };
const unsupported = [
  condition({ _tag: 'AssignedTo', holder: { _tag: 'Principal', principalId } }),
  condition({ _tag: 'EntrustedTo', holder: { _tag: 'Principal', principalId } }),
  condition({ _tag: 'TeamMemberOf', teamIds: ['88888888-8888-4888-8888-888888888888'] }),
  condition({ _tag: 'AmountWithinCeiling', ceiling: { currency: 'CZK', limitMinor: 100 } }),
] as const;
const cases: readonly {
  readonly expected: readonly string[];
  readonly filter: ListAccessPredicate;
  readonly name: string;
}[] = [
  { expected: [firstId, secondId, thirdId], filter: scopeWide, name: 'actual scope-wide answer' },
  {
    expected: [firstId, secondId, thirdId],
    filter: predicate(condition({ _tag: 'AllInScope' })),
    name: 'explicit AllInScope answer',
  },
  { expected: [secondId], filter: predicate(keys(secondId)), name: 'RecordKeyIn' },
  {
    expected: [secondId],
    filter: {
      groups: [
        { clauses: [clause(keys(firstId)), clause(keys(secondId, thirdId))] },
        { clauses: [clause(keys(firstId, secondId), keys(secondId, thirdId))] },
      ],
    },
    name: 'AND of OR groups with AND conditions',
  },
  ...unsupported.map((entry) => ({
    expected: [],
    filter: predicate(entry, keys(firstId)),
    name: `unsupported ${entry._tag} cannot widen a conjunction`,
  })),
  {
    expected: [],
    filter: predicate(condition({ _tag: 'AssignedTo', holder: { _tag: 'Agent', agentId: principalId } })),
    name: 'unsupported agent assignee is false',
  },
  {
    expected: [thirdId],
    filter: { groups: [{ clauses: [clause(...unsupported), clause(keys(thirdId))] }] },
    name: 'unsupported OR branch does not suppress a genuine matching branch',
  },
];

const indexedRuntime = Effect.gen(function* indexedMarketRuntime() {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(operationTime)));
  const store = makeInMemoryCoreSearchProjectionStore();
  for (const [index, resourceId] of [firstId, secondId, thirdId].entries()) {
    yield* store.apply(
      {
        document: {
          archived: false,
          facets: [],
          metadata: [],
          projectionVersion: '1',
          ref: { moduleId, resourceId, resourceType, tenantId },
          searchableText: [],
          selectedLegalEntityId: companyId,
          temporalFacets: [{ key: 'visible-market', validFrom: '2026-01-01', value: 'yes' }],
          title: `Market ${index}`,
        },
        kind: 'upsert',
      },
      worker,
    );
  }
  return yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
});

const harnessFor = (accessDecision: Parameters<typeof makeReadTestHarness>[0]['accessDecision']) =>
  makeReadTestHarness({
    accessDecision,
    executeOwnerQuery: () => Effect.die('Market search must not read owner tables'),
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: commerceMarketCatalogBackendRegistration,
    scope,
    scopeAccess: 'allowed',
  });
const request = {
  input: { query: 'Market' },
  principal,
  registration: marketsRead,
  transport: { correlationId: 'search' },
};

for (const sample of cases) {
  it.effect(`applies the gate's ${sample.name} before matching and result evidence`, () =>
    Effect.gen(function* canonicalList() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED', predicate: sample.filter } });
      const harness = yield* harnessFor(gate.bound);
      const runtime = yield* indexedRuntime;
      const observed: CoreSearchAuthorization[] = [];
      const result = yield* harness.runtime.runRead(request).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: (input, selectedScope, authorization) => {
            expect(authorization?.listAccess).toBe(sample.filter);
            expect(authorization).toEqual({ listAccess: sample.filter });
            if (authorization !== undefined) {
              observed.push(authorization);
            }
            // Index I/O is prepared before Core opens the owner-load transaction.
            const transactions = harness.snapshot().statements;
            expect(transactions.filter((entry) => /^begin/iu.test(entry))).toHaveLength(
              transactions.filter((entry) => /^(?:commit|rollback)/iu.test(entry)).length,
            );
            return runtime.search(input, selectedScope, authorization);
          },
        }),
      );
      expect(result.map((item) => item.ref.resourceId)).toEqual(sample.expected);
      expect(observed.length).toBeGreaterThan(0);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(gate.accessDecision.askedLists[0]?.carrier.accessDeclaration?.key).toBe(
        marketsRead.descriptor.accessDeclaration?.key,
      );
      const normative = [firstId, secondId, thirdId].filter((recordKey) =>
        evaluateListAccessPredicate(sample.filter, { recordKey: RecordKeySchema.make(recordKey), teamIds: [] }),
      );
      expect(result.map((item) => item.ref.resourceId)).toEqual(normative);
      const ownerResult = yield* getReadHandler(marketsRead)(request.input, {
        deniedFieldPaths: [],
        listAccess: sample.filter,
        readKey: marketsRead.descriptor.readKey,
        scope,
        services: {},
      }).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
      expect(ownerResult).toEqual({ evidence: { resultCount: normative.length }, result });
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}

it.effect('rejects an ALLOWED answer without its LIST predicate before owner or index work', () =>
  Effect.gen(function* incompleteListAnswer() {
    const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED', predicate: scopeWide } });
    const harness = yield* harnessFor({
      ...gate.bound,
      list: (question) => gate.bound.list(question).pipe(Effect.map(({ decision }) => ({ decision }))),
    });
    const failure = yield* harness.runtime.runRead(request).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.die('An incomplete LIST answer must not read the index'),
      }),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ReadPermissionDenied);
    expect(harness.snapshot().ownerQueries).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
  it.effect(`refuses ${outcome} before observing owner state or the index`, () =>
    Effect.gen(function* refusedSearch() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome } });
      const harness = yield* harnessFor(gate.bound);
      const failure = yield* harness.runtime.runRead(request).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () => Effect.die('A refused gate must not observe the index'),
        }),
        Effect.flip,
      );
      expect(Schema.is(outcome === 'DENIED' ? ReadPermissionDenied : ReadPermissionUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}

it.effect('refuses missing LIST/field answers and undeclared field restrictions before reading the index', () =>
  Effect.gen(function* missingAuthorization() {
    const incomplete: readonly Pick<ReadPrepareContext, 'deniedFieldPaths' | 'listAccess'>[] = [
      {},
      { listAccess: scopeWide },
      { deniedFieldPaths: [] },
      { deniedFieldPaths: [['title']], listAccess: scopeWide },
    ];
    for (const authorization of incomplete) {
      const failure = yield* getReadHandler(marketsRead)(request.input, {
        ...authorization,
        readKey: marketsRead.descriptor.readKey,
        scope,
        services: {},
      }).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () => Effect.die('Incomplete authority must not read the index'),
        }),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    }
    const noPredicate = yield* loadMarkets(scope, request.input, {}).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.die('The loader must not default to an unfiltered index query'),
      }),
      Effect.flip,
    );
    expect(noPredicate).toBeInstanceOf(ReadHandlerUnavailable);
  }),
);

it.effect('keeps the canonical predicate in production SQL WHERE before ordering and the candidate budget', () =>
  Effect.gen(function* postgresPredicate() {
    const database = yield* makeWithDefaults({ relations: coreRelations }).pipe(
      Effect.provide(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((statement) =>
              /^(?:begin|commit|rollback)/iu.test(statement)
                ? Effect.succeed([])
                : Effect.die('Compile-only SQL proof must not execute a query'),
            ),
          ),
        ).pipe(Layer.provide(Reactivity.layer)),
      ),
    );
    const query = yield* Schema.decodeUnknownEffect(CoreSearchQuerySchema)({
      effectiveAt: operationTime.toISOString(),
      includeArchived: false,
      moduleId,
      query: 'Market',
      resourceType,
      selectedLegalEntityId: companyId,
      tenantId,
    });
    yield* database.transaction((transaction) =>
      Effect.sync(() => {
        for (const sample of cases) {
          const compiled = selectCoreSearchCandidates(transaction, query, { listAccess: sample.filter }).toSQL();
          const visibility = new PgDialect().sqlToQuery(
            searchVisibilitySql(sample.filter, {
              assignedPrincipalId: sql`${searchIndexEntries.facetsJson}->>'assignedPrincipalId'`,
              recordKey: searchIndexEntries.sourceResourceId,
            }),
          );
          if (sample.name === 'AND of OR groups with AND conditions') {
            const column = '"core"."search_index_entries"."source_resource_id"';
            expect(visibility.sql).toBe(
              `((((${column} in ($1)) or (${column} in ($2, $3)))) and (((${column} in ($4, $5)) and (${column} in ($6, $7)))))`,
            );
            expect(visibility.params).toEqual([firstId, secondId, thirdId, firstId, secondId, secondId, thirdId]);
          }
          if (sample.filter === scopeWide) {
            expect(visibility.sql).toBe('true');
          }
          const where = compiled.sql.slice(compiled.sql.indexOf(' where '), compiled.sql.indexOf(' order by '));
          expect(normalizeParameters(where)).toContain(normalizeParameters(visibility.sql));
          expect(where).toContain('"tenant_id" =');
          expect(where).toContain('"legal_entity_id" =');
          expect(where).toContain('"source_module_key" =');
          expect(where).toContain('"source_resource_type" =');
          expect(compiled.params).toEqual(
            expect.arrayContaining([tenantId, companyId, moduleId, resourceType, ...visibility.params]),
          );
          expect(compiled.sql).toMatch(/order by .* limit \$\d+$/u);
          if (
            sample.name.startsWith('unsupported ') &&
            sample.name !== 'unsupported AssignedTo cannot widen a conjunction'
          ) {
            expect(visibility.sql).toContain('false');
          }
        }
      }),
    );
  }).pipe(Effect.scoped),
);

it.effect('uses the registered search declaration and its exact LIST answer in the trusted owner scope', () =>
  Effect.gen(function* declaredListAuthority() {
    const filter = predicate(keys(secondId));
    const expectedScope = { ...principal, correlationId: request.transport.correlationId };
    const gate = makeTestBoundAccessGate({
      answers: {
        'commerce.market-catalog.market.search': { outcome: 'ALLOWED', predicate: filter },
      },
      defaultAnswer: { outcome: 'DENIED' },
    });
    const harness = yield* harnessFor(gate.bound);
    const runtime = yield* indexedRuntime;
    let indexQueries = 0;
    const result = yield* harness.runtime.runRead(request).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (input, selectedScope, authorization) => {
          indexQueries += 1;
          expect(selectedScope).toEqual(expectedScope);
          expect(authorization?.listAccess).toBe(filter);
          return runtime.search(input, selectedScope, authorization);
        },
      }),
    );
    expect(result.map((item) => item.ref.resourceId)).toEqual([secondId]);
    expect(indexQueries).toBeGreaterThan(0);
    expect(harness.snapshot().ownerQueries).toEqual([]);
    expect(gate.accessDecision.askedLists.length).toBeGreaterThan(0);
    for (const question of gate.accessDecision.askedLists) {
      expect(question.carrier).toEqual({ accessDeclaration: marketsRead.descriptor.accessDeclaration });
      expect(question.carrier.accessDeclaration).toBe(marketsRead.descriptor.accessDeclaration);
      expect(question.legalEntityScope).toBe(marketsRead.descriptor.legalEntityScope);
      expect(question.scope).toEqual(expectedScope);
      expect(question.now).toEqual(operationTime);
    }
    expect(marketsRead.descriptor.accessDeclaration?.selectors).toEqual(['all']);
    expect(marketsRead.descriptor.accessFieldGroups).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('does not substitute another capability grant for the registered search LIST authority', () =>
  Effect.gen(function* unrelatedCapability() {
    const gate = makeTestBoundAccessGate({
      answers: {
        'commerce.market-catalog.market-administration.read': { outcome: 'ALLOWED', predicate: scopeWide },
      },
      defaultAnswer: { outcome: 'DENIED' },
    });
    const harness = yield* harnessFor(gate.bound);
    const failure = yield* harness.runtime.runRead(request).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.die('An unrelated capability must not authorize index access'),
      }),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ReadPermissionDenied);
    expect(harness.snapshot().ownerQueries).toEqual([]);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
    expect(gate.accessDecision.askedLists.length).toBeGreaterThan(0);
    for (const question of gate.accessDecision.askedLists) {
      expect(question.carrier).toEqual({ accessDeclaration: marketsRead.descriptor.accessDeclaration });
      expect(question.carrier.accessDeclaration).toBe(marketsRead.descriptor.accessDeclaration);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
