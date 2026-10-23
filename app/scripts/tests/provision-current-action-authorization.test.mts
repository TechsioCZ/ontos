import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  deriveActionAuthorizationInstalledModuleScopes,
  formatActionAuthorizationProvisioningFailure,
  selectActionAuthorizationProvisioningTarget,
} from '../provision-current-action-authorization.mts';
import {
  ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
  ActionAuthorizationProvisioningError,
  buildActionAuthorizationReconciliation,
  buildActionAuthorizationRelationships,
  buildIntrinsicSelfCredentialRelationships,
  buildActionAuthorizationRoleGrantReconciliation,
  buildActionAuthorizationRoleGrantRelationships,
  buildActionAuthorizationProvisioningPlan,
  deriveScopedActionAuthorization,
  validateActionAuthorizationProvisioningInput,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationProvisioningAction,
  ActionAuthorizationProvisioningInput,
  ScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { toLegalEntityAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import {
  toSpiceDbActionGrantObjectId,
  toSpiceDbActionObjectId,
} from '../../packages/core-runtime/src/permissions/service.ts';

const tenantId = 'tenant-a';
const otherTenantId = 'tenant-b';
const legalEntityId = 'company-a';
const otherCompanyId = 'company-b';
const thirdCompanyId = 'company-c';
const principalId = 'principal-a';
const moduleKey = 'party.registry';
const coreModuleKey = 'core.identity';
const commerceModuleKey = 'commerce.catalog';
const unpublishedModuleKey = 'unpublished.module';
const actionKey = 'party.registry.create-party';
const tenantActionKey = 'core.identity.restricted';
const optionalActionKey = 'party.registry.optional';
const companyAction = { actionKey, legalEntityId, tenantId };
const roleGrant = { ...companyAction, roleKey: 'operator' };
const descriptors = [
  { actionKey, legalEntityScope: 'required', owningModuleKey: moduleKey, provisioning: 'tenant_membership_default' },
  {
    actionKey: tenantActionKey,
    legalEntityScope: 'forbidden',
    owningModuleKey: coreModuleKey,
    provisioning: 'explicit',
  },
  { actionKey: optionalActionKey, legalEntityScope: 'optional', owningModuleKey: moduleKey, provisioning: 'explicit' },
] as const satisfies readonly ActionAuthorizationProvisioningAction[];
const installedModuleScopes = [
  { legalEntityId, moduleKeys: [moduleKey], tenantId },
  { legalEntityId: otherCompanyId, moduleKeys: [], tenantId },
  { moduleKeys: [coreModuleKey], tenantId },
] as const;
const assertionsFor = (action: ScopedActionAuthorization) => ({
  ...action,
  assertions: [
    { expected: 'allowed' as const, principalId },
    { expected: 'denied' as const, principalId: ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID },
  ],
});
const validInput = (): ActionAuthorizationProvisioningInput => ({
  actionAssertions: [assertionsFor(companyAction)],
  actions: [descriptors[0]],
  contexts: [{ legalEntityId, principalId, tenantId }],
  installedModuleScopes,
  managedRoles: [roleGrant, { ...roleGrant, legalEntityId: otherCompanyId }],
  roleGrants: [roleGrant],
});
const actionRelationship = (
  action: ScopedActionAuthorization,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: toSpiceDbActionObjectId(action), objectType: 'action' },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });
const deletedRelationships = (updates: readonly v1.RelationshipUpdate[]) =>
  updates.flatMap((update) =>
    update.operation === v1.RelationshipUpdate_Operation.DELETE && update.relationship !== undefined
      ? [update.relationship]
      : [],
  );

