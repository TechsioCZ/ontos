import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { ActionAlreadyCommitted, ActiveApplicationCompositionService, ContextAccess } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { workTasksRegistration } from '../../vertical.registration.ts';
import { company, scope } from './search-fixtures.ts';

const principal = {
  ...scope,
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search',
  authMethod: 'session',
  legalEntityId: company,
} as const;
it.effect('rebuild uses its canonical declaration; denial queues no message', () =>
  Effect.gen(function* test() {
    for (const [execution, management] of [
      ['allowed', 'allowed'],
      ['denied', 'allowed'],
      ['allowed', 'denied'],
    ] as const) {
      const harness = yield* makeActionTestHarness({
        access: execution,
        ownerRegistration: workTasksRegistration,
        tenantPermission: management,
      });
      const input = {
        payload: {},
        principal,
        registration: requestSearchRebuildAction,
        transport: { correlationId: 'rebuild', idempotencyKey: 'rebuild-test' },
      };
      const result = yield* harness.runtime.runAction(input).pipe(Effect.exit);
      const allowed = execution === 'allowed';
      expect(Exit.isSuccess(result)).toBe(allowed);
      expect(harness.snapshot().committed).toHaveLength(allowed ? 1 : 0);
      if (allowed) {
        expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toMatchObject([
          { message: { producerModuleKey: 'work.tasks', topic: 'work.tasks.search-rebuild-requested.v1' } },
        ]);
        const replay = yield* harness.runtime.runAction(input).pipe(Effect.flip);
        expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
        expect(harness.snapshot().committed).toHaveLength(1);
      }
    }
  }),
);

const unused = () => Effect.die('Unexpected boundary');
const dependencies = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/search')),
  ),
  Layer.succeed(ContextAccess, {
    contextPermissions: unused,
    legalEntities: unused,
    modules: unused,
    resources: unused,
    tenants: unused,
  }),
);
it.layer(dependencies)('task search lifecycle', (suite) => {
  suite.effect('every successful task edit queues committed search intent once, never on replay', () =>
    Effect.gen(function* test() {
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: workTasksRegistration,
        services: [
          bindActionTestServices(applyCommandAction, {
            apply: () => Effect.succeed({ results: [], revision: 2 }),
            loadRecords: unused,
            submitStorefrontInquiry: unused,
          }),
        ],
      });
      const payload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
        command: {
          _tag: 'ChangeTaskState',
          state: 'DONE',
          taskRef: {
            moduleId: 'work.tasks',
            resourceId: '40000000-0000-4000-8000-000000000001',
            resourceType: 'work.tasks.task',
            tenantId: scope.tenantId,
          },
        },
        expectedRevision: 1,
      });
      const input = {
        payload,
        principal,
        registration: applyCommandAction,
        transport: { correlationId: 'task-update', idempotencyKey: 'task-update' },
      };
      yield* harness.runtime.runAction(input);
      expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toMatchObject([
        { message: { topic: 'work.tasks.search-refresh-requested.v1' } },
      ]);
      const replay = yield* harness.runtime.runAction(input).pipe(Effect.flip);
      expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
      expect(harness.snapshot().committed).toHaveLength(1);
    }),
  );
});
