import { ContextAccess, CoreSearchProjectionHitSchema, CoreSearchQueryRuntime } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { tasksRead } from '../../src/search/tasks.provider.ts';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import { company, ref, scope } from './search-fixtures.ts';

const runtimeScope = {
  ...scope,
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:task-search-collection-test',
  authMethod: 'session',
} as const;
const allowedRef = ref;
const deniedRef = Schema.decodeSync(TaskRefSchema)({
  ...ref,
  resourceId: '40000000-0000-4000-8000-000000000002',
});
const hit = (candidate: typeof ref, title: string) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
    archived: false,
    facets: [],
    metadata: [],
    ref: candidate,
    selectedLegalEntityId: company,
    title,
  });

const runScenario = (allow: (resourceId: string) => boolean) =>
  Effect.scoped(
    Effect.gen(function* taskSearchScenario() {
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00.000Z')),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: runtimeScope,
      }).pipe(Effect.provideService(Crypto.Crypto, Context.get(cryptoServices, Crypto.Crypto)));
      const services = yield* Layer.build(harness.layer);
      const access = Context.get(services, ContextAccess);
      const checked: unknown[] = [];
      const check = rs.spyOn(access, 'resources').mockImplementation((input) => {
        checked.push(input);
        return Effect.succeed(
          input.resources.map((resource) => ({
            decision: allow(resource.resourceId) ? ('allowed' as const) : ('denied' as const),
            key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
          })),
        );
      });
      const hits = yield* Effect.all([hit(allowedRef, 'Povolený úkol'), hit(deniedRef, 'Zakázaný úkol')]);
      const result = yield* harness.runtime
        .runRead({
          input: { query: 'úkol' },
          principal: runtimeScope,
          registration: tasksRead,
          transport: { correlationId: runtimeScope.correlationId },
        })
        .pipe(
          Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
          Effect.ensuring(Effect.sync(() => check.mockRestore())),
        );
      return { checked, result, snapshot: harness.snapshot() };
    }),
  );

it.effect('returns only admitted task rows after checking every candidate resource', () =>
  Effect.gen(function* mixedTaskRows() {
    const outcome = yield* runScenario((resourceId) => resourceId === allowedRef.resourceId);
    expect(outcome.result.map(({ ref: resultRef }) => resultRef.resourceId)).toEqual([allowedRef.resourceId]);
    expect(outcome.checked).toEqual([
      {
        legalEntityId: runtimeScope.legalEntityId,
        permission: 'read',
        principalId: runtimeScope.principalId,
        resources: [
          { moduleId: allowedRef.moduleId, resourceId: allowedRef.resourceId, resourceType: allowedRef.resourceType },
          { moduleId: deniedRef.moduleId, resourceId: deniedRef.resourceId, resourceType: deniedRef.resourceType },
        ],
        tenantId: runtimeScope.tenantId,
      },
    ]);
    expect(outcome.snapshot.ownerQueries).toEqual([]);
  }),
);

it.effect('returns an empty collection when every task candidate is denied', () =>
  Effect.gen(function* deniedTaskRows() {
    const outcome = yield* runScenario(() => false);
    expect(outcome.result).toEqual([]);
    expect(outcome.checked.length).toBe(1);
  }),
);

it.effect('returns every task row when all candidates are explicitly allowed', () =>
  Effect.gen(function* allowedTaskRows() {
    const outcome = yield* runScenario(() => true);
    expect(outcome.result.map(({ ref: resultRef }) => resultRef.resourceId)).toEqual([
      allowedRef.resourceId,
      deniedRef.resourceId,
    ]);
  }),
);