it('derives Actions only from exact installed module scopes and descriptor company requirements', () => {
  const actions = deriveScopedActionAuthorization(descriptors, installedModuleScopes);
  expect(actions).toHaveLength(3);
  expect(actions).toContainEqual(companyAction);
  expect(actions).toContainEqual({ actionKey: optionalActionKey, legalEntityId, tenantId });
  expect(actions).toContainEqual({ actionKey: tenantActionKey, tenantId });
  expect(actions.some((action) => action.legalEntityId === otherCompanyId)).toBe(false);
  expect(deriveScopedActionAuthorization(descriptors, [{ ...installedModuleScopes[0], moduleKeys: [] }])).toEqual([]);
  expect(deriveScopedActionAuthorization(descriptors, [{ moduleKeys: [moduleKey], tenantId }])).toEqual([
    { actionKey: optionalActionKey, tenantId },
  ]);
  expect(
    deriveScopedActionAuthorization(descriptors, [{ legalEntityId, moduleKeys: [coreModuleKey], tenantId }]),
  ).toEqual([]);
});

it('rejects duplicate descriptors, duplicate installation scopes and a company assigned to two tenants', () => {
  expect(() => deriveScopedActionAuthorization([descriptors[0], descriptors[0]], installedModuleScopes)).toThrow(
    ActionAuthorizationProvisioningError,
  );
  expect(() =>
    deriveScopedActionAuthorization(descriptors, [installedModuleScopes[0], installedModuleScopes[0]]),
  ).toThrow(ActionAuthorizationProvisioningError);
  expect(() =>
    deriveScopedActionAuthorization(descriptors, [{ moduleKeys: [moduleKey, moduleKey], tenantId }]),
  ).toThrow(ActionAuthorizationProvisioningError);
  expect(() =>
    deriveScopedActionAuthorization(descriptors, [
      ...installedModuleScopes,
      { legalEntityId, moduleKeys: [], tenantId: otherTenantId },
    ]),
  ).toThrow(ActionAuthorizationProvisioningError);
});

it('uses distinct lossless scoped Action, stable grant and role identities', () => {
  const actionId = toSpiceDbActionObjectId(companyAction);
  const grantId = toSpiceDbActionGrantObjectId(companyAction);
  expect(actionId.startsWith('ak_')).toBe(true);
  expect(grantId.startsWith('ag_')).toBe(true);
  expect(grantId.slice(3)).toBe(actionId.slice(3));
  expect(Buffer.from(actionId.slice(3), 'base64url').toString('utf-8')).toBe(
    '["tenant-a","company-a","party.registry.create-party"]',
  );
  expect(Buffer.from(toScopedRoleObjectId(roleGrant).slice(3), 'base64url').toString('utf-8')).toBe(
    '["tenant-a","company-a","operator"]',
  );
  for (const other of [
    { ...companyAction, legalEntityId: otherCompanyId },
    { ...companyAction, tenantId: otherTenantId },
    { actionKey, tenantId },
  ]) {
    expect(toSpiceDbActionObjectId(other)).not.toBe(actionId);
    expect(toSpiceDbActionGrantObjectId(other)).not.toBe(grantId);
  }
});

it('builds only a canonical company scope and stable grant link, never direct role or principal grants', () => {
  const desired = buildActionAuthorizationRelationships([companyAction]);
  expect(desired).toHaveLength(2);
  expect(desired).toContainEqual(
    actionRelationship(
      companyAction,
      'company_scope',
      'legal_entity',
      toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
    ),
  );
  expect(desired).toContainEqual(
    actionRelationship(companyAction, 'grant', 'action_grant', toSpiceDbActionGrantObjectId(companyAction)),
  );
  expect(
    desired.some(({ subject }) => ['principal', 'tenant', 'scoped_role'].includes(subject?.object?.objectType ?? '')),
  ).toBe(false);
});

it('builds tenant scope and a stable grant link without guessing any default role', () => {
  const action = { actionKey: tenantActionKey, tenantId };
  const desired = buildActionAuthorizationRelationships([action]);
  expect(desired).toHaveLength(2);
  expect(desired).toContainEqual(actionRelationship(action, 'tenant_scope', 'tenant', tenantId));
  expect(desired).toContainEqual(
    actionRelationship(action, 'grant', 'action_grant', toSpiceDbActionGrantObjectId(action)),
  );
  expect(buildActionAuthorizationRoleGrantRelationships([], installedModuleScopes)).toEqual([]);
});

