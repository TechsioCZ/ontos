import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer, Predicate, Schema } from 'effect';
import type { Scope } from 'effect';

import type { ActionTransportMetadata } from '../actions/context.ts';
import { ActionPermissionCheckError } from '../actions/errors.ts';
import { decideAuthorizationRollout } from '../authorization/rollout-decision.ts';
import type {
  AuthorizationRolloutDecisionOptions,
  AuthorizationWouldDenyEvent,
} from '../authorization/rollout-decision.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  acquireSpiceDbClientResource,
  createSpiceDbPermissionClient,
  fullyConsistent,
} from './client.ts';
import type { SpiceDbPermissionClient } from './client.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';

export { SPICEDB_CHECK_TIMEOUT_MS } from './client.ts';

export const SPICEDB_ACTION_OBJECT_TYPE = 'action';
export const SPICEDB_PRINCIPAL_OBJECT_TYPE = 'principal';
export const SPICEDB_RESTRICTION_PERMISSION = 'is_restricted';
export const SPICEDB_EXECUTE_PERMISSION = 'execute';

/** Losslessly maps dotted Action keys into SpiceDB's restricted object-id alphabet. */
export const toSpiceDbActionObjectId = (actionKey: string): string =>
  `ak_${Buffer.from(actionKey, 'utf-8').toString('base64url')}`;

const ActionPermissionDecisionSchema = Schema.Literals(['allowed', 'denied']);
export type ActionPermissionDecision = typeof ActionPermissionDecisionSchema.Type;

interface ActionPermissionTargetInput {
  readonly actionKey: string;
  readonly principalId: string;
}

export type CheckActionPermissionInput = Readonly<
  ActionPermissionTargetInput & Pick<ActionTransportMetadata, 'correlationId'>
>;

export interface ActionPermissionService {
  readonly checkActionPermission: (
    input: CheckActionPermissionInput,
  ) => Effect.Effect<ActionPermissionDecision, ActionPermissionCheckError>;
}

export type PermissionCheckClient = Pick<SpiceDbPermissionClient, 'checkPermission' | 'close'>;

export type PermissionClientFactory = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
) => PermissionCheckClient;

const attachCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });

const checkFailure = (cause?: unknown): ActionPermissionCheckError =>
  attachCause(
    new ActionPermissionCheckError({
      code: 'action_permission_check_failed',
      reason: 'The authorization service could not determine permission safely',
    }),
    cause,
  );

export const createPermissionCheckClient: PermissionClientFactory = (configuration, timeoutMilliseconds) =>
  createSpiceDbPermissionClient(configuration, timeoutMilliseconds) satisfies SpiceDbPermissionClient;

export const acquirePermissionClientResource = (
  acquire: () => PermissionCheckClient,
): Effect.Effect<PermissionCheckClient, ActionPermissionCheckError, Scope.Scope> =>
  acquireSpiceDbClientResource(acquire, checkFailure);

const actionReference = (actionKey: string) =>
  v1.ObjectReference.create({
    objectId: toSpiceDbActionObjectId(actionKey),
    objectType: SPICEDB_ACTION_OBJECT_TYPE,
  });

const principalReference = (principalId: string) =>
  v1.SubjectReference.create({
    object: v1.ObjectReference.create({
      objectId: principalId,
      objectType: SPICEDB_PRINCIPAL_OBJECT_TYPE,
    }),
  });

const executionRequest = (actionKey: string, principalId: string) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: SPICEDB_EXECUTE_PERMISSION,
    resource: actionReference(actionKey),
    subject: principalReference(principalId),
  });

const restrictionRequest = (actionKey: string, principalId: string) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: SPICEDB_RESTRICTION_PERMISSION,
    resource: actionReference(actionKey),
    subject: principalReference(principalId),
  });

const classifyPermissionship = <Response>(
  response: Response,
): Effect.Effect<'has' | 'none', ActionPermissionCheckError> => {
  if (!Predicate.isObjectKeyword(response) || response === null || !('permissionship' in response)) {
    return Effect.fail(checkFailure());
  }

  const { permissionship } = response;
  if (permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
    return Effect.succeed('has');
  }
  if (permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
    return Effect.succeed('none');
  }
  return Effect.fail(checkFailure());
};

const runCheck = (
  client: PermissionCheckClient,
  request: v1.CheckPermissionRequest,
): Effect.Effect<'has' | 'none', ActionPermissionCheckError> =>
  client.checkPermission(request).pipe(Effect.mapError(checkFailure), Effect.flatMap(classifyPermissionship));

interface ActionPermissionRolloutOptions {
  readonly emit: (event: AuthorizationWouldDenyEvent) => void;
  readonly nowEpochMs: () => number;
  readonly rollout: AuthorizationRolloutDecisionOptions['contract'];
}

type PermissionRollout = ActionPermissionRolloutOptions;

const actionPermissionService = (
  client: PermissionCheckClient,
  rolloutOptions?: PermissionRollout,
): ActionPermissionService =>
  Object.freeze({
    checkActionPermission: Effect.fn('ActionPermission.checkActionPermission')(function* checkActionPermissionEffect(
      input: CheckActionPermissionInput,
    ) {
      const execution = yield* runCheck(client, executionRequest(input.actionKey, input.principalId));
      if (execution === 'has') {
        return 'allowed' as const;
      }
      if (rolloutOptions === undefined) {
        return 'denied' as const;
      }
      const restricted = yield* runCheck(client, restrictionRequest(input.actionKey, input.principalId));
      if (restricted === 'has') {
        return 'denied' as const;
      }
      return yield* Effect.try({
        catch: (cause) => checkFailure(cause),
        try: () =>
          decideAuthorizationRollout(
            {
              candidate: 'denied',
              current: 'allowed',
              denialReason: 'missing_policy',
              entrypointKey: input.actionKey,
              nowEpochMs: rolloutOptions.nowEpochMs(),
              policyClass: 'action_execution',
              surface: 'action',
            },
            { contract: rolloutOptions.rollout, emit: rolloutOptions.emit },
          ),
      });
    }),
  });

export const makeActionPermissionService = actionPermissionService;

const unavailablePermissionService = (cause?: unknown): ActionPermissionService =>
  Object.freeze({
    checkActionPermission: Effect.fn('ActionPermission.checkActionPermission')(
      function* unavailableCheckActionPermissionEffect() {
        return yield* checkFailure(cause);
      },
    ),
  });

export class ActionPermission extends Context.Service<ActionPermission, ActionPermissionService>()(
  '@app/core-runtime/permissions/service/ActionPermission',
) {}

export const makeActionPermissionLive = (
  clientFactory: PermissionClientFactory = createPermissionCheckClient,
  loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> = loadSpiceDbConfig,
): Effect.Effect<ActionPermissionService, never, Scope.Scope> =>
  Effect.matchEffect(loadConfiguration(), {
    onFailure: (cause) => Effect.succeed(unavailablePermissionService(cause)),
    onSuccess: (configuration) =>
      acquirePermissionClientResource(() => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS)).pipe(
        Effect.map(makeActionPermissionService),
        Effect.catchTag('ActionPermissionCheckError', (cause) => Effect.succeed(unavailablePermissionService(cause))),
      ),
  });

export const ActionPermissionLive = Layer.effect(ActionPermission, makeActionPermissionLive());
