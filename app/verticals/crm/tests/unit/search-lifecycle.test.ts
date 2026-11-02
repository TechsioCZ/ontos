import { ActiveApplicationCompositionService, ContextAccess, ActionAlreadyCommitted } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema, CrmRevisionConflict } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { makeEntityId } from '../../shared/domain/common.ts';
import { companyId, scope } from './search-fixtures.ts';

const unused = () => Effect.die('Unexpected external boundary');
const dependencies = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
  Layer.succeed(ContextAccess, {
    contextPermissions: unused,
    legalEntities: unused,
    modules: unused,
    resources: unused,
    tenants: unused,
  }),
);
const principal = {
  ...scope,
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:crm-search',
  authMethod: 'session' as const,
  legalEntityId: companyId,
};

it.layer(dependencies)('committed search intent', (suite) => {
  suite.effect(
    'each successful owner command atomically queues projection, idempotent replay queues nothing more',
    () =>
      Effect.gen(function* checkCommandLifecycle() {
        const services = {
          apply: () => Effect.succeed({ entityIds: [makeEntityId('contact-1')], revision: 2 }),
          loadAssignmentDirectory: unused,
          loadRecords: unused,
        };
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          services: [bindActionTestServices(applyCommandAction, services)],
        });
        const input = {
          payload: Schema.decodeSync(ApplyCommandPayloadSchema)({
            command: { _tag: 'UpdateClient', id: 'client-1', patch: { name: 'New title' } },
            expectedRevision: 1,
          }),
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'crm-search', idempotencyKey: 'crm-search-command' },
        };
        yield* harness.runtime.runAction(input);
        expect(Schema.is(ActionAlreadyCommitted)(yield* harness.runtime.runAction(input).pipe(Effect.flip))).toBe(true);
        expect(harness.snapshot().committed.length).toBe(1);
        expect(harness.snapshot().committed[0]?.evidence).toMatchObject({
          domainEvents: [{ eventType: 'demo.crm.search-changed.v1', payloadJson: { entityIds: ['contact-1'] } }],
          outboxMessages: [
            { message: { payloadJson: { entityIds: ['contact-1'] }, topic: 'demo.crm.search-changed.v1' } },
          ],
        });
      }),
  );
  suite.effect(
    'rebuild requires explicit execution and tenant identity management, then queues only owner intent',
    () =>
      Effect.gen(function* checkCommandLifecycle() {
        yield* Effect.forEach(
          [false, true],
          (allowed) =>
            Effect.gen(function* checkRebuildPermission() {
              const harness = yield* makeActionTestHarness({
                actionPermission: 'allowed',
                tenantPermission: allowed ? 'allowed' : 'denied',
              });
              const outcome = yield* harness.runtime
                .runAction({
                  payload: {},
                  principal,
                  registration: requestSearchRebuildAction,
                  transport: { correlationId: 'crm-rebuild', idempotencyKey: 'crm-rebuild' },
                })
                .pipe(Effect.exit);
              expect(Exit.isSuccess(outcome)).toBe(allowed);
              expect(harness.snapshot().committed.length).toBe(allowed ? 1 : 0);
              if (allowed) {
                expect(harness.snapshot().committed[0]?.evidence).toMatchObject({
                  outboxMessages: [{ message: { topic: 'demo.crm.search-rebuild-requested.v1' } }],
                });
              }
            }),
          { concurrency: 1, discard: true },
        );
      }),
  );
  suite.effect('failed owner mutation commits no search event or delivery', () =>
    Effect.gen(function* failBeforeSearchIntent() {
      const services = {
        apply: () =>
          Effect.fail(new CrmRevisionConflict({ code: 'crm_revision_conflict', reason: 'Stale CRM revision' })),
        loadAssignmentDirectory: unused,
        loadRecords: unused,
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [bindActionTestServices(applyCommandAction, services)],
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: Schema.decodeSync(ApplyCommandPayloadSchema)({
            command: { _tag: 'UpdateClient', id: 'client-1', patch: { name: 'Not committed' } },
            expectedRevision: 0,
          }),
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'crm-failed-command', idempotencyKey: 'crm-failed-command' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(CrmRevisionConflict)(failure)).toBe(true);
      expect(harness.snapshot().committed).toEqual([]);
    }),
  );
});
