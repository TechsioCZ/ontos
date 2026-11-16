import { ActionPermissionCheckError, ActionPermissionDenied } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema, WorkReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { workTasksRegistration } from '../../vertical.registration.ts';
import { referenceTransportNotUsed } from '../support/reference-transport.ts';
import { WorkReferenceVerifier, prepareWorkCommand } from '../../src/services/persistence.service.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:work-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: { _tag: 'CreateTask', title: 'Kontrola provozu' },
  expectedRevision: 0,
});
for (const access of ['denied', 'unavailable'] as const) {
  it.effect(`the registered canonical Action refuses ${access} before owner SQL`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const harness = yield* makeActionTestHarness({ access, ownerRegistration: workTasksRegistration });
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'work-command', idempotencyKey: `work-command-${access}` },
          })
          .pipe(Effect.flip);
        expect(Schema.is(access === 'denied' ? ActionPermissionDenied : ActionPermissionCheckError)(failure)).toBe(
          true,
        );
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().transactionCount).toBe(0);
      }),
    ).pipe(Effect.provide(referenceTransportNotUsed)),
  );
}
it.effect('cross-owner reference failure stops an admitted Action before SQL opens', () =>
  Effect.scoped(
    Effect.gen(function* test() {
      const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: workTasksRegistration });
      const withReference = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
        command: {
          _tag: 'CreateTask',
          contextRefs: [
            {
              moduleId: 'property.portfolio',
              resourceId: '50000000-0000-4000-8000-000000000001',
              resourceType: 'property.portfolio.property',
              tenantId: principal.tenantId,
            },
          ],
          title: 'Kontrola provozu',
        },
        expectedRevision: 0,
      });
      let verified = false;
      const failure = yield* harness.runtime
        .runAction({
          payload: withReference,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'work-reference', idempotencyKey: 'work-reference' },
        })
        .pipe(
          Effect.provideService(WorkReferenceVerifier, {
            verify: () =>
              Effect.suspend(() => {
                expect(harness.snapshot().transactionCount).toBe(0);
                verified = true;
                return Effect.fail(
                  new WorkReferenceUnavailable({
                    code: 'work_reference_unavailable',
                    reason: 'Reference owner unavailable',
                  }),
                );
              }),
          }),
          Effect.flip,
        );
      expect(Schema.is(WorkReferenceUnavailable)(failure)).toBe(true);
      expect(verified).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  ).pipe(Effect.provide(referenceTransportNotUsed)),
);
it.effect('owner preparation does not re-decide run authority after Core admitted an approval', () =>
  Effect.gen(function* test() {
    // No gate or legacy permission service is provided. Core's mode-sensitive admission is authoritative.
    yield* prepareWorkCommand(payload.command, { ...principal, correlationId: 'approved-command' });
  }).pipe(Effect.provide(referenceTransportNotUsed)),
);
