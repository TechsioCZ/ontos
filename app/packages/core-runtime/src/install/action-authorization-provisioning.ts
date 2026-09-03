/* eslint-disable promise/prefer-await-to-callbacks -- Authzed exposes Promise APIs contained by Effect. */
import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { fullyConsistent } from '../permissions/client.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../permissions/schema.ts';
import { toSpiceDbActionObjectId } from '../permissions/service.ts';

export const ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000019';

export interface ActionAuthorizationContext {
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ActionAuthorizationProvisioningInput {
  readonly actions: readonly ActionAuthorizationProvisioningAction[];
  readonly contexts: readonly ActionAuthorizationContext[];
  readonly deniedPrincipalId?: string;
}

export interface ActionAuthorizationProvisioningAction {
  readonly actionKey: string;
  readonly provisioning: 'explicit' | 'tenant_membership_default';
}

export interface ActionAuthorizationProvisioningResult {
  readonly actionCount: number;
  readonly grantCount: number;
  readonly tenantCount: number;
}

export interface ActionAuthorizationProvisioningClient {
  readonly checkPermission: (
    request: v1.CheckPermissionRequest,
  ) => Promise<v1.CheckPermissionResponse | undefined>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Promise<v1.WriteRelationshipsResponse>;
  readonly writeSchema: (request: v1.WriteSchemaRequest) => Promise<v1.WriteSchemaResponse>;
}

export class ActionAuthorizationProvisioningError extends Schema.TaggedError<ActionAuthorizationProvisioningError>()(
  'ActionAuthorizationProvisioningError',
  {
    code: Schema.Literals([
      'action_authorization_configuration_invalid',
      'action_authorization_discovery_failed',
      'action_authorization_input_invalid',
      'action_authorization_membership_missing',
      'action_authorization_service_unavailable',
      'action_authorization_verification_failed',
    ]),
    reason: Schema.String,
  },
) {}

const failure = (
  code: ActionAuthorizationProvisioningError['code'],
  reason: string,
): ActionAuthorizationProvisioningError =>
  new ActionAuthorizationProvisioningError({ code, reason });

const assertProvisioningInput = (input: ActionAuthorizationProvisioningInput) => {
  const actions = input.actions.toSorted((left, right) =>
    left.actionKey.localeCompare(right.actionKey),
  );
  const actionKeys = actions.map(({ actionKey }) => actionKey);
  const contexts = input.contexts.toSorted((left, right) =>
    left.tenantId.localeCompare(right.tenantId),
  );
  if (
    actions.length === 0 ||
    actionKeys.some((actionKey) => actionKey.length === 0 || actionKey.length > 256) ||
    new Set(actionKeys).size !== actionKeys.length ||
    actions.some(
      ({ provisioning }) =>
        provisioning !== 'tenant_membership_default' && provisioning !== 'explicit',
    )
  ) {
    throw failure(
      'action_authorization_input_invalid',
      'Current Action discovery must produce a non-empty unique set',
    );
  }
  if (
    contexts.length === 0 ||
    contexts.some(
      ({ principalId, tenantId }) => principalId.length === 0 || tenantId.length === 0,
    ) ||
    new Set(contexts.map(({ tenantId }) => tenantId)).size !== contexts.length
  ) {
    throw failure(
      'action_authorization_input_invalid',
      'Authorization provisioning requires unique fixed Tenant contexts',
    );
  }
  const deniedPrincipalId = input.deniedPrincipalId ?? ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
  if (
    deniedPrincipalId.length === 0 ||
    contexts.some(({ principalId }) => principalId === deniedPrincipalId)
  ) {
    throw failure(
      'action_authorization_input_invalid',
      'The denied verification Principal must be outside the fixed context set',
    );
  }
  return { actions, contexts, deniedPrincipalId };
};

const tenantAccessRequest = (context: ActionAuthorizationContext) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: 'access',
    resource: v1.ObjectReference.create({ objectId: context.tenantId, objectType: 'tenant' }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: context.principalId,
        objectType: 'principal',
      }),
    }),
  });

const actionExecuteRequest = (actionKey: string, principalId: string) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: 'execute',
    resource: v1.ObjectReference.create({
      objectId: toSpiceDbActionObjectId(actionKey),
      objectType: 'action',
    }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }),
    }),
  });

