import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  applyPeopleModelTransitionGraph,
  applyPeopleModelTransitionSealedGraph,
  PeopleModelTransitionError,
  planPeopleModelTransition,
  reviewedTransitionAgentNamedPermissions,
  verifyPeopleModelTransitionGraph,
} from '../../src/install/people-model-transition.ts';
import type {
  PeopleModelTransitionGraphClient,
  PeopleModelTransitionInput,
} from '../../src/install/people-model-transition.ts';
import { toScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
} from '../../src/permissions/context-access.ts';

const tenantId = 'tenant-a';
const legalEntityId = 'company-a';
const human = 'human-a';
const agent = 'agent-a';
const humanRole = { legalEntityId, roleKey: 'demo:human-a', tenantId };
const agentRole = { legalEntityId, roleKey: `agent:${agent}`, tenantId };
const hr = toScopedRoleObjectId(humanRole);
const ar = toScopedRoleObjectId(agentRole);
const r = (type: string, id: string, relation: string, subjectType: string, subjectId: string, subjectRelation = '') =>
  v1.Relationship.create({
    relation,
    resource: { objectId: id, objectType: type },
    subject: { object: { objectId: subjectId, objectType: subjectType }, optionalRelation: subjectRelation },
  });
const key = (item: v1.Relationship) => v1.Relationship.toJsonString(item);
const humanPolicy = r('module_access', 'module-a', 'writer_role', 'scoped_role', hr, 'member');
const agentPolicy = r('action_grant', 'grant-a', 'proposer_role', 'scoped_role', ar, 'member');
const recordGrant = r('resource', 'assigned-case', 'reader', 'principal', human);
const retail = r('business_permission', 'retail-profile', 'self_service_grantee', 'principal', 'retail-customer');
const unrelated = r('tenant', 'old-test-tenant', 'member', 'principal', 'old-test-principal');
const input = (): PeopleModelTransitionInput => ({
  compositionRevision: 'published-revision',
  deferredAgentPrincipalIds: [agent],
  desired: [
    r('principal', human, 'tenant', 'tenant', tenantId),
    r('principal', human, 'self', 'principal', human),
    r('principal', agent, 'tenant', 'tenant', tenantId),
    r('tenant', tenantId, 'company_member', 'principal', human),
    r('tenant', tenantId, 'company_member', 'principal', agent),
    r('scoped_role', hr, 'member', 'principal', human),
    r('scoped_role', ar, 'member', 'principal', agent),
    humanPolicy,
    agentPolicy,
  ],
  memberships: [
    {
      affiliation: 'employee',
      kind: 'human',
      legalEntityId,
      principalId: human,
      scopedRoles: [humanRole],
      status: 'active',
      tenantId,
    },
    {
      affiliation: null,
      kind: 'agent',
      legalEntityId,
      principalId: agent,
      scopedRoles: [agentRole],
      status: 'active',
      tenantId,
    },
  ],
  observed: {
    relationships: [
      r('action', 'old-action', 'executor', 'tenant', tenantId, 'member'),
      r('action', 'old-action', 'executor', 'principal', agent),
      r('action', 'old-action', 'restriction', 'action', 'old-guard'),
      r('module_access', 'module-a', 'accessor', 'principal', human),
      r('tenant', tenantId, 'identity_admin', 'principal', human),
      recordGrant,
      retail,
      unrelated,
    ],
    schema: 'old native schema',
  },
  reviewedInputSha256: 'a'.repeat(64),
  technicalPrincipalIds: [],
});

