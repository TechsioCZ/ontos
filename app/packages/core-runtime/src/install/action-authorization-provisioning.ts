import { v1 } from '@authzed/authzed-node';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Array as EffectArray, Effect, Option, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { ActionProvisioningIntentSchema } from '../authorization/entrypoint-classification.ts';
import type { ActionProvisioningIntent } from '../authorization/entrypoint-classification.ts';

import { fullyConsistent } from '../permissions/client.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../permissions/schema.ts';
import { toScopedRoleObjectId } from '../permissions/scoped-role.ts';
import type { ScopedRoleIdentity } from '../permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId, toSpiceDbActionObjectId } from '../permissions/service.ts';
import { toLegalEntityAccessObjectId } from '../permissions/context-access.ts';

export const ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000019';

export interface ActionAuthorizationScope {
  readonly legalEntityId?: string;
  readonly tenantId: string;
}

export interface ActionAuthorizationContext extends ActionAuthorizationScope {
  readonly principalId: string;
}

/** Composition-owned installation evidence, including empty scopes after the last module is removed. */
export interface ActionAuthorizationInstalledModuleScope extends ActionAuthorizationScope {
  readonly moduleKeys: readonly string[];
}

export interface ActionAuthorizationProvisioningAction {
  readonly actionKey: string;
  readonly legalEntityScope: 'forbidden' | 'optional' | 'required';
  readonly owningModuleKey: string;
  readonly provisioning: ActionProvisioningIntent;
}

export interface ScopedActionAuthorization extends ActionAuthorizationScope {
  readonly actionKey: string;
}

/** Exact operator policy data. The application never derives a permission map from a role name. */
export interface ActionAuthorizationRoleGrant extends ScopedActionAuthorization {
  readonly roleKey: string;
}

export interface ActionAuthorizationAssertionSet extends ScopedActionAuthorization {
  readonly assertions: readonly {
    readonly expected: 'allowed' | 'denied';
    readonly principalId: string;
  }[];
}

export interface ActionAuthorizationReconciliationInput {
  readonly actions: readonly ActionAuthorizationProvisioningAction[];
  readonly installedModuleScopes: readonly ActionAuthorizationInstalledModuleScope[];
}

