/** Administrator selections become explicit company-scoped SpiceDB policy, never principal executor grants. */
import { v1 } from '@authzed/authzed-node';
import { Schema } from 'effect';

import { toLegalEntityAccessObjectId, toModuleAccessObjectId } from '../permissions/context-access.ts';
import { agentScopedRoleObjectId } from '../permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId } from '../permissions/service.ts';
import { demoAccountObjectIdParts } from './demo-account-administration.ts';
import type { DemoAccountRelationship } from './demo-account-administration.ts';
import type { ActionAuthorizationProvisioningAction } from './action-authorization-provisioning.ts';

export const AgentGrantAccessSchema = Schema.Literals(['read', 'write']);
export type AgentGrantAccess = typeof AgentGrantAccessSchema.Type;
export const AgentGrantWritePolicySchema = Schema.Literals(['approval', 'direct', 'read_only']);
export type AgentGrantWritePolicy = typeof AgentGrantWritePolicySchema.Type;
export interface AgentGrantModule {
  readonly access: AgentGrantAccess;
  readonly moduleId: string;
}

const AgentGrantInvariantError = Schema.TaggedError<Error>()('AgentGrantInvariantError', { reason: Schema.String });
const invalid = (reason: string): never => {
  throw new AgentGrantInvariantError({ reason });
};
const companyScopedTypes: ReadonlySet<string> = new Set(['legal_entity', 'module_access', 'context_permission']);
const proposalLifecycleActionKey = 'core.identity.mutate-agent-proposals';

/** Legacy named-permission ceiling; role authority is persisted as graph policy, not derived at check time. */
export const isReadPermission = (permission: string): boolean => /(?:^|[._])read(?:_all)?$/u.test(permission);
const belongsToCompany = (relationship: DemoAccountRelationship, legalEntityId: string) =>
  demoAccountObjectIdParts(relationship.resourceId).includes(legalEntityId);
const isCoreModule = (moduleId: string) => moduleId.startsWith('core.');
const companyModules = (
  relationships: readonly DemoAccountRelationship[],
  legalEntityId: string,
): readonly string[] => [
  ...new Set(
    relationships.flatMap((relationship) =>
      relationship.resourceType === 'module_access' && belongsToCompany(relationship, legalEntityId)
        ? demoAccountObjectIdParts(relationship.resourceId).slice(2, 3)
        : [],
    ),
  ),
];

/** Named permission/module metadata only. Action ownership always comes from the composition catalog. */
export const relationshipModuleAccess = (relationship: DemoAccountRelationship): AgentGrantModule | undefined => {
  const parts = demoAccountObjectIdParts(relationship.resourceId);
  if (relationship.resourceType === 'module_access') {
    const moduleId = parts.at(2);
    return moduleId === undefined
      ? undefined
      : { access: relationship.relation === 'writer_role' ? 'write' : 'read', moduleId };
  }
  if (relationship.resourceType === 'context_permission') {
    const moduleId = parts.at(3);
    const permission = parts.at(4);
    return moduleId === undefined || permission === undefined
      ? undefined
      : { access: isReadPermission(permission) ? 'read' : 'write', moduleId };
  }
  return undefined;
};

export const agentModuleAccessOf = (
  relationships: readonly DemoAccountRelationship[],
  legalEntityId: string,
): readonly AgentGrantModule[] => {
  const known = new Set(companyModules(relationships, legalEntityId));
  const access = new Map<string, AgentGrantAccess>();
  for (const relationship of relationships) {
    if (companyScopedTypes.has(relationship.resourceType) && !belongsToCompany(relationship, legalEntityId)) {
      continue;
    }
    const granted = relationshipModuleAccess(relationship);
    if (
      granted !== undefined &&
      !isCoreModule(granted.moduleId) &&
      known.has(granted.moduleId) &&
      access.get(granted.moduleId) !== 'write'
    ) {
      access.set(granted.moduleId, granted.access);
    }
  }
  return [...access.entries()]
    .map(([moduleId, value]) => ({ access: value, moduleId }))
    .toSorted((left, right) => left.moduleId.localeCompare(right.moduleId));
};

export interface AgentScopedRolePolicyInput {
  /** Validated published contracts, including exact owningModuleKey and legalEntityScope. */
  readonly actions: readonly Pick<
    ActionAuthorizationProvisioningAction,
    'actionKey' | 'legalEntityScope' | 'owningModuleKey'
  >[];
  readonly legalEntityId: string;
  readonly legalEntityWriteRelations: ReadonlyMap<string, readonly string[]>;
  readonly modules: readonly AgentGrantModule[];
  readonly principalId: string;
  readonly template: readonly DemoAccountRelationship[];
  readonly tenantId: string;
  readonly writePolicy: AgentGrantWritePolicy;
}

