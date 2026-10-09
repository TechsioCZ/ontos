import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Schema } from 'effect';

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
  readonly explicitActionAssertions?: readonly ActionAuthorizationExplicitAssertionSet[];
  readonly explicitActionGrants?: readonly ActionAuthorizationExplicitGrant[];
}

/** A narrow direct-Principal executor grant for one `explicit` Action. */
export interface ActionAuthorizationExplicitGrant {
  readonly actionKey: string;
  readonly principalIds: readonly string[];
}

/**
 * One fixed account's explicit Action grant data: the `explicit` Action keys it executes, or `'all'`
 * for every current `explicit` Action.
 */
export interface ActionAuthorizationExplicitAccountGrant {
  readonly explicitActions: 'all' | readonly string[];
  readonly principalId: string;
}

/** Per-Action assertions and direct grants expanded from per-account grant data. */
export interface ActionAuthorizationExplicitDerivation {
  readonly explicitActionAssertions: readonly ActionAuthorizationExplicitAssertionSet[];
  readonly explicitActionGrants: readonly ActionAuthorizationExplicitGrant[];
}

interface ActionAuthorizationExplicitAssertionSet {
  readonly actionKey: string;
  readonly assertions: readonly {
    readonly expected: 'allowed' | 'denied';
    readonly principalId: string;
  }[];
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
  ) => Effect.Effect<Option.Option<v1.CheckPermissionResponse>, Error>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, Error>;
  readonly writeSchema: (request: v1.WriteSchemaRequest) => Effect.Effect<v1.WriteSchemaResponse, Error>;
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
): ActionAuthorizationProvisioningError => new ActionAuthorizationProvisioningError({ code, reason });

const hasInvalidActions = (actions: readonly ActionAuthorizationProvisioningAction[]): boolean => {
  const actionKeys = actions.map(({ actionKey }) => actionKey);
  return (
    actions.length === 0 ||
    actionKeys.some((actionKey) => actionKey.length === 0 || actionKey.length > 256) ||
    new Set(actionKeys).size !== actionKeys.length ||
    actions.some(({ provisioning }) => provisioning !== 'tenant_membership_default' && provisioning !== 'explicit')
  );
};

const hasInvalidContexts = (contexts: readonly ActionAuthorizationContext[]): boolean =>
  contexts.length === 0 ||
  contexts.some(({ principalId, tenantId }) => principalId.length === 0 || tenantId.length === 0) ||
  new Set(contexts.map(({ principalId }) => principalId)).size !== contexts.length;

const isInvalidExplicitAssertionSet = (
  { actionKey, assertions }: ActionAuthorizationExplicitAssertionSet,
  explicitActionKeys: ReadonlySet<string>,
): boolean =>
  !explicitActionKeys.has(actionKey) ||
  assertions.length < 2 ||
  new Set(assertions.map(({ principalId }) => principalId)).size !== assertions.length ||
  assertions.some(
    ({ expected, principalId }) => principalId.length === 0 || (expected !== 'allowed' && expected !== 'denied'),
  ) ||
  !assertions.some(({ expected }) => expected === 'allowed') ||
  !assertions.some(({ expected }) => expected === 'denied');

const hasInvalidExplicitAssertions = (
  explicitActionAssertions: readonly ActionAuthorizationExplicitAssertionSet[],
  explicitActionKeys: ReadonlySet<string>,
): boolean =>
  explicitActionAssertions.length !== explicitActionKeys.size ||
  explicitActionAssertions.some((assertionSet) => isInvalidExplicitAssertionSet(assertionSet, explicitActionKeys)) ||
  new Set(explicitActionAssertions.map(({ actionKey }) => actionKey)).size !== explicitActionAssertions.length;