export interface ActionAuthorizationProvisioningInput extends ActionAuthorizationReconciliationInput {
  readonly actionAssertions: readonly ActionAuthorizationAssertionSet[];
  readonly contexts: readonly ActionAuthorizationContext[];
  readonly deniedPrincipalId?: string;
  /** Explicit operator ownership, including retired roles whose policy should be removed. */
  readonly managedRoles: readonly ScopedRoleIdentity[];
  readonly roleGrants: readonly ActionAuthorizationRoleGrant[];
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
  readonly diffSchema: (request: v1.DiffSchemaRequest) => Effect.Effect<v1.DiffSchemaResponse, Error>;
  readonly readRelationships: (
    request: v1.ReadRelationshipsRequest,
  ) => Effect.Effect<readonly v1.ReadRelationshipsResponse[], Error>;
  readonly readSchema: (request: v1.ReadSchemaRequest) => Effect.Effect<v1.ReadSchemaResponse, Error>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, Error>;
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

const invalid = (reason: string): never => {
  throw failure('action_authorization_input_invalid', reason);
};
// Each component escapes the separator, so scope and tuple keys are lossless without owning a JSON wire format.
const tupleKey = (parts: readonly string[]): string => parts.map(encodeURIComponent).join(':');
const scopeKey = ({ legalEntityId, tenantId }: ActionAuthorizationScope): string =>
  tupleKey([tenantId, legalEntityId ?? '']);
const contextKey = (context: ActionAuthorizationContext): string =>
  tupleKey([context.principalId, context.tenantId, context.legalEntityId ?? '']);
const validScope = ({ legalEntityId, tenantId }: ActionAuthorizationScope): boolean =>
  tenantId.length > 0 && (legalEntityId === undefined || legalEntityId.length > 0);
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const relationshipKey = (relationship: v1.Relationship): string =>
  tupleKey([
    relationship.resource?.objectType ?? '',
    relationship.resource?.objectId ?? '',
    relationship.relation,
    relationship.subject?.object?.objectType ?? '',
    relationship.subject?.object?.objectId ?? '',
    relationship.subject?.optionalRelation ?? '',
  ]);

// Only these Core handlers pin the target to the authenticated principal and implement own-key lifecycle.
const SELF_CREDENTIAL_ACTION_KEYS: ReadonlySet<string> = new Set([
  'core.identity.bind-self-api-key',
  'core.identity.set-self-api-key-binding-status',
]);

/** Only an installed module in the exact composition scope can mint an Action object. */
export const deriveScopedActionAuthorization = (
  actions: readonly ActionAuthorizationProvisioningAction[],
  installedModuleScopes: readonly ActionAuthorizationInstalledModuleScope[],
): readonly ScopedActionAuthorization[] => {
  if (
    !unique(actions.map(({ actionKey }) => actionKey)) ||
    actions.some(
      ({ actionKey, legalEntityScope, owningModuleKey, provisioning }) =>
        actionKey.length === 0 ||
        actionKey.length > 256 ||
        owningModuleKey.length === 0 ||
        !['forbidden', 'optional', 'required'].includes(legalEntityScope) ||
        !Schema.is(ActionProvisioningIntentSchema)(provisioning) ||
        (provisioning === 'principal_self_credentials' &&
          (owningModuleKey !== 'core.identity' || !SELF_CREDENTIAL_ACTION_KEYS.has(actionKey))),
    ) ||
    !unique(installedModuleScopes.map(scopeKey)) ||
    installedModuleScopes.some(
      (scope) => !validScope(scope) || !unique(scope.moduleKeys) || scope.moduleKeys.some((key) => key.length === 0),
    )
  ) {
    return invalid('Action descriptors and composition installation scopes must be valid and unique');
  }
  const companyOwners = new Map<string, string>();
  for (const scope of installedModuleScopes) {
    if (scope.legalEntityId !== undefined) {
      const owner = companyOwners.get(scope.legalEntityId);
      if (owner !== undefined && owner !== scope.tenantId) {
        return invalid('A company cannot belong to multiple Tenants');
      }
      companyOwners.set(scope.legalEntityId, scope.tenantId);
    }
  }
  return installedModuleScopes
    .flatMap(({ legalEntityId, moduleKeys, tenantId }) =>
      actions.flatMap(({ actionKey, legalEntityScope, owningModuleKey }) => {
        if (
          !moduleKeys.includes(owningModuleKey) ||
          (legalEntityScope === 'required' && legalEntityId === undefined) ||
          (legalEntityScope === 'forbidden' && legalEntityId !== undefined)
        ) {
          return [];
        }
        return legalEntityId === undefined ? [{ actionKey, tenantId }] : [{ actionKey, legalEntityId, tenantId }];
      }),
    )
    .toSorted((left, right) => toSpiceDbActionObjectId(left).localeCompare(toSpiceDbActionObjectId(right)));
};

const companyObjectId = (tenantId: string, legalEntityId: string): string =>
  toLegalEntityAccessObjectId(tenantId, legalEntityId) ??
  invalid('A company requires a valid canonical access identity');

/** Installation owns Action scope and stable grant links, never the durable role policy itself. */
export const buildActionAuthorizationRelationships = (
  actions: readonly ScopedActionAuthorization[],
): readonly v1.Relationship[] => {
  if (
    !unique(actions.map(toSpiceDbActionObjectId)) ||
    actions.some((action) => !validScope(action) || action.actionKey.length === 0)
  ) {
    return invalid('Action relationships require unique scoped identities');
  }
  return actions
    .flatMap((action) => [
      v1.Relationship.create({
        relation: action.legalEntityId === undefined ? 'tenant_scope' : 'company_scope',
        resource: { objectId: toSpiceDbActionObjectId(action), objectType: 'action' },
        subject: {
          object: {
            objectId:
              action.legalEntityId === undefined
                ? action.tenantId
                : companyObjectId(action.tenantId, action.legalEntityId),
            objectType: action.legalEntityId === undefined ? 'tenant' : 'legal_entity',
          },
        },
      }),
      v1.Relationship.create({
        relation: 'grant',
        resource: { objectId: toSpiceDbActionObjectId(action), objectType: 'action' },
        subject: { object: { objectId: toSpiceDbActionGrantObjectId(action), objectType: 'action_grant' } },
      }),
    ])
    .toSorted((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
};

/** Intrinsic self-service is installed from the two trusted Core descriptors, never inferred from a human role. */
export const buildIntrinsicSelfCredentialRelationships = (
  descriptors: readonly ActionAuthorizationProvisioningAction[],
  actions: readonly ScopedActionAuthorization[],
): readonly v1.Relationship[] => {
  const intrinsic = new Set(
    descriptors.flatMap((action) => {
      if (action.provisioning !== 'principal_self_credentials') {
        return [];
      }
      if (action.owningModuleKey !== 'core.identity' || !SELF_CREDENTIAL_ACTION_KEYS.has(action.actionKey)) {
        return invalid('Only Core own-credential Actions may declare intrinsic principal self-service');
      }
      return [action.actionKey];
    }),
  );
  return actions.flatMap((action) =>
    intrinsic.has(action.actionKey)
      ? [
          v1.Relationship.create({
            relation: 'self_credentials',
            resource: { objectId: toSpiceDbActionObjectId(action), objectType: 'action' },
            subject: { object: { objectId: action.tenantId, objectType: 'tenant' } },
          }),
        ]
      : [],
  );
};

/** Operator policy survives module uninstall, independently of whether its Action currently exists. */
export const buildActionAuthorizationRoleGrantRelationships = (
  roleGrants: readonly ActionAuthorizationRoleGrant[],
  installedModuleScopes: readonly ActionAuthorizationInstalledModuleScope[],
): readonly v1.Relationship[] => {
  const scopes = new Set(installedModuleScopes.map(scopeKey));
  if (
    !unique(roleGrants.map((grant) => tupleKey([toSpiceDbActionGrantObjectId(grant), grant.roleKey]))) ||
    roleGrants.some(
      (grant) =>
        !validScope(grant) ||
        !scopes.has(scopeKey(grant)) ||
        grant.actionKey.length === 0 ||
        grant.actionKey.length > 256 ||
        grant.roleKey.length === 0,
    )
  ) {
    return invalid('Role grants must name unique scoped Actions and exact roles inside the managed scopes');
  }
  return roleGrants
    .map((grant) =>
      v1.Relationship.create({
        relation: 'role',
        resource: { objectId: toSpiceDbActionGrantObjectId(grant), objectType: 'action_grant' },
        subject: {
          object: { objectId: toScopedRoleObjectId(grant), objectType: 'scoped_role' },
          optionalRelation: 'member',
        },
      }),
    )
    .toSorted((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
};

const decodeActionObjectIdentity = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.OptionFromNullOr(Schema.String), Schema.String])),
);

/** Decode only to identify cleanup ownership. This never participates in a permission check. */
const authorizationRelationshipScope = (relationship: v1.Relationship): Option.Option<ActionAuthorizationScope> => {
  if (relationship.resource?.objectType !== 'action' && relationship.resource?.objectType !== 'action_grant') {
    return Option.none();
  }
  const { objectId, objectType } = relationship.resource;
  const decoded = decodeActionObjectIdentity(Buffer.from(objectId.slice(3), 'base64url').toString('utf-8'));
  if (!objectId.startsWith(objectType === 'action' ? 'ak_' : 'ag_') || Result.isFailure(decoded)) {
    return Option.none();
  }
  const [tenantId, legalEntityId, actionKey] = decoded.success;
  const identity = Option.match(legalEntityId, {
    onNone: () => ({ actionKey, tenantId }),
    onSome: (companyId) => ({ actionKey, legalEntityId: companyId, tenantId }),
  });
  const canonicalId =
    objectType === 'action' ? toSpiceDbActionObjectId(identity) : toSpiceDbActionGrantObjectId(identity);
  return validScope(identity) && canonicalId === objectId ? Option.some(identity) : Option.none();
};

const obsoleteActionRelationship = (relationship: v1.Relationship): boolean =>
  relationship.resource?.objectType === 'action' &&
  (Option.isNone(authorizationRelationshipScope(relationship)) ||
    relationship.relation === 'executor' ||
    relationship.relation === 'restriction' ||
    relationship.relation === 'executor_role');

/** Deletes obsolete Actions and obsolete executor-role grants, including company module uninstalls. */
export const buildActionAuthorizationReconciliation = ({
  desired,
  existing,
  installedModuleScopes,
}: {
  readonly desired: readonly v1.Relationship[];
  readonly existing: readonly v1.Relationship[];
  readonly installedModuleScopes: readonly ActionAuthorizationInstalledModuleScope[];
}): readonly v1.RelationshipUpdate[] => {
  const scopes = new Set(installedModuleScopes.map(scopeKey));
  if (
    desired.some(
      (relationship) =>
        relationship.resource?.objectType !== 'action' ||
        !Option.exists(authorizationRelationshipScope(relationship), (scope) => scopes.has(scopeKey(scope))),
    )
  ) {
    return invalid('Desired Action relationships must remain inside the exact managed scopes');
  }
  const desiredKeys = new Set(desired.map(relationshipKey));
  return [
    ...existing.flatMap((relationship) =>
      relationship.resource?.objectType === 'action' &&
      Option.exists(authorizationRelationshipScope(relationship), (scope) => scopes.has(scopeKey(scope))) &&
      !desiredKeys.has(relationshipKey(relationship))
        ? [v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship })]
        : [],
    ),
    ...desired.map((relationship) =>
      v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
    ),
  ];
};

