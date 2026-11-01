import { ActionPermissionDenied, ContextAccess } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ApplyCommandPayloadSchema,
  FacilityOperationsPermissionDenied,
  FacilityOperationsReferenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:agenda-delivery',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: {
    _tag: 'AgendaNotificationsDeliver',
    items: [{ category: 'DEADLINE', eventKey: 'deadline:test', source: 'ops', title: 'Kontrola termínu' }],
  },
  expectedRevision: 0,
});
const unused = () => Effect.die('Unexpected permission adapter');

for (const decision of ['denied', 'unavailable'] as const) {
  it.effect(`the registered Action prepares ${decision} owner permissions before opening SQL`, () =>
    Effect.scoped(
      Effect.gen(function* preparedOwnerPermissions() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
        let checks = 0;
        const access: ContextAccessService = {
          contextPermissions: ({ targets }) =>
            Effect.sync(() => {
              // The real Core Action runtime must not have opened its business transaction yet.
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
            transport: { correlationId: 'agenda-delivery', idempotencyKey: `agenda-delivery-${decision}` },
          })
          .pipe(Effect.provideService(ContextAccess, access), Effect.flip);
        expect(
          decision === 'denied'
            ? Schema.is(FacilityOperationsPermissionDenied)(failure)
            : Schema.is(FacilityOperationsReferenceUnavailable)(failure),
        ).toBe(true);
        expect(checks).toBe(1);
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().transactionCount).toBe(decision === 'denied' ? 1 : 0);
      }),
    ),
  );
}

it.effect('Core executor denial never resolves the owner permission adapter', () =>
  Effect.scoped(
    Effect.gen(function* executorDenied() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'denied' });
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'agenda-denied', idempotencyKey: 'agenda-denied' },
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
