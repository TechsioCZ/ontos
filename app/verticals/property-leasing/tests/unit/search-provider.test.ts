import {
  ContextAccess,
  CoreSearchQueryRuntime,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { CoreSearchAuthorization } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { LeasesProviderResponseSchema } from '../../shared/apis/leases-search.ts';
import { OccupancyStateSchema } from '../../shared/apis/records.ts';
import { leasesRead } from '../../src/search/leases.provider.ts';
import { propertyLeasingRegistration } from '../../vertical.registration.ts';
import { leaseSearchState } from '../fixtures/lease-search-state.ts';

const compositionRevision = 'a'.repeat(64);
const beginsTransaction = (statement: string) => /^begin/iu.test(statement);
const endsTransaction = (statement: string) => /^(?:commit|rollback)/iu.test(statement);
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00Z'));
const scope = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId: '60000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:lease-search-provider-test',
    authMethod: 'session',
    correlationId: 'lease-search-provider-test',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    principalId: '30000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  },
  compositionRevision,
);
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
const rowFor = (index: number) => ({
  ref: {
    moduleId: 'property.leasing',
    resourceId: ids[index],
    resourceType: 'property.leasing.occupancy',
    tenantId: scope.tenantId,
  },
  relevance: { score: 800, version: '1' },
  selectedLegalEntityId: scope.legalEntityId,
  title: `Nájem od 1. 11. 2026 na dobu neurčitou · Aktivní · ${ids[index]}`,
});
const run = (
  options: {
    readonly empty?: boolean;
    readonly missingPredicate?: boolean;
    readonly outcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
    readonly predicate?: ListAccessPredicate;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* scenario() {
      const predicate = options.predicate ?? reach([0, 2]);
      const gate = makeTestBoundAccessGate({
        answers: {
          'property.leasing.search-leases.read': { outcome: options.outcome ?? 'ALLOWED', predicate },
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
        executeOwnerQuery: ({ params, scope: installed, sql }) => {
          expect(installed).toEqual({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
          expect(sql).toContain('"property_leasing"."state"');
          expect(params).toEqual([scope.tenantId, scope.legalEntityId, 1]);
          return Effect.succeed([
            {
              legalEntityId: scope.legalEntityId,
              revision: 1,
              snapshot: Schema.encodeSync(OccupancyStateSchema)(leaseSearchState(options.empty === true ? [] : ids)),
              tenantId: scope.tenantId,
            },
          ]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: propertyLeasingRegistration,
        scope,
      });
      Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
        modules: () => Effect.die('Retired module authority was invoked'),
        resources: () => Effect.die('Retired resource authority was invoked'),
      });
      const queries: CoreSearchAuthorization[] = [];
      const exit = yield* harness.runtime
        .runRead({
          input: { query: 'najem' },
          principal: scope,
          registration: leasesRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: (_input, _requester, authorization) =>
              Effect.sync(() => {
                if (authorization !== undefined) {
                  queries.push(authorization);
                }
              }).pipe(Effect.andThen(Effect.die('Interactive Lease search must not observe an historical index'))),
          }),
          Effect.exit,
        );
      const { statements } = harness.snapshot();
      expect(statements.filter(beginsTransaction)).toHaveLength(statements.filter(endsTransaction).length);
      return { exit, gate: gate.accessDecision, queries, snapshot: harness.snapshot() };
    }),
  );
const failureFor = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
it.layer(NodeCrypto.layer)('canonical Lease search LIST', (suite) => {
  suite.effect(
    'retains exact readable current owner rows in canonical relevance order, without retired authority',
    () =>
      Effect.gen(function* mixed() {
        const result = yield* run();
        expect(result.exit).toEqual(Exit.succeed([rowFor(0), rowFor(2)]));
        expect(result.gate.askedLists).toHaveLength(1);
        expect(result.gate.askedLists[0]?.carrier.accessDeclaration).toEqual(leasesRead.descriptor.accessDeclaration);
        expect(result.gate.askedDecisions).toEqual([]);
        expect(result.queries).toEqual([]);
        expect(result.snapshot.evidenceWrites).toBe(1);
      }),
  );
  suite.effect('an excluded-only reach and empty current owner state both return empty admitted collections', () =>
    Effect.gen(function* hiddenMatches() {
      const hidden = yield* run({ empty: true, predicate: reach([2]) });
      const excluded = yield* run({
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
      expect(hidden.exit).toEqual(Exit.succeed([]));
      expect(excluded.exit).toEqual(hidden.exit);
    }),
  );
  suite.effect('admitted all reach retains every current result in canonical order', () =>
    Effect.gen(function* all() {
      const result = yield* run({ predicate: { groups: [] } });
      expect(result.exit).toEqual(Exit.succeed([0, 1, 2].map(rowFor)));
    }),
  );
  suite.effect('preserves AND of OR clauses and exact-record intersections', () =>
    Effect.gen(function* compound() {
      const left = reach([0, 1]);
      const right = reach([1, 2]);
      const result = yield* run({ predicate: { groups: [...left.groups, ...right.groups] } });
      expect(result.exit).toEqual(Exit.succeed([rowFor(1)]));
    }),
  );
  for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
    suite.effect(`${outcome} admits no index or owner observation`, () =>
      Effect.gen(function* refused() {
        const result = yield* run({ outcome });
        expect(
          outcome === 'DENIED'
            ? result.exit.pipe(failureFor, Schema.is(ReadPermissionDenied))
            : result.exit.pipe(failureFor, Schema.is(ReadPermissionUnavailable)),
        ).toBe(true);
        expect(result.queries).toEqual([]);
        expect(result.snapshot.ownerQueries).toEqual([]);
        expect(result.snapshot.stages).not.toContain('handler_executed');
      }),
    );
  }
  suite.effect('a missing predicate never becomes implicit ALL', () =>
    Effect.gen(function* missing() {
      const result = yield* run({ missingPredicate: true });
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.queries).toEqual([]);
      expect(result.snapshot.ownerQueries).toEqual([]);
    }),
  );
  for (const malformed of ['groups', 'clauses', 'conditions', 'unknown'] as const) {
    suite.effect(`rejects malformed ${malformed} before searching`, () =>
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
        const result = yield* run({ predicate });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.queries).toEqual([]);
        expect(result.snapshot.ownerQueries).toEqual([]);
      }),
    );
  }
});
it('accepts only the verified optional Core relevance v1 score range', () => {
  const result = rowFor(0);
  expect(Schema.is(LeasesProviderResponseSchema)([result])).toBe(true);
  for (const relevance of [
    { score: 0, version: '1' },
    { score: 1000, version: '1' },
  ]) {
    expect(Schema.is(LeasesProviderResponseSchema)([{ ...result, relevance }])).toBe(true);
  }
  for (const relevance of [
    { score: -1, version: '1' },
    { score: 1001, version: '1' },
    { score: 500.5, version: '1' },
    { score: 500, version: '2' },
  ]) {
    expect(Schema.is(LeasesProviderResponseSchema)([{ ...result, relevance }])).toBe(false);
  }
});
