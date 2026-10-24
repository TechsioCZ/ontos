/** Reviewed one-time policy cutover. Runtime authorization remains entirely graph-native. */
import { createHash } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';

import { ONTOS_SPICEDB_SCHEMA } from '../permissions/schema.ts';
import { buildPrincipalSelfCredentialUpdates } from '../permissions/action-authorization-lifecycle.ts';
import { toContextPermissionAccessObjectId, toLegalEntityAccessObjectId } from '../permissions/context-access.ts';
import { demoAccountObjectIdParts } from './demo-account-administration.ts';
import type { DemoAccountRelationship } from './demo-account-administration.ts';
import type { BootstrapRelationship } from './context-bootstrap-shared.ts';
import { toScopedRoleObjectId } from '../permissions/scoped-role.ts';
import type { ScopedRoleIdentity } from '../permissions/scoped-role.ts';

export interface PeopleModelTransitionMembership {
  readonly affiliation: 'employee' | 'external' | null;
  readonly kind: 'agent' | 'human';
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly scopedRoles: readonly ScopedRoleIdentity[];
  readonly status: 'active';
  readonly tenantId: string;
}

export interface PeopleModelTransitionSnapshot {
  readonly relationships: readonly v1.Relationship[];
  readonly schema: string;
}

export interface PeopleModelTransitionInput {
  readonly compositionRevision: string;
  /** Approved profiles without native audit yet; only the native audited replay may activate their role policy. */
  readonly deferredAgentPrincipalIds: readonly string[];
  /** Complete reviewed target; every reviewed agent policy activates only through governed native replay. */
  readonly desired: readonly v1.Relationship[];
  readonly memberships: readonly PeopleModelTransitionMembership[];
  readonly observed: PeopleModelTransitionSnapshot;
  /** Fingerprint of the exact reviewed membership/profile artifact bytes. */
  readonly reviewedInputSha256: string;
  /** Technical workload policy is explicit fixture data too, but never creates people memberships. */
  readonly technicalPrincipalIds: readonly string[];
}

export interface PeopleModelTransitionPlan {
  readonly additions: readonly v1.Relationship[];
  readonly deletions: readonly v1.Relationship[];
  readonly expected: readonly v1.Relationship[];
  readonly fingerprint: string;
  readonly initialAdditions: readonly v1.Relationship[];
  readonly legacyBlanketExecutors: number;
  readonly memberships: readonly PeopleModelTransitionMembership[];
  readonly preservedRecordGrants: number;
}

