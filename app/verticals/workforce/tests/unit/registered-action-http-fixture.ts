import { bindActionTestServices } from '@app/core-runtime/testing/actions';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';

import {
  registeredActionGateway,
  relayActionWrite,
} from '../../../../packages/gateway-principal-verifier/tests/support/registered-action-http.ts';

import type { WorkforceCommand, WorkforceCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import type { WorkforceDuplicateEmail } from '../../shared/errors/workforce-duplicate-email.ts';
import { workforceRegistration } from '../../vertical.registration.ts';
import { ACTION_GATEWAY_AUDIENCE } from '../../api/auth/action-principal.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { applyCommandActionApiLive } from '../../api/apply-command-action-server.ts';
import { UpdateEmployeeActionApi } from '../../shared/apis/update-employee-action.ts';
import { updateEmployeeAction } from '../../src/actions/update-employee.action.ts';
import { updateEmployeeActionApiLive } from '../../api/update-employee-action-server.ts';

export const registrations = [applyCommandAction, updateEmployeeAction] as const;

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

    const gateway = yield* registeredActionGateway(
      {
        apiMarker: ultramodernApiMarker,
        audience: ACTION_GATEWAY_AUDIENCE,
        ownerRegistration: workforceRegistration,
      },
      {
        services: [
          bindActionTestServices(applyCommandAction, services),
          bindActionTestServices(updateEmployeeAction, services),
        ],
        ...options,
      },
    );
    const requestContext = yield* Layer.build(gateway.requestLayer);
    const router = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(httpApi).pipe(
            Layer.provide(handlers),
            Layer.provide(gateway.harness.layer),
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
    ) =>
      relayActionWrite(gateway, async (relayed) => await router.handler(relayed, requestContext), {
        body: JSON.stringify({ command, expectedRevision: 1 }),
        intent,
        key,
        path,
      });
    return { ...gateway, request, requestContext, router, writes };
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