const managedRoleIds = (
  roles: readonly ScopedRoleIdentity[],
  roleGrants: readonly ActionAuthorizationRoleGrant[],
  installedModuleScopes: readonly ActionAuthorizationInstalledModuleScope[],
): ReadonlySet<string> => {
  const ids = new Set(roles.map(toScopedRoleObjectId));
  const scopes = new Set(installedModuleScopes.map(scopeKey));
  if (
    ids.size !== roles.length ||
    roles.some(
      (role) =>
        !validScope(role) ||
        role.roleKey.length === 0 ||
        role.roleKey.startsWith('agent:') ||
        !scopes.has(scopeKey(role)),
    ) ||
    roleGrants.some((grant) => !ids.has(toScopedRoleObjectId(grant)))
  ) {
    return invalid(
      'Operator role grants must belong to unique explicitly managed roles inside managed business scopes',
    );
  }
  return ids;
};

/** Operator ownership never includes an agent's runtime-authored policy merely because its scope matches. */
export const buildActionAuthorizationRoleGrantReconciliation = ({
  existing,
  installedModuleScopes,
  managedRoles,
  roleGrants,
}: {
  readonly existing: readonly v1.Relationship[];
  readonly installedModuleScopes: readonly ActionAuthorizationInstalledModuleScope[];
  readonly managedRoles: readonly ScopedRoleIdentity[];
  readonly roleGrants: readonly ActionAuthorizationRoleGrant[];
}): readonly v1.RelationshipUpdate[] => {
  const ownedRoles = managedRoleIds(managedRoles, roleGrants, installedModuleScopes);
  const desired = buildActionAuthorizationRoleGrantRelationships(roleGrants, installedModuleScopes);
  const desiredKeys = new Set(desired.map(relationshipKey));
  const scopes = new Set(installedModuleScopes.map(scopeKey));
  return [
    ...existing.flatMap((relationship) =>
      relationship.resource?.objectType === 'action_grant' &&
      relationship.relation === 'role' &&
      relationship.subject?.object?.objectType === 'scoped_role' &&
      relationship.subject.optionalRelation === 'member' &&
      ownedRoles.has(relationship.subject.object.objectId) &&
      Option.exists(authorizationRelationshipScope(relationship), (scope) => scopes.has(scopeKey(scope))) &&
      !desiredKeys.has(relationshipKey(relationship))
        ? [v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship })]
        : [],
    ),
    ...desired.map((relationship) =>
      v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
    ),
  ];
};

