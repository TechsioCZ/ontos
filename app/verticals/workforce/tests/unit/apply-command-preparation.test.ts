import { ActionPermissionDenied, ContextAccess } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  WorkforcePermissionDenied,
  WorkforceReferenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:workforce-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: {
    _tag: 'CreateEmployee',
    active: true,
    department: 'Provoz',
    email: 'regression@example.test',
    fullName: 'Regresní test',
    id: '50000000-0000-4000-8000-000000000001',
    role: 'SALES_REP',
  },
  expectedRevision: 0,
});
const unused = () => Effect.die('Unexpected permission adapter');

for (const decision of ['denied', 'unavailable'] as const) {
  it.effect(`the registered workforce Action prepares ${decision} permissions before SQL`, () =>
    Effect.scoped(
      Effect.gen(function* preparedPermissions() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
        let checks = 0;
        const access: ContextAccessService = {
          contextPermissions: ({ targets }) =>
            Effect.sync(() => {
              expect(harness.snapshot().transactionCount).toBe(0);
              checks += 1;
              return targets.map(({ moduleId, permission }) => ({ decision, key: `${moduleId}:${permission}` }));
            }),
          legalEntities: unused,
          modules: unused,
          resources: unused,
          tenants: unused,
        };
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'workforce-command', idempotencyKey: `workforce-command-${decision}` },
          })
          .pipe(Effect.provideService(ContextAccess, access), Effect.flip);
        expect(
          decision === 'denied'
            ? Schema.is(WorkforcePermissionDenied)(failure)
            : Schema.is(WorkforceReferenceUnavailable)(failure),
        ).toBe(true);
        expect(checks).toBe(1);
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().transactionCount).toBe(0);
      }),
    ),
  );
}

it.effect('Core executor denial never reaches workforce permission preparation', () =>
  Effect.scoped(
    Effect.gen(function* executorDenied() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'denied' });
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'work-denied', idempotencyKey: 'work-denied' },
        })
        .pipe(
          Effect.provideService(ContextAccess, {
            contextPermissions: unused,
            legalEntities: unused,
            modules: unused,
            resources: unused,
            tenants: unused,
          }),
          Effect.flip,
        );
      expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  ),
);

for (const decision of ['denied', 'unavailable'] as const) {
  it.effect(`restricted mutations prepare ${decision} resource decisions before SQL`, () =>
    Effect.scoped(
      Effect.gen(function* restrictedMutation() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
        const restrictedPayload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
          command: {
            _tag: 'UpdateEmployee',
            id: '50000000-0000-4000-8000-000000000001',
            patch: { department: 'Provoz' },
          },
          expectedRevision: 1,
        });
        let resourceChecks = 0;
        const failure = yield* harness.runtime
          .runAction({
            payload: restrictedPayload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'restricted-command', idempotencyKey: `restricted-${decision}` },
          })
          .pipe(
            Effect.provideService(ContextAccess, {
              contextPermissions: ({ targets }) =>
                Effect.succeed(
                  targets.map(({ moduleId, permission }) => ({
                    decision: 'denied' as const,
                    key: `${moduleId}:${permission}`,
                  })),
                ),
              legalEntities: unused,
              modules: unused,
              resources: ({ resources }) =>
                Effect.sync(() => {
                  expect(harness.snapshot().transactionCount).toBe(0);
                  resourceChecks += 1;
                  return resources.map((ref) => ({
                    decision,
                    key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
                  }));
                }),
              tenants: unused,
            }),
            Effect.flip,
          );
        expect(
          decision === 'denied'
            ? Schema.is(WorkforcePermissionDenied)(failure)
            : Schema.is(WorkforceReferenceUnavailable)(failure),
        ).toBe(true);
        expect(resourceChecks).toBe(1);
        expect(harness.snapshot().transactionCount).toBe(0);
      }),
    ),
  );
}
