import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Schema } from 'effect';

import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../permissions/context-access.ts';
import { toSpiceDbActionGrantObjectId } from '../permissions/service.ts';

import { IdentityPersistenceUnavailableError } from '../auth/principal-management-errors.ts';
import { agentScopedRoleObjectId } from '../permissions/scoped-role.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';

export interface AgentScopedRoleReplacement {
  readonly currentPrincipalRelationships: readonly v1.Relationship[];
  readonly desired: readonly v1.Relationship[];
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const resourceTypes = ['tenant', 'legal_entity', 'module_access', 'context_permission', 'action_grant'] as const;
const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const key = (item: v1.Relationship) => v1.Relationship.toJsonString(item);
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'The scoped agent policy could not be replaced safely',
    }),
    'cause',
    { value: cause },
  );

const policyRelations: ReadonlyMap<string, readonly string[]> = new Map([
  ['tenant', ['party_identity_reader']],
  ['legal_entity', ['counterparty_manager', 'counterparty_reader']],
  ['module_access', ['accessor_role', 'reader_role', 'writer_role']],
  ['context_permission', ['role_grantee']],
  ['action_grant', ['role', 'proposer_role']],
]);
const decodeParts = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const inCompanyScope = (resource: v1.ObjectReference, input: AgentScopedRoleReplacement): boolean => {
  if (resource.objectType === 'tenant') {
    return resource.objectId === input.tenantId;
  }
  if (resource.objectType === 'legal_entity') {
    return resource.objectId === toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId);
  }
  const prefix = resource.objectType === 'action_grant' ? 'ag_' : 'ctx_';
  if (!resource.objectId.startsWith(prefix)) {
    return false;
  }
  const decoded = decodeParts(Buffer.from(resource.objectId.slice(prefix.length), 'base64url').toString('utf-8'));
  if (Option.isNone(decoded)) {
    return false;
  }
  const [tenantId, scopeKindOrCompanyId, companyIdOrKey, moduleId, permission] = decoded.value;
  if (tenantId !== input.tenantId) {
    return false;
  }
  if (resource.objectType === 'context_permission') {
    return (
      decoded.value.length === 5 &&
      scopeKindOrCompanyId === 'legal_entity' &&
      companyIdOrKey === input.legalEntityId &&
      moduleId !== undefined &&
      permission !== undefined &&
      resource.objectId === toContextPermissionAccessObjectId(tenantId, input.legalEntityId, { moduleId, permission })
    );
  }
  if (decoded.value.length !== 3 || scopeKindOrCompanyId !== input.legalEntityId || companyIdOrKey === undefined) {
    return false;
  }
  if (resource.objectType === 'module_access') {
    return resource.objectId === toModuleAccessObjectId(tenantId, input.legalEntityId, companyIdOrKey);
  }
  return (
    resource.objectType === 'action_grant' &&
    resource.objectId ===
      toSpiceDbActionGrantObjectId({
        actionKey: companyIdOrKey,
        legalEntityId: input.legalEntityId,
        tenantId,
      })
  );
};
const validDesiredRelationship = (
  item: v1.Relationship,
  input: AgentScopedRoleReplacement,
  roleObjectId: string,
): boolean => {
  if (item.resource === undefined || item.subject?.object === undefined) {
    return false;
  }
  const principalMembership =
    item.subject.object.objectType === 'principal' &&
    item.subject.object.objectId === input.principalId &&
    (item.relation === 'member' || (item.resource.objectType === 'tenant' && item.relation === 'company_member')) &&
    item.subject.optionalRelation === '';
  if (item.resource.objectType === 'scoped_role') {
    return principalMembership && item.resource.objectId === roleObjectId;
  }
  if (!inCompanyScope(item.resource, input)) {
    return false;
  }
  if (principalMembership) {
    return item.resource.objectType === 'tenant' || item.resource.objectType === 'legal_entity';
  }
  return (
    item.subject.object.objectType === 'scoped_role' &&
    item.subject.object.objectId === roleObjectId &&
    item.subject.optionalRelation === 'member' &&
    (policyRelations.get(item.resource.objectType)?.includes(item.relation) ?? false)
  );
};

/** Scope links belong to the permission object, not to any one agent's policy. */
export const agentNamedPermissionScopeRelationships = (
  input: AgentScopedRoleReplacement,
): readonly v1.Relationship[] => {
  const companyId = toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId);
  const links = input.desired.flatMap((item) =>
    item.resource?.objectType === 'context_permission'
      ? [
          v1.Relationship.create({
            relation: 'tenant',
            resource: item.resource,
            subject: { object: { objectId: input.tenantId, objectType: 'tenant' } },
          }),
          v1.Relationship.create({
            relation: 'legal_entity',
            resource: item.resource,
            subject: { object: { objectId: companyId ?? '', objectType: 'legal_entity' } },
          }),
        ]
      : [],
  );
  return [...new Map(links.map((item) => [key(item), item])).values()];
};