it('requires native human self credentials and removes stale agent self structure without touching history', () => {
  const original = input();
  const self = r('principal', human, 'self', 'principal', human);
  const stale = r('principal', agent, 'self', 'principal', agent);
  const operator = r('principal', agent, 'operator', 'principal', human);
  const plan = planPeopleModelTransition({
    ...original,
    observed: { ...original.observed, relationships: [...original.observed.relationships, stale, operator] },
  });
  expect(plan.additions).toContainEqual(self);
  expect(plan.deletions).toContainEqual(stale);
  expect(plan.expected).toContainEqual(operator);
  expect(() =>
    planPeopleModelTransition({ ...original, desired: original.desired.filter((row) => key(row) !== key(self)) }),
  ).toThrow(PeopleModelTransitionError);
  expect(() => planPeopleModelTransition({ ...original, desired: [...original.desired, stale] })).toThrow(
    PeopleModelTransitionError,
  );
  expect(() =>
    planPeopleModelTransition({
      ...original,
      desired: [...original.desired, r('principal', human, 'self', 'principal', agent)],
    }),
  ).toThrow(PeopleModelTransitionError);
});

it('reads reviewed target structural named-permission metadata without inferring grants from personas', () => {
  const scope = { legalEntityId, tenantId };
  const resourceId =
    toContextPermissionAccessObjectId(tenantId, legalEntityId, {
      moduleId: 'work.tasks',
      permission: 'work.tasks.read_all',
    }) ?? '';
  const link = {
    relation: 'legal_entity',
    resourceId,
    resourceType: 'context_permission',
    subjectId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
    subjectType: 'legal_entity',
  };
  const persona = {
    ...link,
    relation: 'role_grantee',
    subjectId: hr,
    subjectRelation: 'member',
    subjectType: 'scoped_role',
  };
  expect(reviewedTransitionAgentNamedPermissions([persona], scope)).toEqual([]);
  expect(reviewedTransitionAgentNamedPermissions([link, link, persona], scope)).toEqual([
    { relation: 'role_grantee', resourceId, resourceType: 'context_permission' },
  ]);
  expect(() => reviewedTransitionAgentNamedPermissions([{ ...link, subjectId: 'foreign-company' }], scope)).toThrow(
    PeopleModelTransitionError,
  );
  expect(() => reviewedTransitionAgentNamedPermissions([{ ...link, resourceId: `${resourceId}=` }], scope)).toThrow(
    PeopleModelTransitionError,
  );
  expect(() => reviewedTransitionAgentNamedPermissions([{ ...link, subjectRelation: 'member' }], scope)).toThrow(
    PeopleModelTransitionError,
  );
});

it('replaces actor admission with SQL-owned company membership without changing workload or retail admission', () => {
  const original = input();
  const legacy = r('tenant', tenantId, 'member', 'principal', human);
  const workload = r('tenant', tenantId, 'member', 'principal', 'workload');
  const retailAdmission = r('tenant', tenantId, 'member', 'principal', 'retail-customer');
  const plan = planPeopleModelTransition({
    ...original,
    desired: [...original.desired, workload],
    observed: {
      ...original.observed,
      relationships: [...original.observed.relationships, legacy, workload, retailAdmission],
    },
    technicalPrincipalIds: ['workload'],
  });
  expect(plan.deletions).toContainEqual(legacy);
  expect(plan.expected).not.toContainEqual(legacy);
  expect(plan.expected).toContainEqual(r('tenant', tenantId, 'company_member', 'principal', human));
  expect(plan.expected).toContainEqual(workload);
  expect(plan.expected).toContainEqual(retailAdmission);
  expect(() => planPeopleModelTransition({ ...original, desired: [...original.desired, legacy] })).toThrow(
    PeopleModelTransitionError,
  );
});

it('replaces blanket and direct authority with exact reviewed roles while preserving record and retail identity', () => {
  const p = planPeopleModelTransition(input());
  expect(p.deletions).toHaveLength(5);
  expect(p.legacyBlanketExecutors).toBe(1);
  expect(p.preservedRecordGrants).toBe(1);
  expect(p.expected).toContainEqual(recordGrant);
  expect(p.expected).toContainEqual(retail);
  expect(p.expected).toContainEqual(unrelated);
  expect(p.expected).toContainEqual(agentPolicy);
  expect(p.initialAdditions).not.toContainEqual(agentPolicy);
  expect(p.initialAdditions).toContainEqual(humanPolicy);
  expect(p.initialAdditions).toContainEqual(r('scoped_role', ar, 'member', 'principal', agent));
});

