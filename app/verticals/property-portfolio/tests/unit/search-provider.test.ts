import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { CoreSearchProjectionHit, ReadRuntimeService } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { assetsRead } from '../../src/search/assets.provider.ts';
import { propertiesRead } from '../../src/search/properties.provider.ts';
import { unitsRead } from '../../src/search/units.provider.ts';
import { searchState, searchStateRow } from '../support/search-state.ts';
import type { PropertyState } from '../../shared/apis/records.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { propertyPortfolioRegistration } from '../../vertical.registration.ts';

const compositionRevision = 'a'.repeat(64);
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00Z'));
const scope = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId: '60000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:property-search-provider-test',
    authMethod: 'session',
    correlationId: 'property-search-provider-test',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    principalId: '30000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  },
  compositionRevision,
);
const resources = { asset: assetsRead, property: propertiesRead, unit: unitsRead } as const;
type Resource = keyof typeof resources;
const ids = ['1', '2', '3'].map((suffix) => RecordKeySchema.make(`40000000-0000-4000-8000-00000000000${suffix}`));
const reach = (indexes: readonly number[]): ListAccessPredicate => ({
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'RecordKeyIn',
              recordKeys: Schema.decodeUnknownSync(Schema.NonEmptyArray(RecordKeySchema))(
                indexes.flatMap((index) => ids[index] ?? []),
              ),
            },
          ],
        },
      ],
    },
  ],
});
const hitFor = (resource: Resource, index: number) =>
  Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
    archived: false,
    facets: [],
    metadata: [],
    ref: {
      moduleId: 'property.portfolio',
      resourceId: ids[index],
      resourceType: `property.portfolio.${resource}`,
      tenantId: scope.tenantId,
    },
    relevance: { score: (3 - index) * 100, version: '1' },
    selectedLegalEntityId: scope.legalEntityId,
    title: ['A park', 'B park', 'C park'][index],
  });
const rowFor = (resource: Resource, hit: CoreSearchProjectionHit) => {
  const row = { ref: hit.ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title };
  return resource === 'asset' ? { ...row, relevance: { score: 700, version: '1' } } : row;
};
interface Scenario {
  readonly index?: 'absent' | 'forged' | 'unavailable';
  readonly missingPredicate?: boolean;
  readonly outcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly ownerUnavailable?: boolean;
  readonly predicate?: ListAccessPredicate;
  readonly query?: string;
  readonly state?: PropertyState;
}
const runProvider = (resource: Resource, runtime: ReadRuntimeService, query = 'Park') =>
  Effect.gen(function* selectedProvider() {
    const request = { input: { query }, principal: scope, transport: { correlationId: scope.correlationId } };
    if (resource === 'asset') {
      return yield* runtime.runRead({ ...request, registration: assetsRead });
    }
    if (resource === 'property') {
      return yield* runtime.runRead({ ...request, registration: propertiesRead });
    }
    return yield* runtime.runRead({ ...request, registration: unitsRead });
  });
type ReadHarness = Effect.Success<ReturnType<typeof makeReadTestHarness>>;
const assertOwnerCommitted = (harness: Pick<ReadHarness, 'snapshot'>) => {
  const { statements } = harness.snapshot();
  expect(statements).toContain('COMMIT');
  expect(statements.filter((sql) => sql.startsWith('SAVEPOINT'))).toEqual([]);
  expect(statements.filter((sql) => sql.startsWith('BEGIN'))).toHaveLength(
    statements.filter((sql) => sql === 'COMMIT').length,
  );
};
const onlyDeniedState = (resource: Resource): PropertyState => ({
  ...searchState,
  assets: resource === 'asset' ? searchState.assets.slice(1, 2) : searchState.assets,
  properties:
    resource === 'property'
      ? searchState.properties.filter(
          ({ propertyRef }) => propertyRef.resourceId === ids[1] || propertyRef.resourceId.endsWith('099'),
        )
      : searchState.properties,
  units: resource === 'unit' ? searchState.units.slice(1, 2) : searchState.units,
});
const poolProbeUnavailable = (cause: unknown) =>
  new CoreSearchProjectionInvalid({ cause, code: 'core_search_projection_invalid', reason: 'Pool probe failed' });