/** Policy materialization is operator data, not a role-to-permission matrix used by authorization checks. */
export const agentGrantRelationships = (input: AgentScopedRolePolicyInput): readonly v1.Relationship[] => {
  if (
    new Set(input.actions.map(({ actionKey }) => actionKey)).size !== input.actions.length ||
    new Set(input.modules.map(({ moduleId }) => moduleId)).size !== input.modules.length ||
    input.principalId.length === 0 ||
    input.tenantId.length === 0 ||
    input.legalEntityId.length === 0
  ) {
    return invalid(
      'Agent policy requires unique composition Actions, module selections and a complete principal scope',
    );
  }
  const companyObjectId =
    toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId) ?? invalid('Invalid agent company scope');
  const roleObjectId = agentScopedRoleObjectId(input);
  const roleSubject = { object: { objectId: roleObjectId, objectType: 'scoped_role' }, optionalRelation: 'member' };
  const principalSubject = { object: { objectId: input.principalId, objectType: 'principal' } };
  const policy = (resourceType: string, resourceId: string, relation: string) =>
    v1.Relationship.create({
      relation,
      resource: { objectId: resourceId, objectType: resourceType },
      subject: roleSubject,
    });
  const membership = (resourceType: string, resourceId: string) =>
    v1.Relationship.create({
      relation: 'member',
      resource: { objectId: resourceId, objectType: resourceType },
      subject: principalSubject,
    });
  const effective = new Map(
    input.modules.map(({ access, moduleId }) => {
      if (isCoreModule(moduleId)) {
        return invalid('Agent module selections cannot grant Core administration');
      }
      return [moduleId, input.writePolicy === 'direct' ? access : 'read'] as const;
    }),
  );
  const writes = (moduleId: string) => effective.get(moduleId) === 'write';
  const writerRelations = new Set(
    [...input.legalEntityWriteRelations].flatMap(([moduleId, relations]) => (writes(moduleId) ? relations : [])),
  );
  const namedPolicy = input.template.flatMap((relationship) => {
    if (companyScopedTypes.has(relationship.resourceType) && !belongsToCompany(relationship, input.legalEntityId)) {
      return [];
    }
    if (
      relationship.resourceType === 'tenant' &&
      relationship.resourceId === input.tenantId &&
      relationship.relation.endsWith('_reader')
    ) {
      return [policy('tenant', relationship.resourceId, relationship.relation)];
    }
    if (
      relationship.resourceType === 'legal_entity' &&
      relationship.resourceId === companyObjectId &&
      (relationship.relation.endsWith('_reader') || writerRelations.has(relationship.relation))
    ) {
      return [policy('legal_entity', relationship.resourceId, relationship.relation)];
    }
    if (relationship.resourceType === 'context_permission' && relationship.relation === 'role_grantee') {
      const granted = relationshipModuleAccess(relationship);
      if (
        granted !== undefined &&
        effective.has(granted.moduleId) &&
        (granted.access === 'read' || writes(granted.moduleId))
      ) {
        return [policy('context_permission', relationship.resourceId, 'role_grantee')];
      }
    }
    return [];
  });
  // Shell access is explicit template evidence, not a selectable administration module.
  // Preserve only entry access: a reader_role would also grant every Shell resource read.
  const shellId = toModuleAccessObjectId(input.tenantId, input.legalEntityId, 'core.shell');
  const shellAccess =
    shellId !== undefined &&
    input.template.some(
      (relationship) =>
        relationship.resourceType === 'module_access' &&
        relationship.resourceId === shellId &&
        relationship.relation === 'accessor_role',
    )
      ? [policy('module_access', shellId, 'accessor_role')]
      : [];
  const modulePolicy = [...effective].map(([moduleId, access]) =>
    policy(
      'module_access',
      toModuleAccessObjectId(input.tenantId, input.legalEntityId, moduleId) ?? invalid('Invalid agent module scope'),
      access === 'write' ? 'writer_role' : 'reader_role',
    ),
  );
  const selectedWriters = new Set(
    input.modules.flatMap(({ access, moduleId }) => (access === 'write' ? [moduleId] : [])),
  );
  const actionPolicy = input.actions.flatMap((action) =>
    input.writePolicy !== 'read_only' &&
    action.actionKey !== proposalLifecycleActionKey &&
    selectedWriters.has(action.owningModuleKey) &&
    action.legalEntityScope !== 'forbidden'
      ? [
          policy(
            'action_grant',
            toSpiceDbActionGrantObjectId({
              actionKey: action.actionKey,
              legalEntityId: input.legalEntityId,
              tenantId: input.tenantId,
            }),
            input.writePolicy === 'approval' ? 'proposer_role' : 'role',
          ),
        ]
      : [],
  );
  // Proposal persistence is a Core lifecycle Action, not business execution or Core module administration.
  // Require a published exact descriptor and an actual business Action grant; selections alone are not authority.
  const proposalLifecyclePolicy =
    actionPolicy.length > 0 &&
    input.actions.some(
      (action) =>
        action.actionKey === proposalLifecycleActionKey &&
        action.owningModuleKey === 'core.identity' &&
        action.legalEntityScope === 'required',
    )
      ? [
          policy(
            'action_grant',
            toSpiceDbActionGrantObjectId({
              actionKey: proposalLifecycleActionKey,
              legalEntityId: input.legalEntityId,
              tenantId: input.tenantId,
            }),
            'role',
          ),
        ]
      : [];
  const relationships = [
    v1.Relationship.create({
      relation: 'company_member',
      resource: { objectId: input.tenantId, objectType: 'tenant' },
      subject: principalSubject,
    }),
    membership('legal_entity', companyObjectId),
    membership('scoped_role', roleObjectId),
    ...namedPolicy,
    ...shellAccess,
    ...modulePolicy,
    ...actionPolicy,
    ...proposalLifecyclePolicy,
  ];
  return [...new Map(relationships.map((item) => [v1.Relationship.toJsonString(item), item])).values()];
};