export const validateActionAuthorizationProvisioningInput = (input: ActionAuthorizationProvisioningInput) => {
  const scopedActions = deriveScopedActionAuthorization(input.actions, input.installedModuleScopes);
  managedRoleIds(input.managedRoles, input.roleGrants, input.installedModuleScopes);
  const deniedPrincipalId = input.deniedPrincipalId ?? ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
  if (
    input.installedModuleScopes.length === 0 ||
    input.contexts.some((context) => !validScope(context) || context.principalId.length === 0) ||
    !unique(input.contexts.map(contextKey)) ||
    deniedPrincipalId.length === 0 ||
    input.contexts.some(({ principalId }) => principalId === deniedPrincipalId)
  ) {
    return invalid('Provisioning requires unique trusted scope contexts and a distinct denied verification Principal');
  }
  const tenantsByCompany = new Map<string, string>();
  for (const scope of [...input.installedModuleScopes, ...input.contexts]) {
    if (scope.legalEntityId !== undefined) {
      const owner = tenantsByCompany.get(scope.legalEntityId);
      if (owner !== undefined && owner !== scope.tenantId) {
        return invalid('A company cannot belong to multiple Tenants');
      }
      tenantsByCompany.set(scope.legalEntityId, scope.tenantId);
    }
  }
  const actionIds = new Set(scopedActions.map(toSpiceDbActionObjectId));
  const principalIds = [...new Set(input.contexts.map(({ principalId }) => principalId))];
  if (
    input.actionAssertions.length !== scopedActions.length ||
    !unique(input.actionAssertions.map(toSpiceDbActionObjectId)) ||
    input.actionAssertions.some((set) => {
      const assertions = new Map(set.assertions.map((assertion) => [assertion.principalId, assertion.expected]));
      return (
        !actionIds.has(toSpiceDbActionObjectId(set)) ||
        assertions.size !== set.assertions.length ||
        set.assertions.some(
          ({ expected, principalId }) => principalId.length === 0 || !['allowed', 'denied'].includes(expected),
        ) ||
        !set.assertions.some(({ expected }) => expected === 'allowed') ||
        assertions.get(deniedPrincipalId) !== 'denied' ||
        principalIds.some((principalId) => !assertions.has(principalId)) ||
        set.assertions.some(
          ({ expected, principalId }) =>
            expected === 'allowed' &&
            !input.contexts.some((context) => context.principalId === principalId && context.tenantId === set.tenantId),
        )
      );
    })
  ) {
    return invalid(
      'Every scoped Action requires exact allowed/denied assertions for all fixed Principals and the non-member; cross-Tenant allows are invalid',
    );
  }
  const relationships = [
    ...buildActionAuthorizationRelationships(scopedActions),
    ...buildIntrinsicSelfCredentialRelationships(input.actions, scopedActions),
  ];
  const grantRelationships = buildActionAuthorizationRoleGrantRelationships(
    input.roleGrants,
    input.installedModuleScopes,
  );
  return { deniedPrincipalId, grantRelationships, relationships, scopedActions };
};

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

