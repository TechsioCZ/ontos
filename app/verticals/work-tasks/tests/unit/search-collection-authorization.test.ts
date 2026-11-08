import {
  failClosedOwnerAuthorizationDecision,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { tasksRead } from '../../src/search/tasks.provider.ts';
import { workTasksRegistration } from '../../vertical.registration.ts';
import { buildSearchDocuments } from '../../src/services/search-projection.ts';
import { loadSearch, prepareTaskSearch } from '../../src/services/search-read.ts';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import { company, context, ref, scope } from './search-fixtures.ts';

const runtimeScope = {
  ...scope,
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search-owner',
  authMethod: 'session',
} as const;
const foreignRef = Schema.decodeSync(TaskRefSchema)({ ...ref, resourceId: '40000000-0000-4000-8000-000000000002' });
const assigned: ListAccessPredicate = {
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
};
const setup = Effect.gen(function* setup() {
  const store = makeInMemoryCoreSearchProjectionStore();
  const documents = yield* buildSearchDocuments({
    projectionVersion: '1',
    records: [
      {
        archived: false,
        legalEntityId: company,
        ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId },
        ref,
        title: 'Povolený úkol',
      },
      {
        archived: false,
        legalEntityId: company,
        ownerPrincipalRef: { principalId: runtimeScope.authBindingId, tenantId: scope.tenantId },
        ref: foreignRef,
        title: 'Zakázaný úkol',
      },
    ],
    tenantId: scope.tenantId,
  });
  yield* store.replace(
    {
      documents,
      moduleId: ref.moduleId,
      rebuildVersion: '1',
      resourceType: ref.resourceType,
      tenantId: scope.tenantId,
    },
    context,
  );
  return yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
});
for (const [name, predicate, expected] of [
  ['assigned', assigned, [ref.resourceId]],
  ['all', { groups: [] }, [ref.resourceId, foreignRef.resourceId]],
] as const) {
  it.effect(`registered task search uses canonical ${name} authority, never retired resource checks`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const runtime = yield* setup;
        const harness = yield* makeReadTestHarness({
          access: 'allowed',
          executeOwnerQuery: () => Effect.die('No owner SQL for indexed search'),
          onOwnerAuthorization: failClosedOwnerAuthorizationDecision,
          operationTime: new Date('2026-11-01T09:00:00Z'),
          ownerRegistration: workTasksRegistration,
          scope: runtimeScope,
        });
        const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED', predicate } });
        const result = yield* harness.runtime
          .runRead({
            input: { query: 'úkol' },
            principal: runtimeScope,
            registration: tasksRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(
            Effect.provideService(CoreSearchQueryRuntime, runtime),
            Effect.provideService(AccessDecisionGate, gate),
          );
        expect(result.map(({ ref: row }) => row.resourceId).toSorted()).toEqual([...expected].toSorted());
        expect(gate.askedLists[0]?.carrier.accessDeclaration?.key).toBe('work.tasks.api-records.read');
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );
}
it.effect('search intersects its explicit target ceiling with the actual records predicate before text matching', () =>
  Effect.gen(function* test() {
    const runtime = yield* setup;
    const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED', predicate: assigned } });
    const target: ListAccessPredicate = {
      groups: [
        {
          clauses: [
            { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(foreignRef.resourceId)] }] },
          ],
        },
      ],
    };
    const predicate = yield* prepareTaskSearch(runtimeScope, target).pipe(
      Effect.provideService(AccessDecisionGate, gate),
    );
    const result = yield* loadSearch(runtimeScope, 'úkol', predicate).pipe(
      Effect.provideService(CoreSearchQueryRuntime, runtime),
      Effect.provideService(AccessDecisionGate, gate),
    );
    expect(result).toEqual([]);
    expect(
      yield* loadSearch(runtimeScope, 'zakazany', assigned).pipe(
        Effect.provideService(CoreSearchQueryRuntime, runtime),
        Effect.provideService(AccessDecisionGate, gate),
      ),
    ).toEqual([]);
  }),
);
