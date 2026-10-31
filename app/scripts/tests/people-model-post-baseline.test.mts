import { v1 } from '@authzed/authzed-node';
import type { ReviewedInvitationMembership } from '../people-model-post-baseline.mts';
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  admitPostBaselineRelationships,
  postBaselinePrincipals,
  reviewedAcceptedInvitationMembership,
} from '../people-model-post-baseline.mts';

const baseline = {
  capturedAt: DateTime.makeUnsafe('2026-10-24T15:30:28.411Z'),
  companies: [{ legal_entity_id: 'company', status: 'active', tenant_id: 'tenant' }],
  principals: [{ kind: 'human', principal_id: 'old', status: 'active', tenant_id: 'tenant' }],
  tenants: [{ status: 'active', tenant_id: 'tenant' }],
};
const old = {
  createdAt: '2026-10-23T00:00:00Z',
  kind: 'human',
  principalId: 'old',
  status: 'active',
  tenantId: 'tenant',
};
const fresh = { ...old, createdAt: '2026-10-24T17:24:45.263Z', principalId: 'new' };
const edge = (type: string, id: string, relation: string, subjectType: string, subjectId: string) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: id, objectType: type },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });
const sealed = [edge('tenant', 'tenant', 'member', 'principal', 'old')];
const structure = [
  edge('principal', 'new', 'self', 'principal', 'new'),
  edge('principal', 'new', 'tenant', 'tenant', 'tenant'),
];
const ctx = (parts: readonly string[]) => `ctx_${Buffer.from(JSON.stringify(parts)).toString('base64url')}`;
const enrollment = {
  legalEntityId: 'company',
  permission: 'retail.profile.read',
  principalId: 'new',
  profileId: 'profile',
  tenantId: 'tenant',
};
const resource = ctx(['retail.profile.read', 'tenant', 'company', 'retail_profile', 'profile']);
const retail = [
  edge('business_permission', resource, 'self_service_grantee', 'principal', 'new'),
  edge('business_permission', resource, 'legal_entity', 'legal_entity', ctx(['tenant', 'company'])),
];
const check = (actual: readonly v1.Relationship[], enrollments = [enrollment]) =>
  admitPostBaselineRelationships({
    actual,
    baseline,
    enrollments,
    principals: [old, fresh],
    reviewedInvitationMemberships: [],
    sealed,
  });
const rejected = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.flip, Effect.asVoid);

it.effect('accepts unchanged seal, exact new human structure, and completed native enrollment', () =>
  Effect.gen(function* admissionCase() {
    expect(yield* check(sealed)).toEqual([]);
    expect(yield* check([...sealed, ...structure])).toEqual(structure);
    expect(yield* check([...sealed, ...structure, ...retail])).toEqual([...structure, ...retail]);
  }),
);
it.effect('rejects unproved and incomplete retail enrollment shapes', () =>
  Effect.gen(function* admissionCase() {
    yield* rejected(check([...sealed, ...retail], []));
    yield* rejected(check([...sealed, retail[0]]));
    yield* rejected(check([...sealed, retail[1]]));
  }),
);
it.effect('rejects missing or changed archived identities and unsupported extra identities', () =>
  Effect.gen(function* admissionCase() {
    yield* rejected(postBaselinePrincipals(baseline, [fresh]));
    yield* rejected(postBaselinePrincipals(baseline, [{ ...old, status: 'inactive' }]));
    for (const change of [
      { kind: 'agent' },
      { kind: 'service' },
      { status: 'inactive' },
      { tenantId: 'foreign' },
      { createdAt: '2026-10-24T15:30:28.411Z' },
      { createdAt: 'bad' },
    ]) {
      yield* rejected(postBaselinePrincipals(baseline, [old, { ...fresh, ...change }]));
    }
    yield* rejected(postBaselinePrincipals(baseline, [old, fresh, fresh]));
  }),
);
it.effect('rejects old or unknown actor additions and role/operator/cross-principal authority', () =>
  Effect.gen(function* admissionCase() {
    for (const row of [
      edge('principal', 'old', 'self', 'principal', 'old'),
      edge('principal', 'unknown', 'self', 'principal', 'unknown'),
      edge('scoped_role', 'role', 'member', 'principal', 'new'),
      edge('tenant', 'tenant', 'member', 'principal', 'new'),
      edge('principal', 'new', 'operator', 'principal', 'old'),
      edge('principal', 'new', 'self', 'principal', 'old'),
      edge('principal', 'new', 'tenant', 'tenant', 'foreign'),
    ]) {
      yield* rejected(check([...sealed, row]));
    }
  }),
);
it.effect('rejects caveats, expiration, usersets and duplicate tuples', () =>
  Effect.gen(function* admissionCase() {
    for (const row of [
      v1.Relationship.create({ ...structure[0], optionalCaveat: { caveatName: 'conditional' } }),
      v1.Relationship.create({ ...structure[0], optionalExpiresAt: { seconds: '123' } }),
      v1.Relationship.create({
        ...structure[0],
        subject: { object: { objectId: 'new', objectType: 'principal' }, optionalRelation: 'self' },
      }),
    ]) {
      yield* rejected(check([...sealed, row]));
    }
    yield* rejected(check([...sealed, ...structure, structure[0]]));
  }),
);
it.effect('rejects other retail holders/relations, unknown company or permission, multiple holders', () =>
  Effect.gen(function* admissionCase() {
    yield* rejected(
      check([...sealed, ...retail, edge('business_permission', resource, 'self_service_grantee', 'principal', 'old')]),
    );
    yield* rejected(
      check([...sealed, ...retail, edge('business_permission', resource, 'grantee', 'principal', 'new')]),
    );
    yield* rejected(check([...sealed, ...retail], [{ ...enrollment, legalEntityId: 'foreign' }]));
    yield* rejected(check([...sealed, ...retail], [{ ...enrollment, permission: 'arbitrary.admin' }]));
    yield* rejected(
      admitPostBaselineRelationships({
        actual: [...sealed, ...retail],
        baseline,
        enrollments: [enrollment, { ...enrollment, principalId: 'other' }],
        principals: [old, fresh, { ...fresh, principalId: 'other' }],
        reviewedInvitationMemberships: [],
        sealed,
      }),
    );
  }),
);
it.effect('rejects missing sealed tuples and changing an archived resource', () =>
  Effect.gen(function* admissionCase() {
    yield* rejected(check(structure));
    yield* rejected(
      admitPostBaselineRelationships({
        actual: [...sealed, ...retail],
        baseline,
        enrollments: [enrollment],
        principals: [old, fresh],
        reviewedInvitationMemberships: [],
        sealed: [...sealed, retail[1]],
      }),
    );
  }),
);