const run = (resource: Resource, options: Scenario = {}) =>
  Effect.scoped(
    Effect.gen(function* scenario() {
      const registration = resources[resource];
      const predicate = options.predicate ?? reach([0, 2]);
      const { key } = yield* Effect.fromNullishOr(registration.descriptor.accessDeclaration);
      const gate = makeTestBoundAccessGate({
        answers: {
          [key]: { outcome: options.outcome ?? 'ALLOWED', predicate },
        },
      });
      const bound =
        options.missingPredicate === true
          ? {
              ...gate.bound,
              list: (question: Parameters<typeof gate.bound.list>[0]) =>
                gate.bound.list(question).pipe(Effect.map(({ decision }) => ({ decision }))),
            }
          : gate.bound;
      const harness = yield* makeReadTestHarness({
        accessDecision: bound,
        compositionRevision,
        executeOwnerQuery: (query) => {
          expect(query.scope).toEqual({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
          expect(query.params).toEqual([scope.tenantId, scope.legalEntityId, 1]);
          expect(query.sql).toContain('"property_portfolio"."state"');
          return options.ownerUnavailable === true
            ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'scripted owner unavailable' }) }))
            : Effect.succeed([searchStateRow(options.state ?? searchState)]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: propertyPortfolioRegistration,
        scope,
      });
      Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
        modules: () => Effect.die('Retired module authority was invoked'),
        resources: () => Effect.die('Retired resource authority was invoked'),
      });
      let indexObservations = 0;
      const operation = runProvider(resource, harness.runtime, options.query);
      const exit = yield* Effect.exit(
        options.index === undefined || options.index === 'absent'
          ? operation
          : operation.pipe(
              Effect.provideService(CoreSearchQueryRuntime, {
                search: () => {
                  indexObservations += 1;
                  return options.index === 'unavailable'
                    ? Effect.fail(
                        new CoreSearchProjectionUnavailable({
                          code: 'core_search_projection_unavailable',
                          reason: 'Scripted index unavailable',
                        }),
                      )
                    : Effect.succeed([hitFor(resource, 1)]);
                },
              }),
            ),
      );
      return { exit, gate: gate.accessDecision, indexObservations, snapshot: harness.snapshot() };
    }),
  );
const failureFor = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