const readNamedPermissionScopeLinks = Effect.fn('AgentScopedRolePolicy.readNamedScopeLinks')(
  function* readNamedPermissionScopeLinksEffect(rpc: SpiceDbRpc, desired: readonly v1.Relationship[]) {
    const filters = new Map<string, v1.Relationship>();
    for (const link of desired) {
      filters.set(`${link.relation}:${link.subject?.object?.objectId ?? ''}`, link);
    }
    const groups = yield* Effect.forEach(
      [...filters.values()],
      (link) =>
        rpc.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            relationshipFilter: {
              optionalRelation: link.relation,
              optionalSubjectFilter: {
                optionalSubjectId: link.subject?.object?.objectId ?? '',
                subjectType: link.subject?.object?.objectType ?? '',
              },
              resourceType: 'context_permission',
            },
          }),
        ),
      { concurrency: 2 },
    ).pipe(Effect.mapError(unavailable));
    const observed = new Set<string>();
    for (const response of groups.flat()) {
      if (response.relationship === undefined) {
        return yield* unavailable('Named-permission scope discovery returned an incomplete relationship');
      }
      observed.add(key(response.relationship));
    }
    return observed;
  },
);

/** Read-only preflight of the complete replacement, shared by reviewed replay and the native writer. */
export const planAgentScopedRoleReplacement = Effect.fn('AgentScopedRolePolicy.plan')(
  function* planAgentScopedRoleReplacementEffect(rpc: SpiceDbRpc, input: AgentScopedRoleReplacement) {
    const roleObjectId = agentScopedRoleObjectId(input);
    if (
      input.tenantId.length === 0 ||
      input.legalEntityId.length === 0 ||
      input.principalId.length === 0 ||
      input.currentPrincipalRelationships.some(
        (item) =>
          item.resource === undefined ||
          item.resource.objectType === 'action' ||
          item.subject?.object?.objectType !== 'principal' ||
          item.subject.object.objectId !== input.principalId ||
          item.subject.optionalRelation !== '',
      ) ||
      input.desired.some((item) => !validDesiredRelationship(item, input, roleObjectId))
    ) {
      return yield* unavailable('Agent policy contains an invalid subject or a foreign business scope');
    }
    const roleSubject = v1.SubjectFilter.create({ optionalSubjectId: roleObjectId, subjectType: 'scoped_role' });
    const groups = yield* Effect.forEach(
      resourceTypes,
      (resourceType) =>
        rpc.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            relationshipFilter: { optionalSubjectFilter: roleSubject, resourceType },
          }),
        ),
      { concurrency: 2 },
    ).pipe(Effect.mapError(unavailable));
    const members = yield* rpc
      .readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: {
            optionalRelation: 'member',
            optionalResourceId: roleObjectId,
            resourceType: 'scoped_role',
          },
        }),
      )
      .pipe(Effect.mapError(unavailable));
    const rolePolicy: v1.Relationship[] = [];
    for (const { relationship } of [...groups.flat(), ...members]) {
      const roleMember =
        relationship?.resource?.objectType === 'scoped_role' &&
        relationship.resource.objectId === roleObjectId &&
        relationship.relation === 'member' &&
        relationship.subject?.object?.objectType === 'principal' &&
        relationship.subject.optionalRelation === '';
      if (relationship === undefined || (!roleMember && !validDesiredRelationship(relationship, input, roleObjectId))) {
        return yield* unavailable('Agent policy discovery returned an incomplete or foreign relationship');
      }
      rolePolicy.push(relationship);
    }
    const sharedLinks = agentNamedPermissionScopeRelationships(input);
    const existingSharedLinks = yield* readNamedPermissionScopeLinks(rpc, sharedLinks);
    // A company writer never revokes the principal's other-company or other-tenant grants.
    // A tenant-global named grant is not owned by this company writer.
    // Legacy global Action evidence is ambiguous here and must be handled by the operator cutover first.
    const currentPrincipalPolicy = input.currentPrincipalRelationships.filter(
      (item) =>
        item.resource !== undefined &&
        (item.resource.objectType !== 'tenant' || ['member', 'company_member'].includes(item.relation)) &&
        inCompanyScope(item.resource, input),
    );
    const current = new Map([...currentPrincipalPolicy, ...rolePolicy].map((item) => [key(item), item]));
    const desired = new Map(input.desired.map((item) => [key(item), item]));
    const revoked = [...current].flatMap(([identity, item]) => {
      // Global SQL membership reconciliation, not a company-policy writer, owns tenant admission.
      const retainedTenantMembership =
        item.resource?.objectType === 'tenant' && ['member', 'company_member'].includes(item.relation);
      return !desired.has(identity) && !retainedTenantMembership ? [item] : [];
    });
    const granted = [
      ...[...desired].flatMap(([identity, item]) => (current.has(identity) ? [] : [item])),
      ...sharedLinks.filter((item) => !existingSharedLinks.has(key(item))),
    ];
    const updates = [
      ...revoked.map((relationship) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship }),
      ),
      ...granted.map((relationship) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
      ),
    ];
    if (updates.length > 1000) {
      return yield* unavailable('Scoped agent policy exceeds the atomic relationship-write limit');
    }
    return { granted: granted.length, revoked: revoked.length, updates };
  },
);

/** Revalidates current evidence before one atomic graph write; a prior plan never authorizes stale writes. */
export const replaceAgentScopedRolePolicy = Effect.fn('AgentScopedRolePolicy.replace')(
  function* replaceAgentScopedRolePolicyEffect(rpc: SpiceDbRpc, input: AgentScopedRoleReplacement) {
    const plan = yield* planAgentScopedRoleReplacement(rpc, input);
    if (plan.updates.length > 0) {
      yield* rpc
        .writeRelationships(v1.WriteRelationshipsRequest.create({ updates: plan.updates }))
        .pipe(Effect.mapError(unavailable));
    }
    return { granted: plan.granted, revoked: plan.revoked };
  },
);