const readAuthorizationRelationships = (
  client: Pick<ActionAuthorizationProvisioningClient, 'readRelationships'>,
  resourceType: 'action' | 'action_grant',
) =>
  callClient(
    client.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: { resourceType },
      }),
    ),
  ).pipe(
    Effect.flatMap((observed) =>
      Effect.forEach(
        observed,
        ({ relationship }) =>
          relationship === undefined ? Effect.fail(serviceFailure()) : Effect.succeed(relationship),
        { concurrency: 1 },
      ),
    ),
  );

// Per-company expansion exceeds SpiceDB's default 1,000-update transaction limit on normal demos.
const writeActionAuthorizationUpdates = (
  client: Pick<ActionAuthorizationProvisioningClient, 'writeRelationships'>,
  updates: readonly v1.RelationshipUpdate[],
) =>
  Effect.forEach(
    EffectArray.chunksOf(updates, 500),
    (batch) => callClient(client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates: batch }))),
    { concurrency: 1, discard: true },
  );

/** After-commit runtime backend: exact managed scopes only, with no schema or global-identity writes. */
export const reconcileScopedActionAuthorization = Effect.fn(
  'ActionAuthorizationProvisioning.reconcileScopedActionAuthorization',
)(function* reconcileScopedActionAuthorizationEffect(
  client: Pick<ActionAuthorizationProvisioningClient, 'readRelationships' | 'writeRelationships'>,
  input: ActionAuthorizationReconciliationInput,
): Effect.fn.Return<ActionAuthorizationProvisioningResult, ActionAuthorizationProvisioningError> {
  const { desired, scopedActions } = yield* Effect.try({
    catch: (error) => (Schema.is(ActionAuthorizationProvisioningError)(error) ? error : serviceFailure(error)),
    try: () => {
      if (input.installedModuleScopes.length === 0) {
        return invalid('Runtime reconciliation requires explicit managed scopes, including empty uninstall scopes');
      }
      const currentActions = deriveScopedActionAuthorization(input.actions, input.installedModuleScopes);
      return {
        desired: [
          ...buildActionAuthorizationRelationships(currentActions),
          ...buildIntrinsicSelfCredentialRelationships(input.actions, currentActions),
        ],
        scopedActions: currentActions,
      };
    },
  });
  const existing = yield* readAuthorizationRelationships(client, 'action');
  const updates = buildActionAuthorizationReconciliation({
    desired,
    existing,
    installedModuleScopes: input.installedModuleScopes,
  });
  yield* writeActionAuthorizationUpdates(client, updates);
  return {
    actionCount: scopedActions.length,
    grantCount: desired.filter(({ relation }) => relation === 'grant').length,
    tenantCount: new Set(input.installedModuleScopes.map(({ tenantId }) => tenantId)).size,
  };
});