it('binds reviewed bytes, actual evidence, role selection, deferred replay and composition in the fingerprint', () => {
  const original = input();
  const first = planPeopleModelTransition(original).fingerprint;
  expect(
    planPeopleModelTransition({
      ...original,
      desired: original.desired.toReversed(),
      observed: { ...original.observed, relationships: original.observed.relationships.toReversed() },
    }).fingerprint,
  ).toBe(first);
  for (const changed of [
    { ...original, reviewedInputSha256: 'b'.repeat(64) },
    { ...original, compositionRevision: 'other-revision' },
    { ...original, deferredAgentPrincipalIds: [] },
    { ...original, observed: { ...original.observed, schema: 'other-schema' } },
    {
      ...original,
      observed: {
        ...original.observed,
        relationships: [...original.observed.relationships, r('tenant', 'unrelated', 'member', 'principal', 'new')],
      },
    },
  ]) {
    expect(planPeopleModelTransition(changed).fingerprint).not.toBe(first);
  }
});

it('rejects unresolved, duplicate, foreign-company and promoted-agent input instead of guessing', () => {
  const original = input();
  const [person, bot] = original.memberships;
  const [first] = original.observed.relationships;
  if (person === undefined || bot === undefined || first === undefined) {
    throw new Error('Missing transition test fixture');
  }
  for (const changed of [
    { ...original, memberships: [...original.memberships, person] },
    { ...original, memberships: [{ ...person, affiliation: null }, bot] },
    { ...original, memberships: [{ ...person, scopedRoles: [] }, bot] },
    { ...original, memberships: [person, { ...bot, scopedRoles: [{ roleKey: 'superadmin', tenantId }] }] },
    { ...original, memberships: [person, { ...bot, scopedRoles: [agentRole, agentRole] }] },
    { ...original, desired: [...original.desired, r('scoped_role', 'unreviewed', 'member', 'principal', human)] },
    { ...original, desired: [...original.desired, r('tenant', 'foreign', 'member', 'principal', human)] },
    { ...original, desired: [...original.desired, r('module_access', 'module-a', 'writer_role', 'principal', human)] },
    { ...original, memberships: [{ ...person, scopedRoles: [{ ...humanRole, legalEntityId: 'foreign' }] }, bot] },
    { ...original, desired: original.desired.filter((item) => item.resource?.objectId !== hr) },
    { ...original, deferredAgentPrincipalIds: [human] },
    { ...original, technicalPrincipalIds: [human] },
    { ...original, desired: [...original.desired, first] },
    {
      ...original,
      observed: {
        ...original.observed,
        relationships: [...original.observed.relationships, first],
      },
    },
  ]) {
    expect(() => planPeopleModelTransition(changed)).toThrow(PeopleModelTransitionError);
  }
});

it('detects added privilege and loss of preserved customer or assignment evidence during exact verification', () => {
  const plan = planPeopleModelTransition(input());
  expect(() => verifyPeopleModelTransitionGraph(plan, plan.expected.toReversed())).not.toThrow();
  expect(() =>
    verifyPeopleModelTransitionGraph({ ...plan, expected: plan.expected.toReversed() }, plan.expected),
  ).not.toThrow();
  expect(() =>
    verifyPeopleModelTransitionGraph(plan, [
      ...plan.expected,
      r('tenant', tenantId, 'identity_admin', 'principal', agent),
    ]),
  ).toThrow(PeopleModelTransitionError);
  expect(() =>
    verifyPeopleModelTransitionGraph(
      plan,
      plan.expected.filter((item) => key(item) !== key(retail)),
    ),
  ).toThrow(PeopleModelTransitionError);
});

