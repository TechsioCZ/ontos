import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { TrustedPrincipalContextSchema, GatewayAssertionRedemptionService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Clock, Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';
import { rstest } from 'effect-rstest';

import type { WorkforceCommand, WorkforceCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import type { WorkforceDuplicateEmail } from '../../shared/errors/workforce-duplicate-email.ts';
import { workforceRegistration } from '../../vertical.registration.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { applyCommandActionApiLive } from '../../api/apply-command-action-server.ts';
import { UpdateEmployeeActionApi } from '../../shared/apis/update-employee-action.ts';
import { updateEmployeeAction } from '../../src/actions/update-employee.action.ts';
import { updateEmployeeActionApiLive } from '../../api/update-employee-action-server.ts';
// Authentication is an external port here. The real HTTP endpoint, payload decoder, owner binding,
// canonical gate, handler, invocation repository and commit evidence all remain in the test.
rstest.mock('../../api/auth/action-principal.ts', () => ({
  authenticateOperationPrincipal: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:workforce-http',
        authMethod: 'session',
        legalEntityId: '30000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000001',
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    ),
}));

const id = '50000000-0000-4000-8000-000000000001';
const result = { employees: [], revision: 2 };
const httpApi = HttpApi.make('WorkforceApi').addHttpApi(ApplyCommandActionApi).addHttpApi(UpdateEmployeeActionApi);
const handlers = Layer.mergeAll(applyCommandActionApiLive, updateEmployeeActionApiLive);
export const makeFixture = (
  options: Pick<ActionTestHarnessOptions, 'access' | 'mandateDispatch'> = {},
  failure?: WorkforceDuplicateEmail,
) =>
  Effect.gen(function* fixture() {
    const writes: WorkforceCommand[] = [];
    const services = {
      apply: (command: WorkforceCommand) =>
        failure === undefined
          ? Effect.sync(() => {
              writes.push(command);
              return result;
            })
          : Effect.fail(failure),
      loadRecords: () => Effect.die('HTTP writes must not read the records endpoint'),
    };

    const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: workforceRegistration });
    const compositionRevision = owner.snapshot.composition.revision;
    const clock = yield* Clock.Clock;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      applicationComposition: owner.applicationComposition,
      expectedDeployment: owner.expectedDeployment,
      ownerRegistration: workforceRegistration,
      services: [
        bindActionTestServices(applyCommandAction, services),
        bindActionTestServices(updateEmployeeAction, services),
      ],
      ...options,
    });
    const requestContext = yield* Layer.build(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(Clock.Clock, clock),
        Layer.succeed(ActiveApplicationCompositionService, owner.applicationComposition),
        Layer.mock(GatewayAssertionRedemptionService, {}),
        Layer.mock(GatewayPrincipalVerifierConfiguration, {}),
      ),
    );
    const router = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(httpApi).pipe(
            Layer.provide(handlers),
            Layer.provide(harness.layer),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (value) => Effect.promise(async () => await value.dispose()),
    );
    const request = (
      path: string,
      command: (typeof WorkforceCommandPayloadSchema.Encoded)['command'],
      key: string,
      intent?: 'propose',
    ) => {
      const headers = new Headers({
        authorization: 'Bearer fixture',
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-composition-revision': compositionRevision,
        'x-correlation-id': key,
      });
      if (intent !== undefined) {
        headers.set('x-action-intent', intent);
      }
      return Effect.promise(
        async () =>
          await router.handler(
            new Request(`https://owner.test${path}`, {
              body: JSON.stringify({ command, expectedRevision: 1 }),
              headers,
              method: 'POST',
            }),
            requestContext,
          ),
      );
    };
    return { compositionRevision, harness, request, requestContext, router, writes };
  });

export const cases = [
  {
    command: {
      _tag: 'CreateEmployee',
      active: true,
      department: 'Provoz',
      email: 'owner@example.test',
      fullName: 'Owner fixture',
      id,
      role: 'SALES_REP',
    },
    slug: 'apply-command',
  },
  { command: { _tag: 'UpdateEmployee', id, patch: { department: 'Provoz' } }, slug: 'update-employee' },
  {
    command: {
      _tag: 'BulkUpdateEmployees',
      ids: [id, '50000000-0000-4000-8000-000000000002'],
      patch: { active: false },
    },
    slug: 'update-employee',
  },
] as const;
