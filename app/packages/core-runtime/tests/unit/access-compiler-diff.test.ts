import { v1 } from '@authzed/authzed-node';
import { Option, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { diffProjection, verifyProjection } from '../../src/access/compiler/diff.ts';
import {
  capabilityObjectId,
  grantObjectId,
  legalEntityObjectId,
  objectTypeOf,
  roleBindingObjectId,
  scopeObjectId,
  tenantObjectId,
  tenantObjectIdPrefix,
} from '../../src/access/compiler/object-id.ts';
import type { ProjectionPlan } from '../../src/access/compiler/plan.ts';
import { planAccessProjection } from '../../src/access/compiler/plan.ts';
import type { AccessRelationship } from '../../src/access/compiler/relationship.ts';
import {
  duplicateTupleIdentities,
  relationshipIdentity,
  uniqueRelationships,
} from '../../src/access/compiler/relationship.ts';
import { fromSpiceDbRelationship } from '../../src/access/compiler/spicedb-relationship.ts';
import {
  ALICE,
  BOB,
  CAP_NOTE,
  CAP_PAY,
  ENTITY,
  ROLE,
  SCOPE,
  SECOND_ASSIGNMENT,
  UNTIL,
  OTHER_SCOPE,
  assignment,
  cell,
  ceiling,
  human,
  projectionIntent,
  revision,
  TENANT,
} from './access-compiler-fixtures.ts';

const planOf = (overrides: Parameters<typeof projectionIntent>[0] = {}): ProjectionPlan => {
  const planned = planAccessProjection(projectionIntent(overrides));
  if (Result.isFailure(planned)) {
    throw new Error(`expected a plan, got ${planned.failure.map((error) => error.code).join(', ')}`);
  }
  return planned.success;
};

const tuplesOf = (plan: ProjectionPlan): readonly AccessRelationship[] =>
  plan.units.flatMap((unit) => unit.relationships);

const scopeObject = () => scopeObjectId(TENANT, SCOPE);

it('reports no mutation when the graph already holds the plan', () => {
  const plan = planOf();
  const diff = diffProjection(plan, tuplesOf(plan));
  expect(diff.touches).toEqual([]);
  expect(diff.deletions).toEqual([]);
  expect(diff.units).toEqual([]);
  expect(verifyProjection(plan, tuplesOf(plan)).ok).toBe(true);
});

it('touches only the three tuples of the cell a role edit adds, never a holder tuple', () => {
  const before = planOf();
  const after = planOf({
    roleRevisions: [
      revision({
        cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' }), cell({ capabilityKey: CAP_NOTE, mode: 'run' })],
      }),
    ],
  });
  const diff = diffProjection(after, tuplesOf(before));
  expect(diff.deletions).toEqual([]);
  // The grant cell is three tuples; the new capability object adds its scope and installation link.
  expect(diff.touches).toHaveLength(5);
  expect(diff.touches.map((relationship) => relationship.relation).toSorted()).toEqual([
    'binding',
    'capability',
    'installation',
    'run_all_grant',
    'scope',
  ]);
  expect(diff.touches.some((relationship) => relationship.relation === 'member')).toBe(false);
  expect(diff.touches.some((relationship) => relationship.relation === 'holder')).toBe(false);
});

it('touches nothing when a second holder joins a role that already exists', () => {
  const before = planOf();
  const after = planOf({
    assignments: [assignment(), assignment({ holder: human(BOB), incarnationId: SECOND_ASSIGNMENT })],
  });
  const diff = diffProjection(after, tuplesOf(before));
  expect(diff.deletions).toEqual([]);
  expect(diff.touches.map((relationship) => relationship.relation).toSorted()).toEqual(['holder', 'member', 'scope']);
  expect(diff.touches.filter((relationship) => relationship.relation === 'holder')).toHaveLength(1);
});

it('rewrites one tuple when only an end date and one when only a ceiling changes', () => {
  const withoutEnd = planOf();
  const withEnd = planOf({ assignments: [assignment({ validUntil: UNTIL })] });
  const endDiff = diffProjection(withEnd, tuplesOf(withoutEnd));
  expect(endDiff.deletions).toEqual([]);
  expect(endDiff.touches).toHaveLength(1);
  expect(endDiff.touches[0]?.expiresAtEpochSeconds).toBe(Math.floor(UNTIL.getTime() / 1000));

  const cheaper = planOf({
    roleRevisions: [revision({ cells: [cell({ amountCeiling: ceiling(100), capabilityKey: CAP_PAY, mode: 'run' })] })],
  });
  const dearer = planOf({
    roleRevisions: [revision({ cells: [cell({ amountCeiling: ceiling(500), capabilityKey: CAP_PAY, mode: 'run' })] })],
  });
  // One tuple, one identity: the engine replaces its content on a TOUCH, so a changed ceiling is
  // never also a DELETE of the same identity (which the engine refuses outright, H4).
  const ceilingDiff = diffProjection(dearer, tuplesOf(cheaper));
  expect(ceilingDiff.touches).toHaveLength(1);
  expect(ceilingDiff.deletions).toEqual([]);
  expect(ceilingDiff.touches[0]?.caveat?.context['limit_minor']).toBe(500);
  const currentBinding = tuplesOf(cheaper).find(
    (relationship) => relationship.relation === 'binding' && relationship.caveat !== undefined,
  );
  const [touched] = ceilingDiff.touches;
  expect(touched === undefined ? 'none' : relationshipIdentity(touched)).toBe(
    currentBinding === undefined ? 'current' : relationshipIdentity(currentBinding),
  );
});

it('deletes a managed tuple the intent no longer asks for', () => {
  const plan = planOf();
  const stale: AccessRelationship = {
    relation: 'run_all_grant',
    resourceId: capabilityObjectId(TENANT, SCOPE, CAP_NOTE),
    resourceType: 'access_capability',
    subject: { objectId: 'gr_stale', objectType: 'access_grant' },
  };
  const diff = diffProjection(plan, [...tuplesOf(plan), stale]);
  expect(diff.touches).toEqual([]);
  expect(diff.deletions).toHaveLength(1);
  expect(diff.deletions[0]?.subject.objectId).toBe('gr_stale');
  const verification = verifyProjection(plan, [...tuplesOf(plan), stale]);
  expect(verification.ok).toBe(false);
  expect(verification.drift.map((entry) => entry.kind)).toEqual(['unexpected']);
});

const prefixOf = (type: 'legal_entity' | 'scope' | 'tenant', tenantId: string) =>
  Option.getOrThrow(tenantObjectIdPrefix(objectTypeOf(type), tenantId));

it('narrows an engine read to one tenant by the ID prefix every object of that tenant shares', () => {
  const otherTenant = '00000000-0000-4000-8000-0000000000ff';
  expect(tenantObjectId(TENANT).startsWith(prefixOf('tenant', TENANT))).toBe(true);
  expect(legalEntityObjectId(TENANT, ENTITY).startsWith(prefixOf('legal_entity', TENANT))).toBe(true);
  expect(scopeObjectId(TENANT, SCOPE).startsWith(prefixOf('scope', TENANT))).toBe(true);
  expect(scopeObjectId(otherTenant, SCOPE).startsWith(prefixOf('scope', TENANT))).toBe(false);
  expect(Option.isNone(tenantObjectIdPrefix('legacy_object', TENANT))).toBe(true);
});

it('never deletes a tuple of another tenant or of a relation another lane owns', () => {
  const plan = planOf();
  const foreign: AccessRelationship[] = [
    {
      relation: 'scope',
      resourceId: capabilityObjectId(ALICE, SCOPE, CAP_PAY),
      resourceType: 'access_capability',
      subject: { objectId: scopeObject(), objectType: 'access_scope' },
    },
    {
      relation: 'assigned_match',
      resourceId: 'record-1',
      resourceType: 'access_record',
      subject: { objectId: ALICE, objectType: 'principal' },
    },
    {
      relation: 'scope',
      resourceId: legalEntityObjectId(ALICE, ENTITY),
      resourceType: 'access_legal_entity',
      subject: { objectId: tenantObjectId(ALICE), objectType: 'access_tenant' },
    },
  ];
  const diff = diffProjection(plan, [...tuplesOf(plan), ...foreign]);
  expect(diff.deletions).toEqual([]);
  expect(verifyProjection(plan, [...tuplesOf(plan), ...foreign]).ok).toBe(true);
});

it('reports a missing and a stale tuple as drift', () => {
  const plan = planOf({ assignments: [assignment({ validUntil: UNTIL })] });
  const tuples = tuplesOf(plan);
  const missing = tuples.filter((relationship) => relationship.relation !== 'run_all_grant');
  const missingVerification = verifyProjection(plan, missing);
  expect(missingVerification.drift.map((entry) => entry.kind)).toEqual(['missing']);

  const stale = tuples.map((relationship) =>
    relationship.relation === 'holder' ? { ...relationship, expiresAtEpochSeconds: 1 } : relationship,
  );
  const staleVerification = verifyProjection(plan, stale);
  expect(staleVerification.drift).toHaveLength(1);
  expect(staleVerification.drift[0]?.kind).toBe('stale');
  const [drifted] = staleVerification.drift;
  const staleHolder = stale.find((relationship) => relationship.relation === 'holder');
  expect(drifted === undefined ? 'no drift' : relationshipIdentity(drifted.relationship)).toBe(
    staleHolder === undefined ? 'no holder' : relationshipIdentity(staleHolder),
  );

  const diff = diffProjection(plan, stale);
  expect(diff.touches).toHaveLength(1);
  expect(diff.deletions).toEqual([]);
});

it('empties a unit whose intent is gone only when it is named as removed', () => {
  const plan = planOf();
  const removedScope = scopeObjectId(TENANT, OTHER_SCOPE);
  const orphaned: AccessRelationship[] = [
    {
      relation: 'scope',
      resourceId: capabilityObjectId(TENANT, OTHER_SCOPE, CAP_PAY),
      resourceType: 'access_capability',
      subject: { objectId: removedScope, objectType: 'access_scope' },
    },
    {
      relation: 'tenant',
      resourceId: removedScope,
      resourceType: 'access_scope',
      subject: { objectId: tenantObjectId(TENANT), objectType: 'access_tenant' },
    },
  ];
  const removedUnits = [{ kind: 'scope', objectId: removedScope } as const];
  const diff = diffProjection(plan, [...tuplesOf(plan), ...orphaned], removedUnits);
  expect(diff.deletions).toHaveLength(2);
  expect(diff.touches).toEqual([]);
  expect(diff.units.map((unit) => unit.key)).toEqual([`scope:${removedScope}`]);
  // The stale unit is drift until it is deleted; afterwards the graph equals the plan again.
  expect(verifyProjection(plan, [...tuplesOf(plan), ...orphaned], removedUnits).ok).toBe(false);
  expect(verifyProjection(plan, tuplesOf(plan), removedUnits).ok).toBe(true);
  expect(diffProjection(plan, [...tuplesOf(plan), ...orphaned], []).deletions).toEqual([]);
});

it('leaves a unit the plan does not name untouched even when the read contains it', () => {
  const plan = planOf();
  const tuple: AccessRelationship = {
    relation: 'scope',
    resourceId: capabilityObjectId(TENANT, OTHER_SCOPE, CAP_PAY),
    resourceType: 'access_capability',
    subject: { objectId: scopeObjectId(TENANT, OTHER_SCOPE), objectType: 'access_scope' },
  };
  const diff = diffProjection(plan, [...tuplesOf(plan), tuple]);
  expect(diff.deletions).toEqual([]);
  expect(diff.touches).toEqual([]);
  expect(verifyProjection(plan, [...tuplesOf(plan), tuple]).ok).toBe(true);
});

it('keeps one identity per tuple and reports an identity stated twice with different content (H4)', () => {
  const lower = {
    caveat: { context: { limit_currency: 'CZK', limit_minor: 10 }, name: 'amount_ceiling' as const },
    relation: 'binding',
    resourceId: 'gr_one',
    resourceType: 'access_grant',
    subject: { objectId: 'rb_one', objectType: 'access_role_binding' },
  };
  const higher = { ...lower, caveat: { ...lower.caveat, context: { limit_currency: 'CZK', limit_minor: 20 } } };
  expect(duplicateTupleIdentities([lower, higher])).toEqual([relationshipIdentity(lower)]);
  // One identity, one tuple: the last content wins and both are never written.
  expect(uniqueRelationships([lower, higher])).toEqual([higher]);
  expect(duplicateTupleIdentities([lower, { ...lower, expiresAtEpochSeconds: 1 }])).toHaveLength(1);
  // The planner itself never produces such a collision.
  expect(duplicateTupleIdentities(planOf().units.flatMap((unit) => unit.relationships))).toEqual([]);
});

it('reports a managed tuple the compiler cannot decode as unexpected and deletes it (L4)', () => {
  const plan = planOf();
  const tuples = tuplesOf(plan);
  // A grant binding whose caveat the compiler does not own: the identity is readable, the content is
  // not, so it must be visible drift instead of an invisible leftover.
  const undecodable = fromSpiceDbRelationship(
    v1.Relationship.create({
      optionalCaveat: v1.ContextualizedCaveat.create({
        caveatName: 'legacy_ceiling',
        context: v1.createStructFromObject({ limit_minor: 10 }),
      }),
      relation: 'binding',
      resource: v1.ObjectReference.create({
        objectId: grantObjectId(TENANT, SCOPE, ROLE, cell({ capabilityKey: CAP_NOTE, mode: 'run' })),
        objectType: 'access_grant',
      }),
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectId: roleBindingObjectId(TENANT, SCOPE, ROLE),
          objectType: 'access_role_binding',
        }),
      }),
    }),
  );
  expect(Option.isSome(undecodable)).toBe(true);
  const tuple = Option.getOrThrow(undecodable);
  expect(tuple.undecodable).toBe(true);
  expect(verifyProjection(plan, [...tuples, tuple]).drift.map((entry) => entry.kind)).toEqual(['unexpected']);
  const diff = diffProjection(plan, [...tuples, tuple]);
  expect(diff.deletions).toHaveLength(1);
  expect(diff.deletions[0]?.caveat).toBeUndefined();
  expect(diff.touches).toEqual([]);
});