const permissionRequest = (objectType: string, objectId: string, permission: string, principalId: string) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission,
    resource: { objectId, objectType },
    subject: { object: { objectId: principalId, objectType: 'principal' } },
  });

const verifyPermission = (
  client: ActionAuthorizationProvisioningClient,
  request: v1.CheckPermissionRequest,
  expected: 'allowed' | 'denied',
  error: ActionAuthorizationProvisioningError,
) =>
  callClient(client.checkPermission(request)).pipe(
    Effect.flatMap((result) =>
      Option.isSome(result) &&
      result.value.permissionship ===
        (expected === 'allowed'
          ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
          : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION)
        ? Effect.void
        : Effect.fail(error),
    ),
  );

const verifyProvisioningContext = Effect.fn('ActionAuthorizationProvisioning.verifyContext')(function* verifyContext({
  client,
  context,
  input,
}: {
  readonly client: ActionAuthorizationProvisioningClient;
  readonly context: ActionAuthorizationContext;
  readonly input: ActionAuthorizationProvisioningInput;
}) {
  yield* verifyPermission(
    client,
    permissionRequest('tenant', context.tenantId, 'access', context.principalId),
    'allowed',
    failure('action_authorization_membership_missing', 'A fixed provisioning Principal cannot access its Tenant'),
  );
  if (context.legalEntityId !== undefined) {
    yield* verifyPermission(
      client,
      permissionRequest(
        'legal_entity',
        companyObjectId(context.tenantId, context.legalEntityId),
        'access',
        context.principalId,
      ),
      'allowed',
      failure('action_authorization_membership_missing', 'A fixed provisioning Principal cannot access its company'),
    );
  }
  yield* Effect.forEach(
    [...new Set(input.installedModuleScopes.map((scope) => scope.tenantId))],
    (tenantId) =>
      input.contexts.some(
        (candidate) => candidate.principalId === context.principalId && candidate.tenantId === tenantId,
      )
        ? Effect.void
        : verifyPermission(
            client,
            permissionRequest('tenant', tenantId, 'access', context.principalId),
            'denied',
            failure(
              'action_authorization_verification_failed',
              'A fixed provisioning Principal can access another Tenant',
            ),
          ),
    { concurrency: 1, discard: true },
  );
});

