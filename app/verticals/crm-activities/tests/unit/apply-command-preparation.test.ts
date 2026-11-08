import { ActivityReferenceVerifier, prepareActivityCommand } from '../../src/services/persistence.service.ts';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { crmActivitiesRegistration } from '../../vertical.registration.ts';
import { ActiveApplicationCompositionService } from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';

const unusedReference = () => Effect.die('Unexpected reference boundary access');
const referenceBoundary = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unusedReference() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unusedReference() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
);

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:activities-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: {
    _tag: 'RecordActivity',
    kind: 'CALL',
    occurredAt: '2026-11-02T00:00:00Z',
    ownerPrincipalRef: { principalId: principal.principalId, tenantId: principal.tenantId },
    partyRef: {
      moduleId: 'party.registry',
      resourceId: 'regression-party',
      resourceType: 'party.registry.party',
      tenantId: principal.tenantId,
    },
    summary: 'Regresní test',
  },
  expectedRevision: 0,
});

const commands = [payload];
for (const [index, command] of commands.entries()) {
  for (const access of ['denied', 'unavailable'] as const) {
    it.effect(`registered crm-activities command ${index} refuses ${access} before owner SQL`, () =>
      Effect.scoped(
        Effect.gen(function* refusesBeforeSql() {
          const harness = yield* makeActionTestHarness({ access, ownerRegistration: crmActivitiesRegistration });
          const failure = yield* harness.runtime
            .runAction({
              payload: Schema.encodeSync(ApplyCommandPayloadSchema)(command),
              principal,
              registration: applyCommandAction,
              transport: {
                correlationId: 'crm-activities-command',
                idempotencyKey: `crm-activities-${index}-${access}`,
              },
            })
            .pipe(Effect.flip);
          expect(failure._tag).toBe(access === 'denied' ? 'ActionPermissionDenied' : 'ActionPermissionCheckError');
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().committed).toEqual([]);
        }),
      ).pipe(Effect.provide(referenceBoundary)),
    );
  }
}

it.effect('owner reference preparation does not re-decide run after Core admits an approval', () =>
  Effect.gen(function* test() {
    const { partyRef } = payload.command;
    if (partyRef === undefined) {
      return yield* Effect.die('Fixture must identify its Party');
    }
    const canonical = yield* prepareActivityCommand(payload.command, {
      ...principal,
      correlationId: 'approved-activity',
    }).pipe(Effect.provideService(ActivityReferenceVerifier, { verify: () => Effect.succeed({ partyRef }) }));
    expect(canonical.partyRef).toEqual(partyRef);
    return canonical;
  }).pipe(Effect.provide(referenceBoundary)),
);