export const buildActionAuthorizationRelationships = (
  actionKeys: readonly string[],
  contexts: readonly ActionAuthorizationContext[],
): readonly v1.Relationship[] =>
  contexts
    .flatMap(({ tenantId }) =>
      actionKeys.map((actionKey) =>
        v1.Relationship.create({
          relation: 'executor',
          resource: v1.ObjectReference.create({
            objectId: toSpiceDbActionObjectId(actionKey),
            objectType: 'action',
          }),
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({ objectId: tenantId, objectType: 'tenant' }),
            optionalRelation: 'member',
          }),
        }),
      ),
    )
    .toSorted((left, right) => {
      const leftKey = `${left.resource?.objectId ?? ''}:${left.subject?.object?.objectId ?? ''}`;
      const rightKey = `${right.resource?.objectId ?? ''}:${right.subject?.object?.objectId ?? ''}`;
      return leftKey.localeCompare(rightKey);
    });

const serviceFailure = (): ActionAuthorizationProvisioningError =>
  failure(
    'action_authorization_service_unavailable',
    'The authorization service could not provision current Action rules safely',
  );

const callClient = <Value>(operation: () => Promise<Value>) =>
  Effect.tryPromise({ catch: serviceFailure, try: operation });

const checkHasPermission = (
  client: ActionAuthorizationProvisioningClient,
  request: v1.CheckPermissionRequest,
  error: ActionAuthorizationProvisioningError,
) =>
  callClient(() => client.checkPermission(request)).pipe(
    Effect.flatMap((response) =>
      response?.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
        ? Effect.void
        : Effect.fail(error),
    ),
  );

const checkNoPermission = (
  client: ActionAuthorizationProvisioningClient,
  request: v1.CheckPermissionRequest,
) =>
  callClient(() => client.checkPermission(request)).pipe(
    Effect.flatMap((response) =>
      response?.permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION
        ? Effect.void
        : Effect.fail(
            failure(
              'action_authorization_verification_failed',
              'The representative non-member authorization check did not deny',
            ),
          ),
    ),
  );

export const provisionActionAuthorization = (
  client: ActionAuthorizationProvisioningClient,
  input: ActionAuthorizationProvisioningInput,
): Effect.Effect<ActionAuthorizationProvisioningResult, ActionAuthorizationProvisioningError> =>
  Effect.gen(function* provisionActionAuthorizationEffect() {
    const { actions, contexts, deniedPrincipalId } = yield* Effect.try({
      catch: (error) =>
        Schema.is(ActionAuthorizationProvisioningError)(error) ? error : serviceFailure(),
      try: () => assertProvisioningInput(input),
    });

    yield* callClient(() =>
      client.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
    );

    for (const context of contexts) {
      yield* checkHasPermission(
        client,
        tenantAccessRequest(context),
        failure(
          'action_authorization_membership_missing',
          'A fixed provisioning Principal is not an active member of its Tenant',
        ),
      );
    }

    const defaultActionKeys = actions
      .filter(({ provisioning }) => provisioning === 'tenant_membership_default')
      .map(({ actionKey }) => actionKey);
    const relationships = buildActionAuthorizationRelationships(defaultActionKeys, contexts);
    yield* callClient(() =>
      client.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((relationship) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship,
            }),
          ),
        }),
      ),
    );

    for (const context of contexts) {
      for (const { actionKey } of actions) {
        yield* checkHasPermission(
          client,
          actionExecuteRequest(actionKey, context.principalId),
          failure(
            'action_authorization_verification_failed',
            'An expected fixed Tenant Action grant did not verify',
          ),
        );
      }
    }
    const [representativeAction] = actions.map(({ actionKey }) => actionKey);
    if (representativeAction === undefined) {
      return yield* failure(
        'action_authorization_input_invalid',
        'Current Action discovery must not be empty',
      );
    }
    yield* checkNoPermission(client, actionExecuteRequest(representativeAction, deniedPrincipalId));

    return {
      actionCount: actions.length,
      grantCount: relationships.length,
      tenantCount: contexts.length,
    };
  });