const nativeClient = (initial: PeopleModelTransitionInput, failReplay = false) => {
  const state = new Map(initial.observed.relationships.map((item) => [key(item), item]));
  const calls: string[] = [];
  let { schema } = initial.observed;
  const client: PeopleModelTransitionGraphClient = {
    completeDeferredPolicies: Effect.suspend(() => {
      calls.push('native-audited-replay');
      expect(state.has(key(humanPolicy))).toBe(true);
      expect(state.has(key(agentPolicy))).toBe(false);
      if (failReplay) {
        return Effect.fail(new PeopleModelTransitionError({ reason: 'Native audited Action failed' }));
      }
      state.set(key(agentPolicy), agentPolicy);
      return Effect.void;
    }),
    snapshot: Effect.sync(() => ({ relationships: [...state.values()], schema })),
    writeRelationships: (request) =>
      Effect.sync(() => {
        calls.push('relationships');
        expect(request.updates.length).toBeLessThanOrEqual(1000);
        for (const update of request.updates) {
          const { relationship: item } = update;
          if (item === undefined) {
            throw new Error('Missing relationship update');
          }
          if (update.operation === v1.RelationshipUpdate_Operation.DELETE) {
            state.delete(key(item));
          } else {
            state.set(key(item), item);
          }
        }
      }),
    writeSchema: (request) =>
      Effect.sync(() => {
        calls.push('schema');
        expect([...state.values()].some((item) => item.resource?.objectType === 'action')).toBe(false);
        ({ schema } = request);
      }),
  };
  return { calls, client, schema: () => schema, state };
};

it.effect(
  'rechecks before mutation, retires old relations before schema, and waits for audited replay before final verification',
  () =>
    Effect.gen(function* executeReviewed() {
      const original = input();
      const p = planPeopleModelTransition(original);
      const native = nativeClient(original);
      const result = yield* applyPeopleModelTransitionGraph(native.client, original, p.fingerprint);
      expect(result.fingerprint).toBe(p.fingerprint);
      expect(native.schema()).toBe(ONTOS_SPICEDB_SCHEMA);
      expect(native.calls).toEqual(['relationships', 'schema', 'relationships', 'native-audited-replay']);
      verifyPeopleModelTransitionGraph(p, [...native.state.values()]);
    }),
);

it.effect(
  'performs zero writes for stale reviewed evidence and never pretends an audited replay failure completed the cutover',
  () =>
    Effect.gen(function* rejectStale() {
      const original = input();
      const native = nativeClient(original);
      const result = yield* Effect.result(applyPeopleModelTransitionGraph(native.client, original, 'b'.repeat(64)));
      expect(result._tag).toBe('Failure');
      expect(native.calls).toEqual([]);
      const failed = nativeClient(original, true);
      expect(
        (yield* Effect.result(
          applyPeopleModelTransitionGraph(failed.client, original, planPeopleModelTransition(original).fingerprint),
        ))._tag,
      ).toBe('Failure');
      expect(failed.state.has(key(agentPolicy))).toBe(false);
      expect(failed.state.has(key(retail))).toBe(true);
    }),
);

it('withdraws previously present deferred authority until the native audited replay revalidates it', () => {
  const original = input();
  const p = planPeopleModelTransition({
    ...original,
    observed: { ...original.observed, relationships: [...original.observed.relationships, agentPolicy] },
  });
  expect(p.deletions).toContainEqual(agentPolicy);
  expect(p.initialAdditions).not.toContainEqual(agentPolicy);
  expect(p.additions).toContainEqual(agentPolicy);
  expect(p.expected).toContainEqual(agentPolicy);
});

it.effect('finishes only the sealed stage without executing or claiming native audited replay', () =>
  Effect.gen(function* sealedBoundary() {
    const original = input();
    const native = nativeClient(original);
    const plan = yield* applyPeopleModelTransitionSealedGraph(
      native.client,
      original,
      planPeopleModelTransition(original).fingerprint,
    );
    expect(native.calls).toEqual(['relationships', 'schema', 'relationships']);
    expect(native.state.has(key(humanPolicy))).toBe(true);
    expect(native.state.has(key(agentPolicy))).toBe(false);
    expect(native.state.has(key(retail))).toBe(true);
    expect(() => verifyPeopleModelTransitionGraph(plan, [...native.state.values()])).toThrow(
      PeopleModelTransitionError,
    );
  }),
);
