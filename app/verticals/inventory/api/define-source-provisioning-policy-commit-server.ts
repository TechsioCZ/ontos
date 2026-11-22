import { ActionRuntime, readVerifiedGatewayActor } from '@app/core-runtime';
import {
  readVerifiedGatewayRouteScope,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Redacted } from 'effect';
import type { HttpServerRequest } from 'effect/http';

import { inventoryApi } from '../shared/api.ts';
import type { ResolveSourceProvisioningPolicyCommitRequest } from '../shared/apis/define-source-provisioning-policy-action.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';
import { defineSourceProvisioningPolicyAction } from '../src/actions/define-source-provisioning-policy.action.ts';
import {
  defineSourceProvisioningPolicyActionProblem,
  defineSourceProvisioningPolicyActionSchemaErrorLive,
} from './define-source-provisioning-policy-action-problems.ts';

const resolveCommit = Effect.fn('DefineSourceProvisioningPolicyActionServer.resolveCommit')(function* resolveCommit(
  payload: ResolveSourceProvisioningPolicyCommitRequest,
  request: HttpServerRequest.HttpServerRequest,
) {
  const problem = defineSourceProvisioningPolicyActionProblem;
  const correlationId = request.headers['x-correlation-id'];
  if (correlationId === undefined || correlationId.trim().length === 0 || correlationId.length > 200) {
    return yield* Effect.fail(problem.invalid());
  }
  const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
    authentication: problem.authentication,
    unavailable: () => problem.unavailable('operation_context_unavailable'),
  });
  if (
    principal.authMethod === 'system' ||
    (principal.authenticationNamespaceId !== undefined &&
      principal.authenticationNamespaceId !== STAFF_AUTHENTICATION_NAMESPACE_ID) ||
    readVerifiedGatewayActor(principal) !== undefined ||
    readVerifiedGatewayRouteScope(principal) !== undefined ||
    readVerifiedGatewayWorkload(principal) !== undefined ||
    principal.legalEntityId !== undefined
  ) {
    return yield* Effect.fail(problem.forbidden('operation_context_denied'));
  }
  const runtime = yield* ActionRuntime;
  return yield* runtime
    .resolveActionCommit({
      expectedActionKey: defineSourceProvisioningPolicyAction.descriptor.actionKey,
      invocationId: payload.invocationId,
      principal,
    })
    .pipe(
      Effect.map((open) => ({ ...open, retryCommand: true as const })),
      Effect.catchTags({
        ActionAlreadyCommitted: (error) => Effect.fail(problem.alreadyCommitted(error.invocationId)),
        ActionCommitIndeterminate: (error) => Effect.fail(problem.indeterminate(error.invocationId)),
        ActionInvocationNotFound: (error) => Effect.fail(problem.notFound(error.code)),
        ActionInvocationStateError: (error) => Effect.fail(problem.conflict(error.code)),
        ActionPayloadValidationError: () => Effect.fail(problem.invalid()),
        ActionTrustedContextValidationError: () => Effect.fail(problem.authentication()),
      }),
    );
});

export const defineSourceProvisioningPolicyCommitApiLive = HttpApiBuilder.group(
  inventoryApi,
  'defineSourceProvisioningPolicyCommit',
  (handlers) => handlers.handle('resolveCommit', ({ payload, request }) => resolveCommit(payload, request)),
).pipe(Layer.provide(defineSourceProvisioningPolicyActionSchemaErrorLive));
