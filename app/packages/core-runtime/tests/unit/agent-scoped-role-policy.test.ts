import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { agentGrantRelationships } from '../../src/install/agent-entity-grants.ts';
import { replaceAgentScopedRolePolicy } from '../../src/install/agent-scoped-role-policy.ts';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { agentScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import { SpiceDbRpcError } from '../../src/permissions/spicedb-rpc.ts';
import type { SpiceDbRpc } from '../../src/permissions/spicedb-rpc.ts';

const scope = { legalEntityId: 'company-a', principalId: 'agent-a', tenantId: 'tenant-a' };
const policy = (access: 'read' | 'write' = 'write', actions = ['unrelated.action']) =>
  agentGrantRelationships({
    ...scope,
    actions: actions.map((actionKey) => ({
      actionKey,
      legalEntityScope: 'required' as const,
      owningModuleKey: 'example.module',
    })),
    legalEntityWriteRelations: new Map(),
    modules: [{ access, moduleId: 'example.module' }],
    template: [],
    writePolicy: 'direct',
  });
const identity = (item: v1.Relationship) => JSON.stringify(item);
const directMemberships = (items: readonly v1.Relationship[]) =>
  items.filter(
    (item) => item.subject?.object?.objectType === 'principal' && item.resource?.objectType !== 'scoped_role',
  );
const rpcFailure = new SpiceDbRpcError({ cause: 'injected', code: Option.none() });

const graph = (initial: readonly v1.Relationship[] = []) => {
  const stored = new Map(initial.map((item) => [identity(item), item]));
  const writes: v1.WriteRelationshipsRequest[] = [];
  const reads: v1.ReadRelationshipsRequest[] = [];
  const control = { failRead: false, failWrite: false };
  const rpc: SpiceDbRpc = {
    checkBulkPermissions: () => Effect.die('unexpected permission check'),
    checkPermission: () => Effect.die('unexpected permission check'),
    close: () => {},
    readRelationships: (request) =>
      Effect.suspend(() => {
        reads.push(request);
        if (control.failRead) {
          return Effect.fail(rpcFailure);
        }
        const filter = request.relationshipFilter;
        if (filter === undefined) {
          return Effect.die('missing relationship filter');
        }
        return Effect.succeed(
          [...stored.values()]
            .filter(
              (item) =>
                item.resource !== undefined &&
                item.resource.objectType === filter.resourceType &&
                (!filter.optionalResourceId || item.resource.objectId === filter.optionalResourceId) &&
                (!filter.optionalRelation || item.relation === filter.optionalRelation) &&
                (filter.optionalSubjectFilter === undefined ||
                  (item.subject?.object?.objectType === filter.optionalSubjectFilter.subjectType &&
                    item.subject.object.objectId === filter.optionalSubjectFilter.optionalSubjectId)),
            )
            .map((relationship) => v1.ReadRelationshipsResponse.create({ relationship })),
        );
      }),
    writeRelationships: (request) =>
      Effect.suspend(() => {
        writes.push(request);
        if (control.failWrite) {
          return Effect.fail(rpcFailure);
        }
        for (const update of request.updates) {
          if (update.relationship === undefined) {
            continue;
          }
          if (update.operation === v1.RelationshipUpdate_Operation.DELETE) {
            stored.delete(identity(update.relationship));
          } else {
            stored.set(identity(update.relationship), update.relationship);
          }
        }
        return Effect.succeed(v1.WriteRelationshipsResponse.create());
      }),
    writeSchema: () => Effect.die('unexpected schema write'),
  };
  return { control, reads, rpc, values: () => [...stored.values()], writes };
};

it.effect(
  'atomically replaces role policy and removes an unexpected second member without copying principal grants',
  () =>
    Effect.gen(function* replaceAtomically() {
      const desired = policy('read');
      const previous = policy();
      const unexpectedMember = v1.Relationship.create({
        relation: 'member',
        resource: { objectId: agentScopedRoleObjectId(scope), objectType: 'scoped_role' },
        subject: { object: { objectId: 'someone-else', objectType: 'principal' } },
      });
      const state = graph([...previous, unexpectedMember]);
      yield* replaceAgentScopedRolePolicy(state.rpc, {
        ...scope,
        currentPrincipalRelationships: directMemberships(previous),
        desired,
      });
      expect(state.writes).toHaveLength(1);
      expect(state.values().map(identity).toSorted()).toEqual(desired.map(identity).toSorted());
      expect(state.reads.every((request) => request.consistency?.requirement.oneofKind === 'fullyConsistent')).toBe(
        true,
      );
    }),
);

it.effect('is idempotent after a successful write whose acknowledgement was lost', () =>
  Effect.gen(function* retryIdempotently() {
    const desired = policy();
    const state = graph(desired);
    const result = yield* replaceAgentScopedRolePolicy(state.rpc, {
      ...scope,
      currentPrincipalRelationships: directMemberships(desired),
      desired,
    });
    expect(result).toEqual({ granted: 0, revoked: 0 });
    expect(state.writes).toHaveLength(0);
  }),
);

it.effect('rejects foreign scopes and subjects before any graph I/O', () =>
  Effect.gen(function* rejectForeignPolicy() {
    const original = policy().at(3);
    if (original === undefined) {
      yield* Effect.die('missing policy fixture');
      return;
    }
    const foreign = v1.Relationship.create({
      ...original,
      resource: {
        objectId: toModuleAccessObjectId(scope.tenantId, 'company-b', 'example.module') ?? '',
        objectType: 'module_access',
      },
    });
    const foreignSubject = v1.Relationship.create({
      ...original,
      subject: { object: { objectId: 'someone-else', objectType: 'principal' } },
    });
    for (const item of [foreign, foreignSubject]) {
      const state = graph();
      const failure = yield* Effect.flip(
        replaceAgentScopedRolePolicy(state.rpc, { ...scope, currentPrincipalRelationships: [], desired: [item] }),
      );
      expect(Predicate.isTagged(failure, 'IdentityPersistenceUnavailableError')).toBe(true);
      expect(state.reads).toHaveLength(0);
      expect(state.writes).toHaveLength(0);
    }
  }),
);

it.effect('does not mutate when policy discovery fails', () =>
  Effect.gen(function* rejectReadFailure() {
    const state = graph(policy());
    state.control.failRead = true;
    yield* Effect.flip(
      replaceAgentScopedRolePolicy(state.rpc, { ...scope, currentPrincipalRelationships: [], desired: policy('read') }),
    );
    expect(state.writes).toHaveLength(0);
  }),
);

it.effect('does not leave partial membership or policy after an atomic write failure', () =>
  Effect.gen(function* rejectAtomicFailure() {
    const before = policy();
    const state = graph(before);
    state.control.failWrite = true;
    yield* Effect.flip(
      replaceAgentScopedRolePolicy(state.rpc, {
        ...scope,
        currentPrincipalRelationships: directMemberships(before),
        desired: policy('read'),
      }),
    );
    expect(state.writes).toHaveLength(1);
    expect(state.values()).toEqual(before);
  }),
);

it.effect('rejects an oversized atomic mutation instead of committing policy in partial batches', () =>
  Effect.gen(function* rejectOversizedPolicy() {
    const state = graph();
    yield* Effect.flip(
      replaceAgentScopedRolePolicy(state.rpc, {
        ...scope,
        currentPrincipalRelationships: [],
        desired: policy(
          'write',
          Array.from({ length: 1001 }, (_, index) => `example.action-${index}`),
        ),
      }),
    );
    expect(state.writes).toHaveLength(0);
  }),
);

it.effect('archival removes company and role policy but preserves the tenant membership', () =>
  Effect.gen(function* archivePolicy() {
    const before = policy();
    const state = graph(before);
    yield* replaceAgentScopedRolePolicy(state.rpc, {
      ...scope,
      currentPrincipalRelationships: directMemberships(before),
      desired: [],
    });
    expect(state.writes).toHaveLength(1);
    expect(state.values()).toEqual(
      before.filter((item) => item.resource?.objectType === 'tenant' && item.relation === 'member'),
    );
  }),
);

it.effect('accepts canonical company context permissions and rejects tenant or foreign-company context policy', () =>
  Effect.gen(function* replaceContextPolicy() {
    const contextId =
      toContextPermissionAccessObjectId(scope.tenantId, scope.legalEntityId, {
        moduleId: 'example.module',
        permission: 'example.read_all',
      }) ?? '';
    const desired = agentGrantRelationships({
      ...scope,
      actions: [],
      legalEntityWriteRelations: new Map(),
      modules: [{ access: 'read', moduleId: 'example.module' }],
      template: [{ relation: 'grantee', resourceId: contextId, resourceType: 'context_permission' }],
      writePolicy: 'read_only',
    });
    const state = graph();
    yield* replaceAgentScopedRolePolicy(state.rpc, { ...scope, currentPrincipalRelationships: [], desired });
    expect(
      state.values().some((item) => item.resource?.objectId === contextId && item.relation === 'role_grantee'),
    ).toBe(true);
    for (const companyId of [undefined, 'company-b']) {
      const foreign = v1.Relationship.create({
        relation: 'role_grantee',
        resource: {
          objectId:
            toContextPermissionAccessObjectId(scope.tenantId, companyId, {
              moduleId: 'example.module',
              permission: 'example.read_all',
            }) ?? '',
          objectType: 'context_permission',
        },
        subject: {
          object: { objectId: agentScopedRoleObjectId(scope), objectType: 'scoped_role' },
          optionalRelation: 'member',
        },
      });
      const rejected = graph();
      yield* Effect.flip(
        replaceAgentScopedRolePolicy(rejected.rpc, { ...scope, currentPrincipalRelationships: [], desired: [foreign] }),
      );
      expect(rejected.reads).toHaveLength(0);
      expect(rejected.writes).toHaveLength(0);
    }
  }),
);

it.effect('preserves the same principal membership and policy in another company and tenant', () =>
  Effect.gen(function* preserveForeignScope() {
    const previous = policy();
    const foreign = [
      v1.Relationship.create({
        relation: 'party_identity_reader',
        resource: { objectId: scope.tenantId, objectType: 'tenant' },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
      v1.Relationship.create({
        relation: 'member',
        resource: {
          objectId: toLegalEntityAccessObjectId(scope.tenantId, 'company-b') ?? '',
          objectType: 'legal_entity',
        },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
      v1.Relationship.create({
        relation: 'accessor',
        resource: {
          objectId: toModuleAccessObjectId(scope.tenantId, 'company-b', 'example.module') ?? '',
          objectType: 'module_access',
        },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
      v1.Relationship.create({
        relation: 'member',
        resource: { objectId: 'tenant-b', objectType: 'tenant' },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
    ];
    const state = graph([...previous, ...foreign]);
    yield* replaceAgentScopedRolePolicy(state.rpc, {
      ...scope,
      currentPrincipalRelationships: [...directMemberships(previous), ...foreign],
      desired: [],
    });
    for (const item of foreign) {
      expect(state.values()).toContainEqual(item);
    }
  }),
);

it.effect('rejects global legacy Action evidence and another principal before graph I/O', () =>
  Effect.gen(function* rejectAmbiguousCurrentPolicy() {
    const current = [
      v1.Relationship.create({
        relation: 'executor',
        resource: { objectId: 'ak_legacy-action', objectType: 'action' },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
      v1.Relationship.create({
        relation: 'member',
        resource: { objectId: scope.tenantId, objectType: 'tenant' },
        subject: { object: { objectId: 'someone-else', objectType: 'principal' } },
      }),
    ];
    for (const item of current) {
      const state = graph();
      yield* Effect.flip(
        replaceAgentScopedRolePolicy(state.rpc, { ...scope, currentPrincipalRelationships: [item], desired: policy() }),
      );
      expect(state.reads).toHaveLength(0);
      expect(state.writes).toHaveLength(0);
    }
  }),
);

it.effect('installs exact shared named-permission scope links atomically and preserves them on archival', () =>
  Effect.gen(function* namedScopeLinks() {
    const contextId =
      toContextPermissionAccessObjectId(scope.tenantId, scope.legalEntityId, {
        moduleId: 'example.module',
        permission: 'example.read_all',
      }) ?? '';
    const desired = agentGrantRelationships({
      ...scope,
      actions: [],
      legalEntityWriteRelations: new Map(),
      modules: [{ access: 'read', moduleId: 'example.module' }],
      template: [{ relation: 'grantee', resourceId: contextId, resourceType: 'context_permission' }],
      writePolicy: 'read_only',
    });
    const state = graph();
    yield* replaceAgentScopedRolePolicy(state.rpc, { ...scope, currentPrincipalRelationships: [], desired });
    expect(state.writes).toHaveLength(1);
    const links = state
      .values()
      .filter((item) => item.resource?.objectType === 'context_permission' && item.relation !== 'role_grantee');
    expect(links).toHaveLength(2);
    expect(links).toContainEqual(
      v1.Relationship.create({
        relation: 'tenant',
        resource: { objectId: contextId, objectType: 'context_permission' },
        subject: { object: { objectId: scope.tenantId, objectType: 'tenant' } },
      }),
    );
    expect(links).toContainEqual(
      v1.Relationship.create({
        relation: 'legal_entity',
        resource: { objectId: contextId, objectType: 'context_permission' },
        subject: {
          object: {
            objectId: toLegalEntityAccessObjectId(scope.tenantId, scope.legalEntityId) ?? '',
            objectType: 'legal_entity',
          },
        },
      }),
    );
    const retry = yield* replaceAgentScopedRolePolicy(state.rpc, {
      ...scope,
      currentPrincipalRelationships: directMemberships(desired),
      desired,
    });
    expect(retry).toEqual({ granted: 0, revoked: 0 });
    expect(state.writes).toHaveLength(1);
    yield* replaceAgentScopedRolePolicy(state.rpc, {
      ...scope,
      currentPrincipalRelationships: directMemberships(desired),
      desired: [],
    });
    for (const link of links) {
      expect(state.values()).toContainEqual(link);
    }
    expect(state.values().some((item) => item.relation === 'role_grantee')).toBe(false);
  }),
);

it.effect('fails closed without mutation when graph discovery omits a relationship', () =>
  Effect.gen(function* incompletePolicyDiscovery() {
    const state = graph(policy());
    const malformed: SpiceDbRpc = {
      ...state.rpc,
      readRelationships: () => Effect.succeed([v1.ReadRelationshipsResponse.create()]),
    };
    const failure = yield* Effect.flip(
      replaceAgentScopedRolePolicy(malformed, { ...scope, currentPrincipalRelationships: [], desired: policy('read') }),
    );
    expect(Predicate.isTagged(failure, 'IdentityPersistenceUnavailableError')).toBe(true);
    expect(state.writes).toHaveLength(0);
  }),
);