export class PeopleModelTransitionError extends Schema.TaggedError<PeopleModelTransitionError>()(
  'PeopleModelTransitionError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}

const invalid = (reason: string): never => {
  throw new PeopleModelTransitionError({ reason });
};
const agentScope = (profile: { readonly principalId: string; readonly tenantId: string }): string =>
  `${profile.tenantId}:${profile.principalId}`;
/** Explicitly preserve graph-empty SQL identities without resurrecting authority from an older audit. */
export const reviewedTransitionReplayAgents = (input: {
  readonly agents: readonly { readonly principalId: string; readonly tenantId: string }[];
  readonly preservedUnadmittedAgents: readonly { readonly principalId: string; readonly tenantId: string }[];
  readonly relationships: readonly v1.Relationship[];
  readonly replayAgents: readonly { readonly principalId: string; readonly tenantId: string }[];
}): readonly { readonly principalId: string; readonly tenantId: string }[] => {
  const all = new Set(input.agents.map(agentScope));
  const preserved = new Set(input.preservedUnadmittedAgents.map(agentScope));
  const replay = new Set(input.replayAgents.map(agentScope));
  if (
    all.size !== input.agents.length ||
    preserved.size !== input.preservedUnadmittedAgents.length ||
    replay.size !== input.replayAgents.length ||
    preserved.size + replay.size !== all.size ||
    [...preserved].some((id) => !all.has(id) || replay.has(id)) ||
    [...replay].some((id) => !all.has(id))
  ) {
    return invalid('Every SQL agent requires one explicit replay or preserved-unadmitted disposition');
  }
  const preservedIds = new Set(input.preservedUnadmittedAgents.map((actor) => actor.principalId));
  if (
    input.relationships.some(
      (row) => preservedIds.has(row.resource?.objectId ?? '') || preservedIds.has(row.subject?.object?.objectId ?? ''),
    )
  ) {
    return invalid('A preserved unadmitted agent must have no observed or desired graph references');
  }
  return input.replayAgents;
};
interface TransitionAgentAuthority {
  readonly legalEntityId: string;
  readonly modules: readonly { readonly access: string; readonly moduleId: string }[];
  readonly principalId: string;
  readonly tenantId: string;
  readonly writePolicy: string;
}
interface TransitionAgentReview extends TransitionAgentAuthority {
  readonly description: string | null;
  readonly ownerPrincipalId: string | null;
}
const sameAgentAuthority = (left: TransitionAgentAuthority, right: TransitionAgentAuthority): boolean =>
  left.legalEntityId === right.legalEntityId &&
  left.writePolicy === right.writePolicy &&
  left.modules.length === right.modules.length &&
  left.modules.every((module) =>
    right.modules.some((other) => module.moduleId === other.moduleId && module.access === other.access),
  );
/** Legacy create-agent evidence is review provenance, never a substitute for governed configure-agent replay. */
export const reviewedTransitionAgentProfiles = <Profile extends TransitionAgentReview>(input: {
  readonly agents: readonly { readonly principalId: string; readonly tenantId: string }[];
  readonly approved: readonly TransitionAgentReview[];
  readonly audited: readonly TransitionAgentAuthority[];
  readonly profiles: readonly Profile[];
}): readonly Profile[] => {
  const selected = new Map(input.profiles.map((profile) => [agentScope(profile), profile]));
  const approved = new Map(input.approved.map((profile) => [agentScope(profile), profile]));
  if (
    selected.size !== input.agents.length ||
    input.profiles.length !== selected.size ||
    input.approved.length !== approved.size ||
    approved.size !== selected.size ||
    input.agents.some((agent) => !selected.has(agentScope(agent)))
  ) {
    return invalid('Every native agent requires one exact reviewed replay profile');
  }
  for (const profile of input.profiles) {
    const reviewed = approved.get(agentScope(profile));
    if (
      reviewed === undefined ||
      !sameAgentAuthority(profile, reviewed) ||
      profile.description !== reviewed.description ||
      profile.ownerPrincipalId !== reviewed.ownerPrincipalId
    ) {
      return invalid('Agent profile or preserved metadata differs from the pinned review');
    }
  }
  for (const actual of input.audited) {
    const reviewed = selected.get(agentScope(actual));
    if (reviewed === undefined || !sameAgentAuthority(actual, reviewed)) {
      return invalid('Latest native agent authority disagrees with the pinned review');
    }
  }
  return input.profiles;
};
/** One-time legacy cutover metadata comes only from reviewed target structural links, never persona grants. */
export const reviewedTransitionAgentNamedPermissions = (
  relationships: readonly BootstrapRelationship[],
  scope: { readonly legalEntityId: string; readonly tenantId: string },
): readonly DemoAccountRelationship[] => {
  const companyId = toLegalEntityAccessObjectId(scope.tenantId, scope.legalEntityId);
  if (companyId === undefined) {
    return invalid('Reviewed agent named-permission company scope is invalid');
  }
  const permissions = new Map<string, DemoAccountRelationship>();
  const structural = relationships.filter(
    (row) => row.resourceType === 'context_permission' && row.relation === 'legal_entity',
  );
  for (const row of structural) {
    const [tenantId, kind, legalEntityId, moduleId, permission] = demoAccountObjectIdParts(row.resourceId);
    const resourceInScope =
      tenantId === scope.tenantId && kind === 'legal_entity' && legalEntityId === scope.legalEntityId;
    if (!resourceInScope && row.subjectId !== companyId) {
      continue;
    }
    if (
      !resourceInScope ||
      row.subjectType !== 'legal_entity' ||
      row.subjectId !== companyId ||
      (row.subjectRelation ?? '') !== '' ||
      moduleId === undefined ||
      permission === undefined ||
      row.resourceId !==
        toContextPermissionAccessObjectId(scope.tenantId, scope.legalEntityId, { moduleId, permission })
    ) {
      return invalid('Reviewed agent named-permission structural link crosses or ambiguously encodes its company');
    }
    permissions.set(row.resourceId, {
      relation: 'role_grantee',
      resourceId: row.resourceId,
      resourceType: 'context_permission',
    });
  }
  return [...permissions.values()];
};
const identity = (r: v1.Relationship): string =>
  [
    r.resource?.objectType ?? '',
    r.resource?.objectId ?? '',
    r.relation,
    r.subject?.object?.objectType ?? '',
    r.subject?.object?.objectId ?? '',
    r.subject?.optionalRelation ?? '',
  ]
    .map(encodeURIComponent)
    .join(':');
const serialized = (r: v1.Relationship): string => v1.Relationship.toJsonString(r);
const sorted = (rows: readonly v1.Relationship[]): readonly v1.Relationship[] =>
  rows.toSorted((a, b) => identity(a).localeCompare(identity(b)));
const complete = (r: v1.Relationship): boolean =>
  (r.resource?.objectType.length ?? 0) > 0 &&
  (r.resource?.objectId.length ?? 0) > 0 &&
  r.relation.length > 0 &&
  (r.subject?.object?.objectType.length ?? 0) > 0 &&
  (r.subject?.object?.objectId.length ?? 0) > 0;
const unconditional = (r: v1.Relationship): boolean =>
  r.optionalCaveat === undefined && r.optionalExpiresAt === undefined;
const directPolicyTypes: ReadonlySet<string> = new Set([
  'tenant',
  'legal_entity',
  'module_access',
  'context_permission',
  'business_permission',
  'identity_namespace',
]);
const legacyAction = (r: v1.Relationship): boolean =>
  r.resource?.objectType === 'action' && ['executor', 'restriction'].includes(r.relation);
const admission = (r: v1.Relationship): boolean =>
  (r.resource?.objectType === 'tenant' && ['member', 'company_member'].includes(r.relation)) ||
  (r.resource?.objectType === 'legal_entity' && r.relation === 'member');

const validateReviewedRole = (
  m: PeopleModelTransitionMembership,
  role: ScopedRoleIdentity,
  desired: ReadonlyMap<string, v1.Relationship>,
): void => {
  if (
    role.tenantId !== m.tenantId ||
    (role.legalEntityId !== undefined && role.legalEntityId !== m.legalEntityId) ||
    (m.kind === 'agent' && (role.legalEntityId !== m.legalEntityId || role.roleKey !== `agent:${m.principalId}`))
  ) {
    return invalid('A reviewed role crosses actor scope or promotes an agent');
  }
  const membership = v1.Relationship.create({
    relation: 'member',
    resource: { objectId: toScopedRoleObjectId(role), objectType: 'scoped_role' },
    subject: { object: { objectId: m.principalId, objectType: 'principal' } },
  });
  if (!desired.has(identity(membership))) {
    return invalid('An approved role assignment is absent from target graph policy');
  }
};
const validateReviewedPrincipalStructure = (
  member: PeopleModelTransitionMembership,
  desired: ReadonlyMap<string, v1.Relationship>,
): void => {
  const structural = new Set<string>();
  for (const update of buildPrincipalSelfCredentialUpdates({ ...member, tenantActive: true })) {
    if (update.relationship === undefined) {
      return invalid('Native principal structure is incomplete');
    }
    const present = desired.has(identity(update.relationship));
    if (present !== (update.operation === v1.RelationshipUpdate_Operation.TOUCH)) {
      return invalid('Reviewed target omits native principal structure or grants nonhuman self credentials');
    }
    if (present) {
      structural.add(identity(update.relationship));
    }
  }
  for (const row of desired.values()) {
    if (
      row.resource?.objectType === 'principal' &&
      row.resource.objectId === member.principalId &&
      ['self', 'tenant'].includes(row.relation) &&
      !structural.has(identity(row))
    ) {
      return invalid('Reviewed principal structure names an unreviewed subject or tenancy');
    }
  }
};
const validateReviewedMembership = (
  m: PeopleModelTransitionMembership,
  principalTenants: Map<string, string>,
  principalKinds: Map<string, string>,
  companyTenants: Map<string, string>,
  managed: ReadonlySet<string>,
  desired: ReadonlyMap<string, v1.Relationship>,
): void => {
  if (
    m.principalId.length === 0 ||
    m.tenantId.length === 0 ||
    m.legalEntityId.length === 0 ||
    m.status !== 'active' ||
    (m.kind === 'agent' ? m.affiliation !== null : !['employee', 'external'].includes(m.affiliation ?? '')) ||
    m.scopedRoles.length === 0 ||
    (m.kind === 'agent' && m.scopedRoles.length !== 1) ||
    new Set(m.scopedRoles.map(toScopedRoleObjectId)).size !== m.scopedRoles.length
  ) {
    return invalid('A reviewed actor has unresolved kind, affiliation, status or roles');
  }
  if (
    (principalTenants.has(m.principalId) && principalTenants.get(m.principalId) !== m.tenantId) ||
    (companyTenants.has(m.legalEntityId) && companyTenants.get(m.legalEntityId) !== m.tenantId) ||
    managed.has(m.principalId) ||
    (principalKinds.has(m.principalId) && principalKinds.get(m.principalId) !== m.kind)
  ) {
    return invalid('Reviewed actor identity conflicts with its tenant, company or technical kind');
  }
  principalTenants.set(m.principalId, m.tenantId);
  principalKinds.set(m.principalId, m.kind);
  companyTenants.set(m.legalEntityId, m.tenantId);
  for (const role of m.scopedRoles) {
    validateReviewedRole(m, role, desired);
  }
  validateReviewedPrincipalStructure(m, desired);
};
const validateActorAdmission = (r: v1.Relationship, memberships: readonly PeopleModelTransitionMembership[]): void => {
  const { resource } = r;
  const allowed = memberships.some(
    (m) =>
      m.principalId === r.subject?.object?.objectId &&
      (resource?.objectType === 'tenant'
        ? resource.objectId === m.tenantId
        : resource?.objectId === toLegalEntityAccessObjectId(m.tenantId, m.legalEntityId)),
  );
  if (
    !allowed ||
    r.subject?.optionalRelation !== '' ||
    (resource?.objectType === 'tenant' && r.relation !== 'company_member')
  ) {
    return invalid('Target grants unreviewed tenant/company admission');
  }
};
const validateDesiredActorPolicy = (
  input: PeopleModelTransitionInput,
  desired: ReadonlyMap<string, v1.Relationship>,
): void => {
  const people = new Set(input.memberships.map((m) => m.principalId));
  const roles = new Set(
    input.memberships.flatMap((m) => m.scopedRoles.map((role) => `${m.principalId}:${toScopedRoleObjectId(role)}`)),
  );
  for (const r of desired.values()) {
    const actor = r.subject?.object;
    if (actor?.objectType !== 'principal' || !people.has(actor.objectId)) {
      continue;
    }
    if (r.resource?.objectType === 'scoped_role') {
      if (
        r.relation !== 'member' ||
        !roles.has(`${actor.objectId}:${r.resource.objectId}`) ||
        r.subject?.optionalRelation !== ''
      ) {
        return invalid('Target grants an actor an unreviewed role');
      }
    } else if (admission(r)) {
      validateActorAdmission(r, input.memberships);
    } else if (directPolicyTypes.has(r.resource?.objectType ?? '') && r.relation !== 'self_service_grantee') {
      return invalid('Target replaces role policy with direct principal authority');
    }
  }
};
const validateReviewedInput = (input: PeopleModelTransitionInput) => {
  if (
    !/^[a-f0-9]{64}$/u.test(input.reviewedInputSha256) ||
    input.compositionRevision.length === 0 ||
    input.memberships.length === 0
  ) {
    return invalid('A transition requires reviewed artifact bytes, a published composition and explicit memberships');
  }
  const memberKeys = input.memberships.map((m) =>
    [m.tenantId, m.legalEntityId, m.principalId].map(encodeURIComponent).join(':'),
  );
  if (new Set(memberKeys).size !== memberKeys.length) {
    return invalid('Duplicate reviewed company membership');
  }
  const principalTenants = new Map<string, string>();
  const companyTenants = new Map<string, string>();
  const principalKinds = new Map<string, string>();
  const desired = new Map<string, v1.Relationship>();
  for (const r of input.desired) {
    if (!complete(r) || !unconditional(r) || legacyAction(r)) {
      return invalid('The target contains incomplete, conditional or legacy Action policy');
    }
    desired.set(identity(r), r);
  }
  const managed = new Set(input.technicalPrincipalIds);
  for (const m of input.memberships) {
    validateReviewedMembership(m, principalTenants, principalKinds, companyTenants, managed, desired);
  }
  for (const id of principalTenants.keys()) {
    managed.add(id);
  }
  if (
    new Set(input.deferredAgentPrincipalIds).size !== input.deferredAgentPrincipalIds.length ||
    input.deferredAgentPrincipalIds.some(
      (id) => !input.memberships.some((m) => m.principalId === id && m.kind === 'agent'),
    )
  ) {
    return invalid('Deferred native replay must name unique reviewed agent actors');
  }
  validateDesiredActorPolicy(input, desired);
  const deferredIds = new Set(input.deferredAgentPrincipalIds);
  const deferredRoles = new Set(
    input.memberships.flatMap((m) => (deferredIds.has(m.principalId) ? m.scopedRoles.map(toScopedRoleObjectId) : [])),
  );
  return { deferredRoles, desired, managed };
};
const observedGraph = (relationships: readonly v1.Relationship[]) => {
  const current = new Map<string, v1.Relationship>();
  for (const r of relationships) {
    if (!complete(r) || current.has(identity(r))) {
      return invalid('Graph inventory is incomplete or duplicated');
    }
    current.set(identity(r), r);
  }
  return current;
};

const managedPrincipalStructure = (row: v1.Relationship, managed: ReadonlySet<string>): boolean =>
  row.resource?.objectType === 'principal' &&
  managed.has(row.resource.objectId) &&
  ['self', 'tenant'].includes(row.relation);

/** No role labels, action-key prefixes, employment guesses, or SQL desired-grant ledger. */
export const planPeopleModelTransition = (input: PeopleModelTransitionInput): PeopleModelTransitionPlan => {
  const { deferredRoles, desired, managed } = validateReviewedInput(input);
  const current = observedGraph(input.observed.relationships);
  const principalStructureIds = new Set(input.memberships.map((member) => member.principalId));
  const managedRoleIds = new Set(
    input.desired.flatMap((r) =>
      r.resource?.objectType === 'scoped_role' &&
      r.relation === 'member' &&
      managed.has(r.subject?.object?.objectId ?? '')
        ? [r.resource.objectId]
        : [],
    ),
  );
  const owned = (r: v1.Relationship): boolean => {
    if (legacyAction(r)) {
      return true;
    }
    if (managedPrincipalStructure(r, principalStructureIds)) {
      return true;
    }
    const subject = r.subject?.object;
    if (subject?.objectType === 'scoped_role' && managedRoleIds.has(subject.objectId)) {
      return true;
    }
    if (r.resource?.objectType === 'scoped_role' && r.relation === 'member' && managed.has(subject?.objectId ?? '')) {
      return true;
    }
    if (subject?.objectType !== 'principal' || !managed.has(subject.objectId)) {
      return false;
    }
    // Operators, retail self-service and assigned records preserve identity/history, not blanket business roles.
    return (
      admission(r) || (directPolicyTypes.has(r.resource?.objectType ?? '') && r.relation !== 'self_service_grantee')
    );
  };
  const expected = new Map(current);
  const deletions: v1.Relationship[] = [];
  for (const r of current.values()) {
    if (owned(r)) {
      if (!unconditional(r)) {
        return invalid('Conditional owned authority requires an explicit reviewed transition');
      }
      const deferredPolicy =
        r.subject?.object?.objectType === 'scoped_role' && deferredRoles.has(r.subject.object.objectId);
      if (!desired.has(identity(r)) || deferredPolicy) {
        expected.delete(identity(r));
        deletions.push(r);
      }
    }
  }
  for (const r of desired.values()) {
    expected.set(identity(r), r);
  }
  const deleted = new Set(deletions.map(identity));
  const additions = [...desired.values()].filter((r) => !current.has(identity(r)) || deleted.has(identity(r)));
  const fingerprint = createHash('sha256')
    .update(
      [
        input.reviewedInputSha256,
        input.compositionRevision,
        input.observed.schema,
        ONTOS_SPICEDB_SCHEMA,
        ...sorted([...current.values()]).map(serialized),
        '--target--',
        ...sorted([...desired.values()]).map(serialized),
        '--deferred-native-replay--',
        ...input.deferredAgentPrincipalIds.toSorted(),
        '--memberships--',
        ...input.memberships
          .map((m) =>
            [
              m.tenantId,
              m.legalEntityId,
              m.principalId,
              m.kind,
              m.affiliation ?? '',
              m.status,
              ...m.scopedRoles.map(toScopedRoleObjectId).toSorted(),
            ]
              .map(encodeURIComponent)
              .join(':'),
          )
          .toSorted(),
      ]
        .map((part) => `${Buffer.byteLength(part)}:${part}`)
        .join(''),
    )
    .digest('hex');
  return {
    additions: sorted(additions),
    deletions: sorted(deletions),
    expected: sorted([...expected.values()]),
    fingerprint,
    initialAdditions: sorted(
      additions.filter(
        (r) => r.subject?.object?.objectType !== 'scoped_role' || !deferredRoles.has(r.subject.object.objectId),
      ),
    ),
    legacyBlanketExecutors: deletions.filter(
      (r) =>
        r.resource?.objectType === 'action' && r.relation === 'executor' && r.subject?.object?.objectType === 'tenant',
    ).length,
    memberships: input.memberships,
    preservedRecordGrants: [...expected.values()].filter(
      (r) => r.resource?.objectType === 'resource' && r.subject?.object?.objectType === 'principal',
    ).length,
  };
};

/** Compare the entire graph, including preserved fixtures/self-service, not merely requested positive grants. */
export const verifyPeopleModelTransitionGraph = (
  plan: PeopleModelTransitionPlan,
  relationships: readonly v1.Relationship[],
): void => {
  const actual = sorted(relationships).map(serialized);
  const expected = sorted(plan.expected).map(serialized);
  if (actual.length !== expected.length || actual.some((row, i) => row !== expected[i])) {
    return invalid('Post-transition graph differs from the exact reviewed target or preserved evidence');
  }
};

export interface PeopleModelTransitionGraphClient<Requirements = never> {
  /** Required native Action audit + replacement for deferred profiles, after the human role/schema cutover. */
  readonly completeDeferredPolicies: Effect.Effect<unknown, PeopleModelTransitionError, Requirements>;
  readonly snapshot: Effect.Effect<PeopleModelTransitionSnapshot, PeopleModelTransitionError>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<unknown, PeopleModelTransitionError>;
  readonly writeSchema: (request: v1.WriteSchemaRequest) => Effect.Effect<unknown, PeopleModelTransitionError>;
}

/** Caller owns sealed/drained admission and a session advisory lock, never a SQL transaction across this effect. */
export const applyPeopleModelTransitionSealedGraph = Effect.fn('PeopleModelTransition.applySealedGraph')(
  function* applySealedGraph(
    client: Omit<PeopleModelTransitionGraphClient, 'completeDeferredPolicies'>,
    input: PeopleModelTransitionInput,
    reviewedFingerprint: string,
  ) {
    const observed = yield* client.snapshot;
    const plan = yield* Effect.try({
      catch: (cause) =>
        new PeopleModelTransitionError({
          cause,
          reason: 'Fresh graph evidence no longer admits the reviewed transition',
        }),
      try: () => planPeopleModelTransition({ ...input, observed }),
    });
    if (plan.fingerprint !== reviewedFingerprint) {
      return yield* new PeopleModelTransitionError({
        reason: 'Reviewed transition fingerprint changed; no graph writes performed',
      });
    }
    const write = (relationships: readonly v1.Relationship[], operation: v1.RelationshipUpdate_Operation) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(relationships.length / 1000) }, (_, i) =>
          relationships.slice(i * 1000, (i + 1) * 1000),
        ),
        (batch) =>
          client.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: batch.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
            }),
          ),
        { concurrency: 1, discard: true },
      );
    // Remove in-use retired relations before changing the schema. Sealed admission stays closed on every failure.
    yield* write(plan.deletions, v1.RelationshipUpdate_Operation.DELETE);
    yield* client.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }));
    yield* write(plan.initialAdditions, v1.RelationshipUpdate_Operation.TOUCH);
    const after = yield* client.snapshot;
    const { deferredRoles } = validateReviewedInput(input);
    const sealedPlan = {
      ...plan,
      expected: plan.expected.filter(
        (r) => r.subject?.object?.objectType !== 'scoped_role' || !deferredRoles.has(r.subject.object.objectId),
      ),
    };
    yield* Effect.try({
      catch: (cause) =>
        new PeopleModelTransitionError({
          cause,
          reason: 'Exact post-transition graph verification failed; admission must remain sealed',
        }),
      try: () => verifyPeopleModelTransitionGraph(sealedPlan, after.relationships),
    });
    return plan;
  },
);

/** Explicit orchestration seam: the caller must perform native replacement publication before replay. */
export const applyPeopleModelTransitionGraph = Effect.fn('PeopleModelTransition.applyGraph')(function* applyGraph<
  Requirements,
>(
  client: PeopleModelTransitionGraphClient<Requirements>,
  input: PeopleModelTransitionInput,
  reviewedFingerprint: string,
) {
  const plan = yield* applyPeopleModelTransitionSealedGraph(client, input, reviewedFingerprint);
  yield* client.completeDeferredPolicies;
  const after = yield* client.snapshot;
  yield* Effect.try({
    catch: (cause) =>
      new PeopleModelTransitionError({
        cause,
        reason: 'Exact final graph verification failed; external traffic must remain stopped',
      }),
    try: () => verifyPeopleModelTransitionGraph(plan, after.relationships),
  });
  return plan;
});