it('writes explicit durable role usersets on action_grant rather than action', () => {
  expect(buildActionAuthorizationRoleGrantRelationships([roleGrant], installedModuleScopes)).toEqual([
    v1.Relationship.create({
      relation: 'role',
      resource: { objectId: toSpiceDbActionGrantObjectId(roleGrant), objectType: 'action_grant' },
      subject: {
        object: { objectId: toScopedRoleObjectId(roleGrant), objectType: 'scoped_role' },
        optionalRelation: 'member',
      },
    }),
  ]);
});

it('accepts durable intent for an uninstalled Action but rejects unmanaged scopes, duplicate or empty roles', () => {
  const dormant = { ...roleGrant, actionKey: 'party.registry.uninstalled', legalEntityId: otherCompanyId };
  expect(buildActionAuthorizationRoleGrantRelationships([dormant], installedModuleScopes)).toHaveLength(1);
  for (const grant of [
    { ...roleGrant, tenantId: otherTenantId },
    { ...roleGrant, legalEntityId: thirdCompanyId },
    { ...roleGrant, roleKey: '' },
    { ...roleGrant, actionKey: '' },
  ]) {
    expect(() => buildActionAuthorizationRoleGrantRelationships([grant], installedModuleScopes)).toThrow(
      ActionAuthorizationProvisioningError,
    );
  }
  expect(() => buildActionAuthorizationRoleGrantRelationships([roleGrant, roleGrant], installedModuleScopes)).toThrow(
    ActionAuthorizationProvisioningError,
  );
});

it('refuses legacy evidence before scoped provisioning instead of globally deleting it', () => {
  const desired = buildActionAuthorizationRelationships([companyAction]);
  const global = v1.Relationship.create({
    relation: 'executor',
    resource: { objectId: 'ak_b2xkLWdsb2JhbA', objectType: 'action' },
    subject: { object: { objectId: tenantId, objectType: 'tenant' }, optionalRelation: 'member' },
  });
  const removed = ['executor', 'restriction', 'executor_role'].map((relation) =>
    actionRelationship(companyAction, relation, 'principal', principalId),
  );
  for (const actions of [
    [global, ...desired],
    [...removed, ...desired],
  ]) {
    expect(() =>
      buildActionAuthorizationProvisioningPlan(validInput(), {
        actions,
        grants: [],
        schema: ONTOS_SPICEDB_SCHEMA,
        schemaDiffs: [],
      }),
    ).toThrow(ActionAuthorizationProvisioningError);
  }
  expect(() =>
    buildActionAuthorizationProvisioningPlan(validInput(), {
      actions: [],
      grants: [],
      schema: 'definition legacy {}',
      schemaDiffs: [v1.ReflectionSchemaDiff.create({})],
    }),
  ).toThrow(ActionAuthorizationProvisioningError);
  expect(
    deletedRelationships(
      buildActionAuthorizationReconciliation({ desired, existing: [global, ...desired], installedModuleScopes }),
    ),
  ).toEqual([]);
});