const reviewed = reviewedAcceptedInvitationMembership;
const proofBaseline = {
  ...baseline,
  companies: [
    ...baseline.companies,
    { legal_entity_id: reviewed.legalEntityId, status: 'active', tenant_id: reviewed.tenantId },
  ],
  tenants: [...baseline.tenants, { status: 'active', tenant_id: reviewed.tenantId }],
};
const proofPrincipal = { ...fresh, principalId: reviewed.principalId, tenantId: reviewed.tenantId };
const proofMembership = { ...reviewed, companyStatus: 'active', tenantStatus: 'active' };
const proofPair = [
  edge('tenant', reviewed.tenantId, 'company_member', 'principal', reviewed.principalId),
  edge('legal_entity', ctx([reviewed.tenantId, reviewed.legalEntityId]), 'member', 'principal', reviewed.principalId),
];
const checkProof = (
  actual: readonly v1.Relationship[],
  reviewedInvitationMemberships: readonly ReviewedInvitationMembership[] = [proofMembership],
  principal = proofPrincipal,
) =>
  admitPostBaselineRelationships({
    actual,
    baseline: proofBaseline,
    enrollments: [],
    principals: [old, principal],
    reviewedInvitationMemberships,
    sealed,
  });
it.effect('admits only the exact SQL-proven accepted external invitation pair with no roles', () =>
  Effect.gen(function* admissionCase() {
    expect(yield* checkProof([...sealed, ...proofPair])).toEqual(proofPair);
    expect(yield* checkProof(sealed)).toEqual([]);
    yield* rejected(checkProof([...sealed, ...proofPair], []));
    yield* rejected(checkProof([...sealed, proofPair[0]]));
    yield* rejected(checkProof([...sealed, proofPair[1]]));
    yield* rejected(checkProof(proofPair));
    yield* rejected(checkProof([...sealed, ...proofPair], [proofMembership, proofMembership]));
    for (const change of [
      { principalId: 'other' },
      { tenantId: 'other' },
      { legalEntityId: 'other' },
      { affiliation: 'employee' },
      { revision: 1 },
      { status: 'invited' },
      { status: 'disabled' },
      { status: 'departed' },
      { companyStatus: 'inactive' },
      { tenantStatus: 'inactive' },
    ]) {
      yield* rejected(checkProof([...sealed, ...proofPair], [{ ...proofMembership, ...change }]));
    }
    yield* rejected(checkProof([...sealed, ...proofPair], [proofMembership], { ...proofPrincipal, kind: 'agent' }));
    yield* rejected(
      checkProof([...sealed, ...proofPair], [proofMembership], { ...proofPrincipal, createdAt: old.createdAt }),
    );
    for (const row of [
      edge('scoped_role', 'role', 'member', 'principal', reviewed.principalId),
      edge('tenant', reviewed.tenantId, 'member', 'principal', reviewed.principalId),
      v1.Relationship.create({ ...proofPair[0], optionalCaveat: { caveatName: 'conditional' } }),
      v1.Relationship.create({ ...proofPair[0], optionalExpiresAt: { seconds: '123' } }),
      v1.Relationship.create({
        ...proofPair[0],
        subject: { object: { objectId: reviewed.principalId, objectType: 'principal' }, optionalRelation: 'self' },
      }),
    ]) {
      yield* rejected(checkProof([...sealed, ...proofPair, row]));
    }
  }),
);