it.layer(NodeCrypto.layer)('canonical Property search LIST', (suite) => {
  for (const resource of ['asset', 'property', 'unit'] as const) {
    suite.effect(`${resource} uses one canonical LIST and retains only its exact readable rows`, () =>
      Effect.gen(function* mixed() {
        const result = yield* run(resource);
        expect(result.exit).toEqual(Exit.succeed([0, 2].map((index) => rowFor(resource, hitFor(resource, index)))));
        expect(result.gate.askedLists).toHaveLength(1);
        expect(result.gate.askedLists[0]?.carrier.accessDeclaration).toEqual(
          resources[resource].descriptor.accessDeclaration,
        );
        expect(result.gate.askedDecisions).toEqual([]);
        expect(result.indexObservations).toBe(0);
        expect(result.snapshot.evidenceWrites).toBe(1);
      }),
    );
    suite.effect(`${resource} hides denied-only and nonexistent matches identically`, () =>
      Effect.gen(function* hiddenMatches() {
        const hidden = yield* run(resource, { state: onlyDeniedState(resource) });
        const empty = yield* run(resource, { state: { assets: [], properties: [], units: [] } });
        expect(hidden.exit).toEqual(Exit.succeed([]));
        expect(empty.exit).toEqual(hidden.exit);
        expect(hidden.snapshot.evidenceWrites).toBe(1);
      }),
    );
    suite.effect(`${resource} retains full owner order for admitted all reach`, () =>
      Effect.gen(function* all() {
        const result = yield* run(resource, { predicate: { groups: [] } });
        expect(result.exit).toEqual(Exit.succeed([0, 1, 2].map((index) => rowFor(resource, hitFor(resource, index)))));
      }),
    );
    suite.effect(`${resource} preserves AND of OR clauses and exact-record intersections`, () =>
      Effect.gen(function* compound() {
        const left = reach([0, 1]);
        const right = reach([1, 2]);
        const result = yield* run(resource, { predicate: { groups: [...left.groups, ...right.groups] } });
        expect(result.exit).toEqual(Exit.succeed([rowFor(resource, hitFor(resource, 1))]));
      }),
    );
    suite.effect(`${resource} owner unavailability rolls back and never observes the index`, () =>
      Effect.gen(function* ownerFailure() {
        const result = yield* run(resource, { ownerUnavailable: true });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.indexObservations).toBe(0);
        expect(result.snapshot.ownerQueries).toHaveLength(1);
        expect(result.snapshot.statements).toContain('ROLLBACK');
        const ownerQuery = yield* Effect.fromNullishOr(result.snapshot.ownerQueries[0]);
        expect(result.snapshot.statements.slice(result.snapshot.statements.indexOf(ownerQuery.sql) + 1)).toEqual([
          'ROLLBACK',
        ]);
        expect(result.snapshot.evidenceWrites).toBe(0);
      }),
    );
    for (const index of ['absent', 'forged', 'unavailable'] as const) {
      suite.effect(`${resource} current results ignore historical index state ${index}`, () =>
        Effect.gen(function* indexIndependence() {
          const result = yield* run(resource, { index });
          expect(result.exit).toEqual(
            Exit.succeed([0, 2].map((position) => rowFor(resource, hitFor(resource, position)))),
          );
          expect(result.indexObservations).toBe(0);
          expect(result.snapshot.evidenceWrites).toBe(1);
          assertOwnerCommitted({ snapshot: () => result.snapshot });
        }),
      );
    }
    suite.effect(`${resource} unsupported owner facts never broaden reach`, () =>
      Effect.gen(function* unsupported() {
        const result = yield* run(resource, {
          predicate: {
            groups: [
              {
                clauses: [
                  {
                    conditions: [
                      {
                        _tag: 'AssignedTo',
                        holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
        expect(result.exit).toEqual(Exit.succeed([]));
      }),
    );
    for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
      suite.effect(`${resource} canonical ${outcome} takes no index or owner observation`, () =>
        Effect.gen(function* refused() {
          const result = yield* run(resource, { outcome });
          expect(
            outcome === 'DENIED'
              ? result.exit.pipe(failureFor, Schema.is(ReadPermissionDenied))
              : result.exit.pipe(failureFor, Schema.is(ReadPermissionUnavailable)),
          ).toBe(true);
          expect(result.indexObservations).toBe(0);
          expect(result.snapshot.ownerQueries).toEqual([]);
          expect(result.snapshot.stages).not.toContain('handler_executed');
        }),
      );
    }
    suite.effect(`${resource} missing admitted predicate is not implicit ALL`, () =>
      Effect.gen(function* missing() {
        const result = yield* run(resource, { missingPredicate: true });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.indexObservations).toBe(0);
        expect(result.snapshot.ownerQueries).toEqual([]);
      }),
    );
    for (const malformed of ['groups', 'clauses', 'conditions', 'unknown'] as const) {
      suite.effect(`${resource} rejects malformed ${malformed} predicate`, () =>
        Effect.gen(function* malformedReach() {
          const predicate = reach([0, 2]);
          if (malformed === 'groups') {
            Reflect.set(predicate, 'groups', 'invalid');
          } else if (malformed === 'clauses') {
            Reflect.set(predicate.groups[0] ?? {}, 'clauses', []);
          } else if (malformed === 'conditions') {
            Reflect.set(predicate.groups[0]?.clauses[0] ?? {}, 'conditions', []);
          } else {
            Reflect.set(predicate.groups[0]?.clauses[0]?.conditions[0] ?? {}, '_tag', 'Unknown');
          }
          const result = yield* run(resource, { predicate });
          expect(Exit.isFailure(result.exit)).toBe(true);
          expect(result.indexObservations).toBe(0);
          expect(result.snapshot.ownerQueries).toEqual([]);
        }),
      );
    }
  }
});

it.layer(NodeCrypto.layer)('native Property search phases', (suite) => {
  suite.effect(
    'finish can reacquire the same single-connection pool through another original registered owner Read',
    () =>
      Effect.scoped(
        Effect.gen(function* closedOwnerLease() {
          const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED', predicate: { groups: [] } } });
          const harness = yield* makeReadTestHarness({
            accessDecision: gate.bound,
            compositionRevision,
            executeOwnerQuery: () => Effect.succeed([searchStateRow()]),
            operationTime,
            ownerAuthorizationDecision: 'allowed',
            ownerRegistration: propertyPortfolioRegistration,
            scope,
          });
          let poolProbes = 0;
          const ownerSearch = yield* Effect.tryPromise({
            catch: poolProbeUnavailable,
            try: () => import('../../src/search/search-read.ts'),
          });
          const original = ownerSearch.loadOwnerSearch;
          const observer = rs.spyOn(ownerSearch, 'loadOwnerSearch').mockImplementation((...args) =>
            Effect.gen(function* observeOriginalFinish() {
              assertOwnerCommitted(harness);
              expect(harness.snapshot().ownerQueries).toHaveLength(1);
              const current = yield* harness.runtime
                .runRead({
                  input: {},
                  principal: scope,
                  registration: recordsRead,
                  transport: { correlationId: scope.correlationId },
                })
                .pipe(Effect.mapError(poolProbeUnavailable));
              expect(current.revision).toBe(42);
              poolProbes += 1;
              return yield* original(...args);
            }),
          );
          const result = yield* runProvider('asset', harness.runtime).pipe(
            Effect.ensuring(Effect.sync(() => observer.mockRestore())),
          );
          expect(result).toEqual([0, 1, 2].map((position) => rowFor('asset', hitFor('asset', position))));
          expect(poolProbes).toBe(1);
          expect(harness.snapshot().ownerQueries).toHaveLength(2);
          expect(harness.snapshot().statements.filter((sql) => sql.startsWith('SAVEPOINT'))).toEqual([]);
          expect(harness.snapshot().evidenceWrites).toBe(2);
        }),
      ),
  );
  for (const resource of ['unit', 'asset'] as const) {
    suite.effect(`${resource} original factory rejects old parent-text oracle after loading current state`, () =>
      Effect.gen(function* registeredOracle() {
        const result = yield* run(resource, { query: 'Private parent' });
        expect(result.exit).toEqual(Exit.succeed([]));
        expect(result.indexObservations).toBe(0);
        expect(result.snapshot.ownerQueries).toHaveLength(1);
        expect(result.snapshot.evidenceWrites).toBe(1);
      }),
    );
  }
});