it('builds an exact dry-run diff and binds its fingerprint to all policy and observed evidence', () => {
  const input = validInput();
  const empty = { actions: [], grants: [], schema: ONTOS_SPICEDB_SCHEMA, schemaDiffs: [] };
  const plan = buildActionAuthorizationProvisioningPlan(input, empty);
  expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(plan.updates).toHaveLength(3);
  expect(plan.updates.every((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
  const current = {
    actions: buildActionAuthorizationRelationships([companyAction]),
    grants: buildActionAuthorizationRoleGrantRelationships([roleGrant], installedModuleScopes),
    schema: ONTOS_SPICEDB_SCHEMA,
    schemaDiffs: [],
  };
  const done = buildActionAuthorizationProvisioningPlan(input, current);
  expect(done.updates).toEqual([]);
  expect(done.fingerprint).not.toBe(plan.fingerprint);
  expect(
    buildActionAuthorizationProvisioningPlan(input, { ...current, actions: EffectArray.reverse(current.actions) })
      .fingerprint,
  ).toBe(done.fingerprint);
  expect(buildActionAuthorizationProvisioningPlan({ ...input, roleGrants: [] }, current).fingerprint).not.toBe(
    done.fingerprint,
  );
  const runtimeGrant = buildActionAuthorizationRoleGrantRelationships(
    [{ ...roleGrant, roleKey: `agent:${principalId}` }],
    installedModuleScopes,
  );
  const withRuntime = buildActionAuthorizationProvisioningPlan(input, {
    ...current,
    grants: [...current.grants, ...runtimeGrant],
  });
  expect(withRuntime.updates).toEqual([]);
  expect(withRuntime.fingerprint).not.toBe(done.fingerprint);
});

it('removes retired company Action links while leaving foreign scopes and durable grant intent untouched', () => {
  const desired = buildActionAuthorizationRelationships([companyAction]);
  const retired = buildActionAuthorizationRelationships([{ ...companyAction, legalEntityId: otherCompanyId }]);
  const foreign = buildActionAuthorizationRelationships([
    { ...companyAction, legalEntityId: thirdCompanyId, tenantId: otherTenantId },
  ]);
  const durable = buildActionAuthorizationRoleGrantRelationships([roleGrant], installedModuleScopes);
  const updates = buildActionAuthorizationReconciliation({
    desired,
    existing: [...desired, ...retired, ...foreign, ...durable],
    installedModuleScopes,
  });
  expect(deletedRelationships(updates)).toEqual(retired);
  expect(updates.every(({ relationship }) => relationship?.resource?.objectType === 'action')).toBe(true);
});

it('uninstall removes Action links only and reinstall restores the identical durable grant link', () => {
  const desired = buildActionAuthorizationRelationships([companyAction]);
  const durable = buildActionAuthorizationRoleGrantRelationships([roleGrant], installedModuleScopes);
  const emptyScopes = [{ legalEntityId, moduleKeys: [], tenantId }];
  const uninstall = buildActionAuthorizationReconciliation({
    desired: [],
    existing: [...desired, ...durable],
    installedModuleScopes: emptyScopes,
  });
  expect(deletedRelationships(uninstall)).toEqual(desired);
  const reinstall = buildActionAuthorizationReconciliation({
    desired: buildActionAuthorizationRelationships([companyAction]),
    existing: durable,
    installedModuleScopes,
  });
  expect(reinstall.map(({ relationship }) => relationship)).toEqual(desired);
  expect(reinstall.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
  expect(
    buildActionAuthorizationReconciliation({ desired, existing: desired, installedModuleScopes }).every(
      ({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH,
    ),
  ).toBe(true);
});

it('rejects runtime desired grant-policy writes and Actions outside the managed scopes', () => {
  for (const desired of [
    buildActionAuthorizationRoleGrantRelationships([roleGrant], installedModuleScopes),
    buildActionAuthorizationRelationships([{ ...companyAction, tenantId: otherTenantId }]),
  ]) {
    expect(() => buildActionAuthorizationReconciliation({ desired, existing: [], installedModuleScopes })).toThrow(
      ActionAuthorizationProvisioningError,
    );
  }
});

it('operator updates durable role intent exactly without deleting uninstalled intent or unmanaged tenant data', () => {
  const dormant = { ...roleGrant, legalEntityId: otherCompanyId };
  const stale = { ...roleGrant, roleKey: 'retired-role' };
  const foreignScopes = [{ legalEntityId, moduleKeys: [], tenantId: otherTenantId }];
  const foreign = buildActionAuthorizationRoleGrantRelationships(
    [{ ...roleGrant, tenantId: otherTenantId }],
    foreignScopes,
  );
  const old = buildActionAuthorizationRoleGrantRelationships([roleGrant, dormant, stale], installedModuleScopes);
  const updates = buildActionAuthorizationRoleGrantReconciliation({
    existing: [...old, ...foreign],
    installedModuleScopes,
    managedRoles: [roleGrant, dormant, stale],
    roleGrants: [roleGrant, dormant],
  });
  expect(deletedRelationships(updates)).toEqual(
    buildActionAuthorizationRoleGrantRelationships([stale], installedModuleScopes),
  );
  expect(updates.filter(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toHaveLength(2);
});

it('preserves runtime agent policy in the same company while removing only explicitly owned retired policy', () => {
  const runtimeGrant = { ...roleGrant, roleKey: 'agent:existing-agent' };
  const retiredOperatorGrant = { ...roleGrant, roleKey: 'retired-operator' };
  const existing = buildActionAuthorizationRoleGrantRelationships(
    [runtimeGrant, retiredOperatorGrant],
    installedModuleScopes,
  );
  const updates = buildActionAuthorizationRoleGrantReconciliation({
    existing,
    installedModuleScopes,
    managedRoles: [retiredOperatorGrant],
    roleGrants: [],
  });
  expect(deletedRelationships(updates)).toEqual(
    buildActionAuthorizationRoleGrantRelationships([retiredOperatorGrant], installedModuleScopes),
  );
  expect(
    updates.some(({ relationship }) => relationship?.subject?.object?.objectId === toScopedRoleObjectId(runtimeGrant)),
  ).toBe(false);
});

it('rejects unmanaged role grants, duplicate ownership and the runtime agent role namespace', () => {
  for (const managedRoles of [[], [roleGrant, roleGrant], [{ ...roleGrant, roleKey: 'agent:existing-agent' }]]) {
    expect(() => validateActionAuthorizationProvisioningInput({ ...validInput(), managedRoles })).toThrow(
      ActionAuthorizationProvisioningError,
    );
  }
});

it('validates exact assertions and retains dormant operator grant intent independently of current Actions', () => {
  const input = validInput();
  expect(validateActionAuthorizationProvisioningInput(input).scopedActions).toEqual([companyAction]);
  const dormantInput = { ...input, roleGrants: [...input.roleGrants, { ...roleGrant, legalEntityId: otherCompanyId }] };
  expect(validateActionAuthorizationProvisioningInput(dormantInput).grantRelationships).toHaveLength(2);
  const explicit = { ...input, actions: [{ ...descriptors[0], provisioning: 'explicit' as const }] };
  expect(validateActionAuthorizationProvisioningInput(explicit).relationships).toEqual(
    validateActionAuthorizationProvisioningInput(input).relationships,
  );
});

it('requires complete unique assertions including every fixed principal and the denied non-member', () => {
  const input = validInput();
  for (const actionAssertions of [
    [],
    [{ ...companyAction, assertions: [{ expected: 'allowed' as const, principalId }] }],
    [
      {
        ...companyAction,
        assertions: [{ expected: 'denied' as const, principalId: ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID }],
      },
    ],
    [{ ...assertionsFor(companyAction), legalEntityId: otherCompanyId }],
    [
      {
        ...companyAction,
        assertions: [...assertionsFor(companyAction).assertions, { expected: 'denied' as const, principalId }],
      },
    ],
  ]) {
    expect(() => validateActionAuthorizationProvisioningInput({ ...input, actionAssertions })).toThrow(
      ActionAuthorizationProvisioningError,
    );
  }
  expect(() =>
    validateActionAuthorizationProvisioningInput({
      ...input,
      contexts: [...input.contexts, { principalId: 'other-principal', tenantId: otherTenantId }],
    }),
  ).toThrow(ActionAuthorizationProvisioningError);
});

it('keeps exact cross-company denials and rejects cross-tenant allows', () => {
  const input = validInput();
  const outside = { legalEntityId: otherCompanyId, principalId: 'principal-b', tenantId };
  const assertions = [
    ...assertionsFor(companyAction).assertions,
    { expected: 'denied' as const, principalId: outside.principalId },
  ];
  expect(
    validateActionAuthorizationProvisioningInput({
      ...input,
      actionAssertions: [{ ...companyAction, assertions }],
      contexts: [...input.contexts, outside],
    }).scopedActions,
  ).toEqual([companyAction]);
  expect(() =>
    validateActionAuthorizationProvisioningInput({
      ...input,
      actionAssertions: [
        {
          ...companyAction,
          assertions: [
            ...assertionsFor(companyAction).assertions,
            { expected: 'allowed' as const, principalId: outside.principalId },
          ],
        },
      ],
      contexts: [...input.contexts, { ...outside, tenantId: otherTenantId }],
    }),
  ).toThrow(ActionAuthorizationProvisioningError);
});

it('accepts multiple company contexts but rejects duplicate contexts and cross-tenant company ownership', () => {
  const input = validInput();
  expect(
    validateActionAuthorizationProvisioningInput({
      ...input,
      contexts: [...input.contexts, { legalEntityId: otherCompanyId, principalId, tenantId }],
    }).scopedActions,
  ).toEqual([companyAction]);
  expect(() =>
    validateActionAuthorizationProvisioningInput({
      ...input,
      contexts: [...input.contexts, { legalEntityId, principalId, tenantId }],
    }),
  ).toThrow(ActionAuthorizationProvisioningError);
  expect(() =>
    validateActionAuthorizationProvisioningInput({
      ...input,
      contexts: [...input.contexts, { legalEntityId, principalId, tenantId: otherTenantId }],
    }),
  ).toThrow(ActionAuthorizationProvisioningError);
});

it('permits an empty installed Action set while preserving dormant durable role intent', () => {
  const input = {
    actionAssertions: [],
    actions: descriptors,
    contexts: [],
    installedModuleScopes: [{ legalEntityId, moduleKeys: [], tenantId }],
    managedRoles: [roleGrant],
    roleGrants: [roleGrant],
  };
  const validated = validateActionAuthorizationProvisioningInput(input);
  expect(validated.relationships).toEqual([]);
  expect(validated.grantRelationships).toHaveLength(1);
});

it('projects published active tenant installs onto all active Core companies and empties archived scopes', () => {
  const archivedCompanyId = 'company-retired';
  const scopes = deriveActionAuthorizationInstalledModuleScopes(
    [moduleKey, commerceModuleKey],
    [tenantId, otherTenantId],
    [
      { moduleKey, state: 'active', tenantId },
      { moduleKey: commerceModuleKey, state: 'suspended', tenantId },
      { moduleKey: unpublishedModuleKey, state: 'active', tenantId },
      { moduleKey: commerceModuleKey, state: 'active', tenantId: otherTenantId },
    ],
    [
      { legalEntityId, status: 'active', tenantId },
      { legalEntityId: otherCompanyId, status: 'active', tenantId },
      { legalEntityId: archivedCompanyId, status: 'archived', tenantId },
      { legalEntityId: thirdCompanyId, status: 'active', tenantId: otherTenantId },
    ],
  );
  for (const scope of scopes.filter(
    (value) => value.tenantId === tenantId && value.legalEntityId !== archivedCompanyId,
  )) {
    expect(scope.moduleKeys).toContain(moduleKey);
    expect(scope.moduleKeys).toContain(coreModuleKey);
    expect(scope.moduleKeys).not.toContain(commerceModuleKey);
    expect(scope.moduleKeys).not.toContain(unpublishedModuleKey);
  }
  expect(scopes.find((scope) => scope.legalEntityId === archivedCompanyId)?.moduleKeys).toEqual([]);
  expect(scopes.find((scope) => scope.legalEntityId === thirdCompanyId)?.moduleKeys).toContain(commerceModuleKey);
  expect(scopes.find((scope) => scope.legalEntityId === thirdCompanyId)?.moduleKeys).not.toContain(moduleKey);
  expect(scopes.filter((scope) => scope.legalEntityId === undefined)).toHaveLength(2);
});

it.effect(
  'selects only exact loopback development and stage targets with explicit policy',
  Effect.fn(function* selectsTarget() {
    const authorization = {
      actionAssertions: [],
      contexts: [{ principalId, tenantId }],
      managedRoles: [],
      roleGrants: [],
    };
    const base = { endpoint: 'localhost:50051', preSharedKey: 'fixture-only' };
    expect((yield* selectActionAuthorizationProvisioningTarget(base, authorization)).environment).toBe('development');
    expect(
      (yield* selectActionAuthorizationProvisioningTarget({ ...base, endpoint: '[::1]:50051' }, authorization))
        .environment,
    ).toBe('development');
    expect(
      (yield* selectActionAuthorizationProvisioningTarget(
        { ...base, deploymentEnvironment: 'stage', endpoint: 'spicedb:50051' },
        authorization,
      )).environment,
    ).toBe('stage');
    for (const configuration of [
      { ...base, deploymentEnvironment: 'production' },
      { ...base, deploymentEnvironment: 'stage' },
      { ...base, endpoint: 'spicedb:50051' },
      { ...base, endpoint: 'remote.example.invalid:50051' },
    ]) {
      expect((yield* Effect.flip(selectActionAuthorizationProvisioningTarget(configuration, authorization))).code).toBe(
        'action_authorization_configuration_invalid',
      );
    }
  }),
);

it('sanitizes unexpected provisioning errors', () => {
  expect(formatActionAuthorizationProvisioningFailure(new Error('secret'))).toBe(
    'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure',
  );
});

const selfCredentialDescriptors = [
  {
    actionKey: 'core.identity.bind-self-api-key',
    legalEntityScope: 'optional',
    owningModuleKey: coreModuleKey,
    provisioning: 'principal_self_credentials',
  },
  {
    actionKey: 'core.identity.set-self-api-key-binding-status',
    legalEntityScope: 'optional',
    owningModuleKey: coreModuleKey,
    provisioning: 'principal_self_credentials',
  },
] as const satisfies readonly ActionAuthorizationProvisioningAction[];

it('installs intrinsic own-credential links only for the two exact trusted descriptors and installed scopes', () => {
  const scoped = deriveScopedActionAuthorization(selfCredentialDescriptors, [
    { moduleKeys: [coreModuleKey], tenantId },
    { legalEntityId, moduleKeys: [coreModuleKey], tenantId },
    { legalEntityId: otherCompanyId, moduleKeys: [], tenantId },
  ]);
  const intrinsic = buildIntrinsicSelfCredentialRelationships(selfCredentialDescriptors, scoped);
  expect(intrinsic).toHaveLength(4);
  for (const action of scoped) {
    expect(intrinsic).toContainEqual(actionRelationship(action, 'self_credentials', 'tenant', tenantId));
  }
  expect(buildIntrinsicSelfCredentialRelationships(selfCredentialDescriptors, [])).toEqual([]);
  expect(buildIntrinsicSelfCredentialRelationships(descriptors, [companyAction])).toEqual([]);
});

it('rejects a business Action or foreign owner opting into intrinsic credential authority', () => {
  for (const descriptor of [
    { ...selfCredentialDescriptors[0], actionKey },
    { ...selfCredentialDescriptors[0], owningModuleKey: moduleKey },
  ]) {
    expect(() => deriveScopedActionAuthorization([descriptor], installedModuleScopes)).toThrow(
      ActionAuthorizationProvisioningError,
    );
    expect(() => buildIntrinsicSelfCredentialRelationships([descriptor], [companyAction])).toThrow(
      ActionAuthorizationProvisioningError,
    );
  }
});