const hasInvalidExplicitGrants = (
  explicitActionGrants: readonly ActionAuthorizationExplicitGrant[],
  explicitActionAssertions: readonly ActionAuthorizationExplicitAssertionSet[],
  contexts: readonly ActionAuthorizationContext[],
): boolean => {
  const contextPrincipalIds = new Set(contexts.map(({ principalId }) => principalId));
  const assertionsByAction = new Map(
    explicitActionAssertions.map(({ actionKey, assertions }) => [actionKey, assertions] as const),
  );
  return (
    new Set(explicitActionGrants.map(({ actionKey }) => actionKey)).size !== explicitActionGrants.length ||
    explicitActionGrants.some(({ actionKey, principalIds }) => {
      const assertions = assertionsByAction.get(actionKey);
      return (
        assertions === undefined ||
        principalIds.length === 0 ||
        new Set(principalIds).size !== principalIds.length ||
        principalIds.some(
          (principalId) =>
            !contextPrincipalIds.has(principalId) ||
            !assertions.some((assertion) => assertion.principalId === principalId && assertion.expected === 'allowed'),
        )
      );
    })
  );
};

const assertProvisioningInput = (input: ActionAuthorizationProvisioningInput) => {
  const actions = input.actions.toSorted((left, right) => left.actionKey.localeCompare(right.actionKey));
  const contexts = input.contexts.toSorted(
    (left, right) => left.tenantId.localeCompare(right.tenantId) || left.principalId.localeCompare(right.principalId),
  );
  if (hasInvalidActions(actions)) {
    throw failure('action_authorization_input_invalid', 'Current Action discovery must produce a non-empty unique set');
  }
  if (hasInvalidContexts(contexts)) {
    throw failure(
      'action_authorization_input_invalid',
      'Authorization provisioning requires unique fixed Tenant contexts',
    );
  }
  const deniedPrincipalId = input.deniedPrincipalId ?? ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
  if (deniedPrincipalId.length === 0 || contexts.some(({ principalId }) => principalId === deniedPrincipalId)) {
    throw failure(
      'action_authorization_input_invalid',
      'The denied verification Principal must be outside the fixed context set',
    );
  }
  const explicitActionKeys = new Set<string>();
  for (const { actionKey, provisioning } of actions) {
    if (provisioning === 'explicit') {
      explicitActionKeys.add(actionKey);
    }
  }
  const explicitActionAssertions = (input.explicitActionAssertions ?? []).toSorted((left, right) =>
    left.actionKey.localeCompare(right.actionKey),
  );
  if (hasInvalidExplicitAssertions(explicitActionAssertions, explicitActionKeys)) {
    throw failure(
      'action_authorization_input_invalid',
      'Each explicit Action requires unique recorded allowed and denied verification assertions',
    );
  }
  const explicitActionGrants = (input.explicitActionGrants ?? []).toSorted((left, right) =>
    left.actionKey.localeCompare(right.actionKey),
  );
  if (hasInvalidExplicitGrants(explicitActionGrants, explicitActionAssertions, contexts)) {
    throw failure(
      'action_authorization_input_invalid',
      'Explicit Action grants must name fixed Principals that the recorded assertions allow',
    );
  }
  return { actions, contexts, deniedPrincipalId, explicitActionAssertions, explicitActionGrants };
};

/**
 * Expands per-account explicit Action grant data into per-Action grants and assertions. Accounts
 * that list an Action receive a direct executor grant and an `allowed` assertion; every other fixed
 * account and the synthetic non-member receive a `denied` assertion. Grant data that names an Action
 * outside the current `explicit` set fails, so stale data cannot grant anything silently.
 */
