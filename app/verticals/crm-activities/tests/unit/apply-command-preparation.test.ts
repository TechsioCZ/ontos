import { ActiveApplicationCompositionService, ActionPermissionDenied, ContextAccess } from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { Layer, Effect, Schema } from 'effect';
import type { ContextAccessService } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';

import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  ActivityPermissionDenied,
  ActivityReferenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

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
const unused = () => Effect.die('Unexpected permission adapter');

const accessFor = (decision: 'denied' | 'unavailable', assertOutsideSql: () => void): ContextAccessService => ({
  contextPermissions: ({ targets }) =>
    Effect.sync(() => {
      assertOutsideSql();
      return targets.map(({ moduleId, permission }) => ({ decision, key: `${moduleId}:${permission}` }));
    }),
  legalEntities: unused,
  modules: unused,
  resources: unused,
  tenants: unused,
});

const preparedPermissionTest = (decision: 'denied' | 'unavailable') =>
  Effect.scoped(
    Effect.gen(function* preparedPermissions() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
      let checks = 0;
      const access = accessFor(decision, () => {
        expect(harness.snapshot().transactionCount).toBe(0);
        checks += 1;
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: Schema.encodeSync(ApplyCommandPayloadSchema)(payload),
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'activities-command', idempotencyKey: `activities-command-${decision}` },
        })
        .pipe(Effect.provideService(ContextAccess, access), Effect.flip);
      expect(
        decision === 'denied'
          ? Schema.is(ActivityPermissionDenied)(failure)
          : Schema.is(ActivityReferenceUnavailable)(failure),
      ).toBe(true);
      expect(checks).toBe(1);
      expect(harness.snapshot().committed).toEqual([]);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  );

it.layer(referenceBoundary)('reference boundary is unused on denial', (suite) => {
  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`the registered activities Action prepares ${decision} permissions before SQL`, () =>
      preparedPermissionTest(decision),
    );
  }

  suite.effect('Core executor denial never reaches activities permission preparation', () =>
    Effect.scoped(
      Effect.gen(function* executorDenied() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'denied' });
        const failure = yield* harness.runtime
          .runAction({
            payload: Schema.encodeSync(ApplyCommandPayloadSchema)(payload),
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
});
