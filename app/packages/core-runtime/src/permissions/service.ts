/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect's typed callback combinators are not Promise callback chains. */
import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { ActionPermissionCheckError } from '../actions/errors.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';

export const SPICEDB_ACTION_OBJECT_TYPE = 'action';
export const SPICEDB_PRINCIPAL_OBJECT_TYPE = 'principal';
export const SPICEDB_RESTRICTION_PERMISSION = 'is_restricted';
export const SPICEDB_EXECUTE_PERMISSION = 'execute';
export const SPICEDB_CHECK_TIMEOUT_MS = 2000;

/** Losslessly maps dotted Action keys into SpiceDB's restricted object-id alphabet. */
export const toSpiceDbActionObjectId = (actionKey: string): string =>
  `ak_${Buffer.from(actionKey, 'utf-8').toString('base64url')}`;

export type ActionPermissionDecision = 'allowed' | 'denied' | 'unconfigured';

export interface CheckActionPermissionInput {
  readonly actionKey: string;
  readonly correlationId: string;
  readonly principalId: string;
}

export interface ActionPermissionService {
  readonly checkActionPermission: (
    input: CheckActionPermissionInput,
  ) => Effect.Effect<ActionPermissionDecision, ActionPermissionCheckError>;
}

export interface PermissionCheckClient {
  readonly checkPermission: (
    request: v1.CheckPermissionRequest,
  ) => Promise<v1.CheckPermissionResponse>;
  readonly close: () => void;
}

export type PermissionClientFactory = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
) => PermissionCheckClient;

const checkFailure = (): ActionPermissionCheckError =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The authorization service could not determine permission safely',
  });

export const createPermissionCheckClient: PermissionClientFactory = (
  configuration,
  timeoutMilliseconds,
) => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
    undefined,
    { interceptors: [deadlineInterceptor(timeoutMilliseconds)] },
  );

  return {
    checkPermission: (request) => client.promises.checkPermission(request),
    close: () => {
      client.close();
    },
  };
};

export const acquirePermissionClientResource = (
  acquire: () => PermissionCheckClient,
): Effect.Effect<PermissionCheckClient, ActionPermissionCheckError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () => checkFailure(),
      try: acquire,
    }),
    (client) => Effect.sync(() => client.close()),
  );

const fullyConsistent = v1.Consistency.create({
  requirement: {
    fullyConsistent: true,
    oneofKind: 'fullyConsistent',
  },
});

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

const restrictionRequest = (actionKey: string) => {
  const action = actionReference(actionKey);
  return v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: SPICEDB_RESTRICTION_PERMISSION,
    resource: action,
    subject: v1.SubjectReference.create({ object: action }),
  });
};

const executionRequest = (actionKey: string, principalId: string) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: SPICEDB_EXECUTE_PERMISSION,
    resource: actionReference(actionKey),
    subject: principalReference(principalId),
  });

const classifyPermissionship = (
  response: unknown,
): Effect.Effect<'has' | 'none', ActionPermissionCheckError> => {
  if (typeof response !== 'object' || response === null || !('permissionship' in response)) {
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
  Effect.tryPromise({
    catch: () => checkFailure(),
    try: () => client.checkPermission(request),
  }).pipe(Effect.flatMap(classifyPermissionship));

export const makeActionPermissionService = (
  client: PermissionCheckClient,
): ActionPermissionService =>
  Object.freeze({
    checkActionPermission: (input: CheckActionPermissionInput) =>
      Effect.gen(function* checkActionPermissionEffect() {
        const restriction = yield* runCheck(client, restrictionRequest(input.actionKey));
        if (restriction === 'none') {
          return 'unconfigured' as const;
        }

        const execution = yield* runCheck(
          client,
          executionRequest(input.actionKey, input.principalId),
        );
        return execution === 'has' ? ('allowed' as const) : ('denied' as const);
      }).pipe(
        Effect.withSpan('SpiceDB.checkActionPermission', {
          attributes: {
            actionKey: input.actionKey,
            correlationId: input.correlationId,
          },
        }),
      ),
  });

const unavailablePermissionService = (): ActionPermissionService =>
  Object.freeze({
    checkActionPermission: (input: CheckActionPermissionInput) =>
      Effect.fail(checkFailure()).pipe(
        Effect.withSpan('SpiceDB.checkActionPermission', {
          attributes: {
            actionKey: input.actionKey,
            correlationId: input.correlationId,
          },
        }),
      ),
  });

export class ActionPermission extends Context.Service<ActionPermission, ActionPermissionService>()(
  '@app/core-runtime/permissions/service/ActionPermission',
) {}

export const makeActionPermissionLive = (
  clientFactory: PermissionClientFactory = createPermissionCheckClient,
  loadConfiguration: () => Effect.Effect<
    SpiceDbConfigValue,
    SpiceDbConfigError
  > = loadSpiceDbConfig,
): Effect.Effect<ActionPermissionService, never, Scope.Scope> =>
  Effect.matchEffect(loadConfiguration(), {
    onFailure: () => Effect.succeed(unavailablePermissionService()),
    onSuccess: (configuration) =>
      acquirePermissionClientResource(() =>
        clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS),
      ).pipe(
        Effect.map(makeActionPermissionService),
        Effect.catch(() => Effect.succeed(unavailablePermissionService())),
      ),
  });

export const ActionPermissionLive = Layer.effect(ActionPermission, makeActionPermissionLive());