/** Canonical, length-independent tuple codec; each nested collection has an explicit field tag. */
const encodePlanInput = (input: ActionAuthorizationProvisioningInput): string =>
  tupleKey([
    tupleKey([
      'actions',
      ...input.actions
        .map((action) =>
          tupleKey([action.actionKey, action.legalEntityScope, action.owningModuleKey, action.provisioning]),
        )
        .toSorted(),
    ]),
    tupleKey([
      'assertions',
      ...input.actionAssertions
        .map((set) =>
          tupleKey([
            set.actionKey,
            scopeKey(set),
            ...set.assertions.map((assertion) => tupleKey([assertion.principalId, assertion.expected])).toSorted(),
          ]),
        )
        .toSorted(),
    ]),
    tupleKey(['contexts', ...input.contexts.map(contextKey).toSorted()]),
    tupleKey([
      'deniedPrincipal',
      input.deniedPrincipalId === undefined ? 'absent' : 'present',
      input.deniedPrincipalId ?? '',
    ]),
    tupleKey([
      'installations',
      ...input.installedModuleScopes
        .map((scope) => tupleKey([scopeKey(scope), ...scope.moduleKeys.toSorted()]))
        .toSorted(),
    ]),
    tupleKey([
      'managedRoles',
      ...input.managedRoles.map((role) => tupleKey([scopeKey(role), role.roleKey])).toSorted(),
    ]),
    tupleKey([
      'roleGrants',
      ...input.roleGrants.map((grant) => tupleKey([scopeKey(grant), grant.actionKey, grant.roleKey])).toSorted(),
    ]),
  ]);

export interface ActionAuthorizationProvisioningPlan extends ActionAuthorizationProvisioningResult {
  /** Binds the exact input, deployed schema and complete observed Action/grant inventory. */
  readonly fingerprint: string;
  readonly updates: readonly v1.RelationshipUpdate[];
}

/** Pure diff. Legacy evidence is never deleted by ordinary scoped provisioning. */
export const buildActionAuthorizationProvisioningPlan = (
  input: ActionAuthorizationProvisioningInput,
  observed: {
    readonly actions: readonly v1.Relationship[];
    readonly grants: readonly v1.Relationship[];
    readonly schema: string;
    readonly schemaDiffs: readonly v1.ReflectionSchemaDiff[];
  },
): ActionAuthorizationProvisioningPlan => {
  const { grantRelationships, relationships, scopedActions } = validateActionAuthorizationProvisioningInput(input);
  if (observed.schemaDiffs.length !== 0 || observed.actions.some(obsoleteActionRelationship)) {
    return invalid(
      'Legacy authorization requires the separately reviewed people cutover; scoped provisioning never removes its evidence or changes schema',
    );
  }
  const existing = [...observed.actions, ...observed.grants];
  if (existing.some((item) => item.optionalCaveat !== undefined || item.optionalExpiresAt !== undefined)) {
    return invalid('Conditional or expiring authorization evidence requires explicit migration review');
  }
  const current = new Set(existing.map(relationshipKey));
  const updates = [
    ...buildActionAuthorizationReconciliation({
      desired: relationships,
      existing: observed.actions,
      installedModuleScopes: input.installedModuleScopes,
    }),
    ...buildActionAuthorizationRoleGrantReconciliation({
      existing: observed.grants,
      installedModuleScopes: input.installedModuleScopes,
      managedRoles: input.managedRoles,
      roleGrants: input.roleGrants,
    }),
  ].filter(
    (update) =>
      update.operation !== v1.RelationshipUpdate_Operation.TOUCH ||
      (update.relationship !== undefined && !current.has(relationshipKey(update.relationship))),
  );
  const fingerprint = Hex.encode(
    sha256(
      utf8ToBytes(
        tupleKey([
          encodePlanInput(input),
          tupleKey(existing.map((item) => v1.Relationship.toJsonString(item)).toSorted()),
          observed.schema.trim(),
        ]),
      ),
    ),
  );
  return {
    actionCount: scopedActions.length,
    fingerprint,
    grantCount: grantRelationships.length,
    tenantCount: new Set(input.installedModuleScopes.map(({ tenantId }) => tenantId)).size,
    updates,
  };
};

