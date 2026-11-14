import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import type { TaggingCommand, TaggingCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { TrustedPrincipalContextSchema, GatewayAssertionRedemptionService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Clock, Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';
import { rstest } from 'effect-rstest';
import { taggingRegistration } from '../../vertical.registration.ts';
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

// Authentication is an external port here. The real HTTP endpoint, payload decoder, owner binding,
// canonical gate, handler, invocation repository and commit evidence all remain in the test.
rstest.mock('../../api/auth/action-principal.ts', () => ({
  authenticateOperationPrincipal: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:tagging-http',
        authMethod: 'session',
        legalEntityId: '30000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000001',
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    ),
}));

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

    const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: taggingRegistration });
    const compositionRevision = owner.snapshot.composition.revision;
    const clock = yield* Clock.Clock;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      applicationComposition: owner.applicationComposition,
      expectedDeployment: owner.expectedDeployment,
      ownerRegistration: taggingRegistration,
      services: [
        bindActionTestServices(applyCommandAction, services),
        bindActionTestServices(updateTagAction, services),
        bindActionTestServices(deleteTagAction, services),
        bindActionTestServices(assignTagAction, services),
        bindActionTestServices(unassignTagAction, services),
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
      command: (typeof TaggingCommandPayloadSchema.Encoded)['command'],
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
  { command: { _tag: 'CreateTag', color: 'blue', name: 'New', subjectKinds: ['employee'] }, slug: 'apply-command' },
  { command: { _tag: 'UpdateTag', id, patch: { name: 'Updated' } }, slug: 'update-tag' },
  { command: { _tag: 'DeleteTag', id }, slug: 'delete-tag' },
  { command: { _tag: 'AssignTag', subjects: [{ id: 'employee', kind: 'employee' }], tagId: id }, slug: 'assign-tag' },
  {
    command: { _tag: 'UnassignTag', subjects: [{ id: 'employee', kind: 'employee' }], tagId: id },
    slug: 'unassign-tag',
  },
] as const;
