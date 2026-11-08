import { ActionPermissionDenied } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { facilityOperationsRegistration } from '../../vertical.registration.ts';
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
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          compositionRevision: 'a'.repeat(64),
          ownerRegistration: facilityOperationsRegistration,
        });
        let checks = 0;
        const gate = makeTestAccessDecision({
          defaultAnswer: { outcome: decision === 'denied' ? 'DENIED' : 'UNAVAILABLE' },
        });
        const access = {
          ...gate,
          decideMany: (questions: Parameters<typeof gate.decideMany>[0]) =>
            Effect.sync(() => {
              expect(harness.snapshot().transactionCount).toBe(0);
              checks += 1;
            }).pipe(Effect.andThen(gate.decideMany(questions))),
        };
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'agenda-delivery', idempotencyKey: `agenda-delivery-${decision}` },
          })
          .pipe(Effect.provideService(AccessDecisionGate, access), Effect.flip);
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
      const harness = yield* makeActionTestHarness({
        access: 'denied',
        compositionRevision: 'a'.repeat(64),
        ownerRegistration: facilityOperationsRegistration,
      });
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'agenda-denied', idempotencyKey: 'agenda-denied' },
        })
        .pipe(
          Effect.provideService(AccessDecisionGate, { ...makeTestAccessDecision(), decideMany: unused }),
          Effect.flip,
        );
      expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  ),
);