const readProvisioningPlan = Effect.fn('ActionAuthorizationProvisioning.readPlan')(function* readPlan(
  client: ActionAuthorizationProvisioningClient,
  input: ActionAuthorizationProvisioningInput,
) {
  yield* Effect.try({
    catch: (error) => (Schema.is(ActionAuthorizationProvisioningError)(error) ? error : serviceFailure(error)),
    try: () => validateActionAuthorizationProvisioningInput(input),
  });
  // The native diff compares parsed authorization expressions, not readSchema's reformatted text.
  const [schema, comparison] = yield* Effect.all(
    [
      callClient(client.readSchema(v1.ReadSchemaRequest.create({}))),
      callClient(
        client.diffSchema(
          v1.DiffSchemaRequest.create({
            comparisonSchema: ONTOS_SPICEDB_SCHEMA,
            consistency: fullyConsistent,
          }),
        ),
      ),
    ],
    { concurrency: 2 },
  );
  if (comparison.diffs.length !== 0) {
    return yield* failure(
      'action_authorization_input_invalid',
      'Deploy the reviewed people cutover first; scoped provisioning does not mutate schema',
    );
  }
  const [actions, grants] = yield* Effect.all(
    [readAuthorizationRelationships(client, 'action'), readAuthorizationRelationships(client, 'action_grant')],
    { concurrency: 2 },
  );
  const plan = yield* Effect.try({
    catch: (error) => (Schema.is(ActionAuthorizationProvisioningError)(error) ? error : serviceFailure(error)),
    try: () =>
      buildActionAuthorizationProvisioningPlan(input, {
        actions,
        grants,
        schema: schema.schemaText,
        schemaDiffs: comparison.diffs,
      }),
  });
  yield* Effect.forEach(input.contexts, (context) => verifyProvisioningContext({ client, context, input }), {
    concurrency: 1,
    discard: true,
  });
  return plan;
});

export const planActionAuthorizationProvisioning = readProvisioningPlan;

export const verifyActionAuthorizationProvisioning = Effect.fn('ActionAuthorizationProvisioning.verify')(
  function* verify(client: ActionAuthorizationProvisioningClient, input: ActionAuthorizationProvisioningInput) {
    const plan = yield* readProvisioningPlan(client, input);
    if (plan.updates.length !== 0) {
      return yield* failure(
        'action_authorization_verification_failed',
        'The scoped authorization graph still differs from the reviewed policy',
      );
    }
    yield* Effect.forEach(
      input.actionAssertions,
      (set) =>
        Effect.forEach(
          set.assertions,
          (assertion) =>
            verifyPermission(
              client,
              permissionRequest('action', toSpiceDbActionObjectId(set), 'execute', assertion.principalId),
              assertion.expected,
              failure(
                'action_authorization_verification_failed',
                'A recorded scoped Action policy assertion did not verify',
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    );
    return plan;
  },
);

/** Apply requires the exact dry-run fingerprint and rechecks all preflight before the first write. */
export const provisionActionAuthorization = Effect.fn('ActionAuthorizationProvisioning.apply')(function* apply(
  client: ActionAuthorizationProvisioningClient,
  input: ActionAuthorizationProvisioningInput,
  expectedFingerprint: string,
) {
  const plan = yield* readProvisioningPlan(client, input);
  if (!/^[a-f0-9]{64}$/u.test(expectedFingerprint) || plan.fingerprint !== expectedFingerprint) {
    return yield* failure(
      'action_authorization_input_invalid',
      'Authorization evidence changed since the reviewed dry-run; obtain a new diff before applying',
    );
  }
  yield* writeActionAuthorizationUpdates(client, plan.updates);
  return yield* verifyActionAuthorizationProvisioning(client, input);
});