export const deriveExplicitActionAuthorization = (
  actions: readonly ActionAuthorizationProvisioningAction[],
  contexts: readonly ActionAuthorizationContext[],
  accountGrants: readonly ActionAuthorizationExplicitAccountGrant[],
  deniedPrincipalId: string = ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
): Effect.Effect<ActionAuthorizationExplicitDerivation, ActionAuthorizationProvisioningError> => {
  const explicitActionKeys = actions.flatMap(({ actionKey, provisioning }) =>
    provisioning === 'explicit' ? [actionKey] : [],
  );
  const explicitActionKeySet: ReadonlySet<string> = new Set(explicitActionKeys);
  const contextPrincipalIds = new Set(contexts.map(({ principalId }) => principalId));
  if (
    new Set(accountGrants.map(({ principalId }) => principalId)).size !== accountGrants.length ||
    accountGrants.some(
      ({ explicitActions, principalId }) =>
        !contextPrincipalIds.has(principalId) ||
        (explicitActions !== 'all' && explicitActions.some((actionKey) => !explicitActionKeySet.has(actionKey))),
    )
  ) {
    return Effect.fail(
      failure(
        'action_authorization_input_invalid',
        'Explicit Action grant data must name fixed Principals and current explicit Actions',
      ),
    );
  }
  const grantees = (actionKey: string): readonly string[] =>
    contexts.flatMap(({ principalId }) => {
      const grant = accountGrants.find((candidate) => candidate.principalId === principalId);
      return grant !== undefined && (grant.explicitActions === 'all' || grant.explicitActions.includes(actionKey))
        ? [principalId]
        : [];
    });
  const derivation = explicitActionKeys.map((actionKey) => {
    const allowed = grantees(actionKey);
    const allowedSet: ReadonlySet<string> = new Set(allowed);
    const denied = [
      ...contexts.flatMap(({ principalId }) => (allowedSet.has(principalId) ? [] : [principalId])),
      deniedPrincipalId,
    ];
    return { actionKey, allowed, denied };
  });
  return Effect.succeed({
    explicitActionAssertions: derivation.map(({ actionKey, allowed, denied }) => ({
      actionKey,
      assertions: [
        ...allowed.map((principalId) => ({ expected: 'allowed' as const, principalId })),
        ...denied.map((principalId) => ({ expected: 'denied' as const, principalId })),
      ],
    })),
    explicitActionGrants: derivation.flatMap(({ actionKey, allowed }) =>
      allowed.length === 0 ? [] : [{ actionKey, principalIds: allowed }],
    ),
  });
};

const tenantAccessRequest = (context: ActionAuthorizationContext) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: 'access',
    resource: v1.ObjectReference.create({
      objectId: context.tenantId,
      objectType: 'tenant',
    }),
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
      object: v1.ObjectReference.create({
        objectId: principalId,
        objectType: 'principal',
      }),
    }),
  });

export const buildActionAuthorizationRelationships = (
  actionKeys: readonly string[],
  contexts: readonly ActionAuthorizationContext[],
): readonly v1.Relationship[] =>
  [...new Set(contexts.map(({ tenantId }) => tenantId))]
    .flatMap((tenantId) =>
      actionKeys.map((actionKey) =>
        v1.Relationship.create({
          relation: 'executor',
          resource: v1.ObjectReference.create({
            objectId: toSpiceDbActionObjectId(actionKey),
            objectType: 'action',
          }),
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectId: tenantId,
              objectType: 'tenant',
            }),
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

export const buildExplicitActionGrantRelationships = (
  explicitActionGrants: readonly ActionAuthorizationExplicitGrant[],
): readonly v1.Relationship[] =>
  explicitActionGrants
    .flatMap(({ actionKey, principalIds }) =>
      principalIds.map((principalId) =>
        v1.Relationship.create({
          relation: 'executor',
          resource: v1.ObjectReference.create({
            objectId: toSpiceDbActionObjectId(actionKey),
            objectType: 'action',
          }),
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectId: principalId,
              objectType: 'principal',
            }),
          }),
        }),
      ),
    )
    .toSorted((left, right) => {
      const leftKey = `${left.resource?.objectId ?? ''}:${left.subject?.object?.objectId ?? ''}`;
      const rightKey = `${right.resource?.objectId ?? ''}:${right.subject?.object?.objectId ?? ''}`;
      return leftKey.localeCompare(rightKey);
    });

const serviceFailure = (cause?: unknown): ActionAuthorizationProvisioningError => {
  const error = failure(
    'action_authorization_service_unavailable',
    'The authorization service could not provision current Action rules safely',
  );
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};

const callClient = <Value>(operation: Effect.Effect<Value, Error>) =>
  operation.pipe(
    Effect.mapError((cause) =>
      Schema.is(ActionAuthorizationProvisioningError)(cause) ? cause : serviceFailure(cause),
    ),
  );

