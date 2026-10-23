import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import type { Scope } from 'effect';

import type { ActionTransportMetadata } from '../actions/context.ts';
import { ActionPermissionCheckError } from '../actions/errors.ts';
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
export const SPICEDB_EXECUTE_PERMISSION = 'execute';
export const SPICEDB_PROPOSE_PERMISSION = 'propose';

/** Only the trusted operational scope may select an Action authorization object. */
export interface ScopedActionIdentity {
  readonly actionKey: string;
  readonly legalEntityId?: string;
  readonly tenantId: string;
}

const encodeScopedActionIdentity = Schema.encodeResult(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.OptionFromNullOr(Schema.String), Schema.String])),
);

/** Exact tuple encoding: no global identity, scope fallback, or dual authorization check. */
export const toSpiceDbActionObjectId = ({ actionKey, legalEntityId, tenantId }: ScopedActionIdentity): string =>
  `ak_${Buffer.from(Result.getOrThrow(encodeScopedActionIdentity([tenantId, Option.fromUndefinedOr(legalEntityId), actionKey])), 'utf-8').toString('base64url')}`;

/** Grant policy survives module uninstall; only the installed Action's links are reconciled. */
export const toSpiceDbActionGrantObjectId = ({ actionKey, legalEntityId, tenantId }: ScopedActionIdentity): string =>
  `ag_${Buffer.from(Result.getOrThrow(encodeScopedActionIdentity([tenantId, Option.fromUndefinedOr(legalEntityId), actionKey])), 'utf-8').toString('base64url')}`;

const ActionPermissionDecisionSchema = Schema.Literals(['allowed', 'denied']);
export type ActionPermissionDecision = typeof ActionPermissionDecisionSchema.Type;

export interface ActionPermissionTargetInput extends ScopedActionIdentity {
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

export const checkFailure = (cause?: unknown): ActionPermissionCheckError =>
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

export const actionReference = (identity: ScopedActionIdentity) =>
  v1.ObjectReference.create({
    objectId: toSpiceDbActionObjectId(identity),
    objectType: SPICEDB_ACTION_OBJECT_TYPE,
  });

export const principalReference = (principalId: string) =>
  v1.SubjectReference.create({
    object: v1.ObjectReference.create({
      objectId: principalId,
      objectType: SPICEDB_PRINCIPAL_OBJECT_TYPE,
    }),
  });

const executionRequest = (input: CheckActionPermissionInput) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: SPICEDB_EXECUTE_PERMISSION,
    resource: actionReference(input),
    subject: principalReference(input.principalId),
  });

export const classifyPermissionship = <Response>(
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

export const runCheck = (
  client: PermissionCheckClient,
  request: v1.CheckPermissionRequest,
): Effect.Effect<'has' | 'none', ActionPermissionCheckError> =>
  client.checkPermission(request).pipe(Effect.mapError(checkFailure), Effect.flatMap(classifyPermissionship));

export const makeActionPermissionService = (client: PermissionCheckClient): ActionPermissionService =>
  Object.freeze({
    checkActionPermission: Effect.fn('ActionPermission.checkActionPermission')(function* checkActionPermissionEffect(
      input: CheckActionPermissionInput,
    ) {
      const execution = yield* runCheck(client, executionRequest(input));
      return execution === 'has' ? ('allowed' as const) : ('denied' as const);
    }),
  });

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
