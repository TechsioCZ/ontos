import type { TaggingCommand, TaggingCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { bindActionTestServices } from '@app/core-runtime/testing/actions';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';

import {
  registeredActionGateway,
  relayActionWrite,
} from '../../../../packages/gateway-principal-verifier/tests/support/registered-action-http.ts';
import { taggingRegistration } from '../../vertical.registration.ts';
import { ACTION_GATEWAY_AUDIENCE } from '../../api/auth/action-principal.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { UpdateTagActionApi } from '../../shared/apis/update-tag-action.ts';
import { DeleteTagActionApi } from '../../shared/apis/delete-tag-action.ts';
import { AssignTagActionApi } from '../../shared/apis/assign-tag-action.ts';
import { UnassignTagActionApi } from '../../shared/apis/unassign-tag-action.ts';
import { TagIdSchema } from '../../shared/apis/records.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { updateTagAction } from '../../src/actions/update-tag.action.ts';
import { deleteTagAction } from '../../src/actions/delete-tag.action.ts';
import { assignTagAction } from '../../src/actions/assign-tag.action.ts';
import { unassignTagAction } from '../../src/actions/unassign-tag.action.ts';
import { applyCommandActionApiLive } from '../../api/apply-command-action-server.ts';
import { updateTagActionApiLive } from '../../api/update-tag-action-server.ts';
import { deleteTagActionApiLive } from '../../api/delete-tag-action-server.ts';
import { assignTagActionApiLive } from '../../api/assign-tag-action-server.ts';
import { unassignTagActionApiLive } from '../../api/unassign-tag-action-server.ts';

export const registrations = [
  applyCommandAction,
  updateTagAction,
  deleteTagAction,
  assignTagAction,
  unassignTagAction,
] as const;

const id = '50000000-0000-4000-8000-000000000001';
const result = { affectedAssignments: 1, revision: 2, tagId: TagIdSchema.make(id) };
const httpApi = HttpApi.make('TaggingApi')
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(UpdateTagActionApi)
  .addHttpApi(DeleteTagActionApi)
  .addHttpApi(AssignTagActionApi)
  .addHttpApi(UnassignTagActionApi);
const handlers = Layer.mergeAll(
  applyCommandActionApiLive,
  updateTagActionApiLive,
  deleteTagActionApiLive,
  assignTagActionApiLive,
  unassignTagActionApiLive,
);
export const makeFixture = (options: Pick<ActionTestHarnessOptions, 'access' | 'mandateDispatch'> = {}) =>
  Effect.gen(function* fixture() {
    const writes: TaggingCommand[] = [];
    const services = {
      apply: (command: TaggingCommand) =>
        Effect.sync(() => {
          writes.push(command);
          return result;
        }),
      loadRecords: () => Effect.die('HTTP writes must not read the records endpoint'),
    };

    const gateway = yield* registeredActionGateway(
      {
        apiMarker: ultramodernApiMarker,
        audience: ACTION_GATEWAY_AUDIENCE,
        ownerRegistration: taggingRegistration,
      },
      {
        services: [
          bindActionTestServices(applyCommandAction, services),
          bindActionTestServices(updateTagAction, services),
          bindActionTestServices(deleteTagAction, services),
          bindActionTestServices(assignTagAction, services),
          bindActionTestServices(unassignTagAction, services),
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
      command: (typeof TaggingCommandPayloadSchema.Encoded)['command'],
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
  { command: { _tag: 'CreateTag', color: 'blue', name: 'New', subjectKinds: ['employee'] }, slug: 'apply-command' },
  { command: { _tag: 'UpdateTag', id, patch: { name: 'Updated' } }, slug: 'update-tag' },
  { command: { _tag: 'DeleteTag', id }, slug: 'delete-tag' },
  { command: { _tag: 'AssignTag', subjects: [{ id: 'employee', kind: 'employee' }], tagId: id }, slug: 'assign-tag' },
  {
    command: { _tag: 'UnassignTag', subjects: [{ id: 'employee', kind: 'employee' }], tagId: id },
    slug: 'unassign-tag',
  },
] as const;