const checkHasPermission = (
  client: ActionAuthorizationProvisioningClient,
  request: v1.CheckPermissionRequest,
  error: ActionAuthorizationProvisioningError,
) =>
  callClient(client.checkPermission(request)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(error),
        onSome: (response) =>
          response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
            ? Effect.void
            : Effect.fail(error),
      }),
    ),
  );

const checkNoPermission = (
  client: ActionAuthorizationProvisioningClient,
  request: v1.CheckPermissionRequest,
  error: ActionAuthorizationProvisioningError = failure(
    'action_authorization_verification_failed',
    'The representative non-member authorization check did not deny',
  ),
) =>
  callClient(client.checkPermission(request)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(error),
        onSome: (response) =>
          response.permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION
            ? Effect.void
            : Effect.fail(error),
      }),
    ),
  );

export const provisionActionAuthorization = Effect.fn('ActionAuthorizationProvisioning.provisionActionAuthorization')(
  function* provisionActionAuthorizationEffect(
    client: ActionAuthorizationProvisioningClient,
    input: ActionAuthorizationProvisioningInput,
  ): Effect.fn.Return<ActionAuthorizationProvisioningResult, ActionAuthorizationProvisioningError> {
    const { actions, contexts, deniedPrincipalId, explicitActionAssertions, explicitActionGrants } = yield* Effect.try({
      catch: (error) => (Schema.is(ActionAuthorizationProvisioningError)(error) ? error : serviceFailure(error)),
      try: () => assertProvisioningInput(input),
    });

    yield* callClient(client.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })));

    yield* Effect.forEach(
      contexts,
      (context) =>
        checkHasPermission(
          client,
          tenantAccessRequest(context),
          failure(
            'action_authorization_membership_missing',
            'A fixed provisioning Principal is not an active member of its Tenant',
          ),
        ),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      contexts,
      (context) =>
        Effect.forEach(
          [...new Set(contexts.map(({ tenantId }) => tenantId))].filter((tenantId) => tenantId !== context.tenantId),
          (otherTenantId) =>
            checkNoPermission(
              client,
              tenantAccessRequest({ principalId: context.principalId, tenantId: otherTenantId }),
              failure(
                'action_authorization_verification_failed',
                'A fixed provisioning Principal can access another fixed Tenant',
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    );

    const defaultActionKeys = actions.flatMap(({ actionKey, provisioning }) =>
      provisioning === 'tenant_membership_default' ? [actionKey] : [],
    );
    const relationships = [
      ...buildActionAuthorizationRelationships(defaultActionKeys, contexts),
      ...buildExplicitActionGrantRelationships(explicitActionGrants),
    ];
    yield* callClient(
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

    yield* Effect.forEach(
      defaultActionKeys,
      (actionKey) =>
        Effect.forEach(
          contexts,
          (context) =>
            checkHasPermission(
              client,
              actionExecuteRequest(actionKey, context.principalId),
              failure(
                'action_authorization_verification_failed',
                'An expected fixed Tenant Action grant did not verify',
              ),
            ),
          { concurrency: 1, discard: true },
        ).pipe(Effect.andThen(checkNoPermission(client, actionExecuteRequest(actionKey, deniedPrincipalId)))),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      explicitActionAssertions,
      ({ actionKey, assertions }) =>
        Effect.forEach(
          assertions,
          (assertion) => {
            const request = actionExecuteRequest(actionKey, assertion.principalId);
            return assertion.expected === 'allowed'
              ? checkHasPermission(
                  client,
                  request,
                  failure(
                    'action_authorization_verification_failed',
                    'An explicit Action allowed assertion did not verify',
                  ),
                )
              : checkNoPermission(
                  client,
                  request,
                  failure(
                    'action_authorization_verification_failed',
                    'An explicit Action denied assertion did not verify',
                  ),
                );
          },
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    );

    return {
      actionCount: actions.length,
      grantCount: relationships.length,
      tenantCount: new Set(contexts.map(({ tenantId }) => tenantId)).size,
    };
  },
);
