import { crmRegistration } from '../../vertical.registration.ts';
import { ActionPermissionDenied, ActiveApplicationCompositionService } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { Layer, Effect, Schema } from 'effect';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';

import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { CrmPermissionDenied } from '../../shared/errors/crm-permission-denied.ts';
import { CrmReferenceUnavailable } from '../../shared/errors/crm-reference-unavailable.ts';

const unusedReference = () => Effect.die('Unexpected reference boundary access');
const referenceBoundary = Layer.mergeAll(
  makeTestAccessGateLayers(),
  Layer.succeed(ActiveApplicationCompositionService, { load: unusedReference() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unusedReference() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
);

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:crm-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: {
    _tag: 'UpdateClient',
    id: 'client-regression',
    patch: { name: 'Regresní test' },
  },
  expectedRevision: 0,
});
const unused = () => Effect.die('Unexpected permission adapter');

const accessFor = (decision: 'denied' | 'unavailable', assertOutsideSql: () => void) => {
  const gate = makeTestAccessDecision({ defaultAnswer: { outcome: decision === 'denied' ? 'DENIED' : 'UNAVAILABLE' } });
  return {
    ...gate,
    decideMany: (questions: Parameters<typeof gate.decideMany>[0]) =>
      Effect.sync(assertOutsideSql).pipe(Effect.andThen(gate.decideMany(questions))),
  };
};

const preparedPermissionTest = (decision: 'denied' | 'unavailable') =>
  Effect.scoped(
    Effect.gen(function* preparedPermissions() {
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        compositionRevision: 'a'.repeat(64),
        ownerRegistration: crmRegistration,
      });
      let checks = 0;
      const access = accessFor(decision, () => {
        expect(harness.snapshot().transactionCount).toBe(0);
        checks += 1;
      });
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'crm-command', idempotencyKey: `crm-command-${decision}` },
        })
        .pipe(Effect.provideService(AccessDecisionGate, access), Effect.flip);
      expect(Schema.is(decision === 'denied' ? CrmPermissionDenied : CrmReferenceUnavailable)(failure)).toBe(true);
      expect(checks).toBe(1);
      expect(harness.snapshot().committed).toEqual([]);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  );

it.layer(referenceBoundary)('reference boundary is unused on denial', (suite) => {
  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`the registered crm Action prepares ${decision} permissions before SQL`, () =>
      preparedPermissionTest(decision),
    );
  }

  suite.effect('Core executor denial never reaches crm permission preparation', () =>
    Effect.scoped(
      Effect.gen(function* executorDenied() {
        const harness = yield* makeActionTestHarness({
          access: 'denied',
          compositionRevision: 'a'.repeat(64),
          ownerRegistration: crmRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'work-denied', idempotencyKey: 'work-denied' },
          })
          .pipe(
            Effect.provideService(AccessDecisionGate, {
              ...makeTestAccessDecision(),
              decideMany: unused,
              list: unused,
            }),
            Effect.flip,
          );
        expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
      }),
    ),
  );
});
