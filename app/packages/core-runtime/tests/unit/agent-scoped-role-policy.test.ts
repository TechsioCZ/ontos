import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { agentGrantRelationships } from '../../src/install/agent-entity-grants.ts';
import { readScopedRoleTemplatePolicy } from '../../src/install/demo-account-administration.ts';
import { buildActionAuthorizationRelationships } from '../../src/install/action-authorization-provisioning.ts';
import { toSpiceDbActionGrantObjectId } from '../../src/permissions/service.ts';
import {
  planAgentScopedRoleReplacement,
  replaceAgentScopedRolePolicy,
} from '../../src/install/agent-scoped-role-policy.ts';
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
    diffSchema: () => Effect.die('unexpected schema diff'),
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
                (filter.optionalResourceId.length === 0 || item.resource.objectId === filter.optionalResourceId) &&
                (filter.optionalRelation.length === 0 || item.relation === filter.optionalRelation) &&
                (filter.optionalSubjectFilter === undefined ||
                  (item.subject?.object?.objectType === filter.optionalSubjectFilter.subjectType &&
                    item.subject.object.objectId === filter.optionalSubjectFilter.optionalSubjectId)),
            )
            .map((relationship) => v1.ReadRelationshipsResponse.create({ relationship })),
        );
      }),
    readSchema: () => Effect.die('unexpected schema read'),
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
  'revokes proposal lifecycle execution with its profile without touching installed Actions or another company',
  () =>
    Effect.gen(function* revokeProposalLifecycle() {
      const lifecycle = 'core.identity.mutate-agent-proposals';
      const input = {
        ...scope,
        actions: [
          {
            actionKey: 'example.module.command',
            legalEntityScope: 'required' as const,
            owningModuleKey: 'example.module',
          },
          { actionKey: lifecycle, legalEntityScope: 'required' as const, owningModuleKey: 'core.identity' },
        ],
        legalEntityWriteRelations: new Map<string, readonly string[]>(),
        modules: [{ access: 'write' as const, moduleId: 'example.module' }],
        template: [],
        writePolicy: 'approval' as const,
      };
      const previous = agentGrantRelationships(input);
      const foreign = agentGrantRelationships({ ...input, legalEntityId: 'company-b' });
      const installed = buildActionAuthorizationRelationships([{ ...scope, actionKey: lifecycle }]);
      const lifecycleId = toSpiceDbActionGrantObjectId({ ...scope, actionKey: lifecycle });
      expect(previous.some((item) => item.resource?.objectId === lifecycleId && item.relation === 'role')).toBe(true);
      for (const desired of [
        agentGrantRelationships({ ...input, writePolicy: 'read_only' }),
        agentGrantRelationships({ ...input, modules: [] }),
        agentGrantRelationships({
          ...input,
          actions: input.actions.filter(({ actionKey }) => actionKey === lifecycle),
        }),
        [],
      ]) {
        const state = graph([...previous, ...foreign, ...installed]);
        yield* replaceAgentScopedRolePolicy(state.rpc, {
          ...scope,
          currentPrincipalRelationships: directMemberships([...previous, ...foreign]),
          desired,
        });
        expect(state.values().some((item) => item.resource?.objectId === lifecycleId)).toBe(false);
        const remaining = new Set(state.values().map(identity));
        expect([...foreign, ...installed].every((item) => remaining.has(identity(item)))).toBe(true);
        expect(state.writes).toHaveLength(1);
        expect(
          state.writes[0]?.updates.some(
            (update) =>
              update.operation === v1.RelationshipUpdate_Operation.DELETE &&
              update.relationship?.resource?.objectId === lifecycleId,
          ),
        ).toBe(true);
      }
      const foreignLifecycle = previous.find((item) => item.resource?.objectId === lifecycleId);
      if (foreignLifecycle === undefined) {
        expect.unreachable('missing proposal lifecycle grant');
      }
      const denied = graph();
      const result = yield* Effect.result(
        replaceAgentScopedRolePolicy(denied.rpc, {
          ...scope,
          currentPrincipalRelationships: [],
          desired: [
            v1.Relationship.create({
              ...foreignLifecycle,
              resource: {
                objectId: toSpiceDbActionGrantObjectId({ ...scope, actionKey: lifecycle, legalEntityId: 'company-b' }),
                objectType: 'action_grant',
              },
            }),
          ],
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(denied.reads).toHaveLength(0);
      expect(denied.writes).toHaveLength(0);
    }),
);

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

it.effect('preflights the exact replacement without writes and the writer rechecks changed evidence', () =>
  Effect.gen(function* planBeforeReplay() {
    const desired = policy('read');
    const previous = policy();
    const state = graph(previous);
    const input = { ...scope, currentPrincipalRelationships: directMemberships(previous), desired };
    const plan = yield* planAgentScopedRoleReplacement(state.rpc, input);
    expect(plan.updates.length).toBeGreaterThan(0);
    expect(plan.granted + plan.revoked).toBe(plan.updates.length);
    expect(state.writes).toHaveLength(0);
    expect(state.values().map(identity).toSorted()).toEqual(previous.map(identity).toSorted());
    state.control.failRead = true;
    expect(Result.isFailure(yield* Effect.result(replaceAgentScopedRolePolicy(state.rpc, input)))).toBe(true);
    expect(state.writes).toHaveLength(0);
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
      expect.unreachable('missing policy fixture');
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

it.effect('company policy removal preserves independent and SQL-owned admission for global reconciliation', () =>
  Effect.gen(function* archivePolicy() {
    const independent = v1.Relationship.create({
      relation: 'member',
      resource: { objectId: scope.tenantId, objectType: 'tenant' },
      subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
    });
    const company = v1.Relationship.create({ ...independent, relation: 'company_member' });
    const before = [...new Map([...policy(), independent, company].map((item) => [identity(item), item])).values()];
    const state = graph(before);
    yield* replaceAgentScopedRolePolicy(state.rpc, {
      ...scope,
      currentPrincipalRelationships: directMemberships(before),
      desired: [],
    });
    expect(state.writes).toHaveLength(1);
    expect(state.values()).toEqual(
      before.filter(
        (item) => item.resource?.objectType === 'tenant' && ['member', 'company_member'].includes(item.relation),
      ),
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
      template: [{ relation: 'role_grantee', resourceId: contextId, resourceType: 'context_permission' }],
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
      template: [{ relation: 'role_grantee', resourceId: contextId, resourceType: 'context_permission' }],
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

it.effect('reads actual role userset policy without fabricating or copying principal permissions', () =>
  Effect.gen(function* readsNativeRolePolicy() {
    const desired = policy();
    const state = graph([
      ...desired,
      v1.Relationship.create({
        relation: 'grantee',
        resource: { objectId: 'unowned-direct-permission', objectType: 'context_permission' },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
    ]);
    const observed = yield* readScopedRoleTemplatePolicy(state.rpc, scope.principalId);
    const expected = desired
      .filter(
        (item) =>
          ['tenant', 'legal_entity', 'module_access', 'context_permission'].includes(item.resource?.objectType ?? '') &&
          item.subject?.object?.objectType === 'scoped_role',
      )
      .map((item) => ({
        relation: item.relation,
        resourceId: item.resource?.objectId,
        resourceType: item.resource?.objectType,
      }));
    expect(observed).toEqual(expect.arrayContaining(expected));
    expect(observed).toHaveLength(expected.length);
    expect(observed.some((item) => item.relation === 'writer_role')).toBe(true);
    expect(observed.some((item) => item.relation === 'grantee')).toBe(false);
    expect(state.writes).toHaveLength(0);
    expect(state.reads.every((request) => request.consistency?.requirement.oneofKind === 'fullyConsistent')).toBe(true);
  }),
);

it.effect('refuses conditional or incomplete native template policy instead of weakening evidence', () =>
  Effect.gen(function* rejectsConditionalRolePolicy() {
    const membership = policy().find((item) => item.resource?.objectType === 'scoped_role');
    if (membership === undefined) {
      return yield* Effect.die('Missing role membership fixture');
    }
    const malformed = graph([membership]);
    const rpc: SpiceDbRpc = {
      ...malformed.rpc,
      readRelationships: (request) =>
        request.relationshipFilter?.resourceType === 'module_access'
          ? Effect.succeed([v1.ReadRelationshipsResponse.create()])
          : malformed.rpc.readRelationships(request),
    };
    expect(Result.isFailure(yield* Effect.result(readScopedRoleTemplatePolicy(rpc, scope.principalId)))).toBe(true);
    const conditional = graph([
      v1.Relationship.create({ ...membership, optionalCaveat: { caveatName: 'not-unconditional' } }),
    ]);
    expect(
      Result.isFailure(yield* Effect.result(readScopedRoleTemplatePolicy(conditional.rpc, scope.principalId))),
    ).toBe(true);
    expect(malformed.writes).toHaveLength(0);
    expect(conditional.writes).toHaveLength(0);
    return yield* Effect.void;
  }),
);
