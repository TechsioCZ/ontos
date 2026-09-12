import { describe, expect, it } from 'effect-rstest';
import { Match, Schema } from 'effect';
import {
  archiveCustomerGroup,
  assignCustomerGroupMembership,
  effectiveCustomerGroupMemberships,
  makeCustomerGroup,
  reactivateCustomerGroup,
  removeCustomerGroupMembership,
  reviseCustomerGroup,
} from '../../shared/domain/group-service.ts';
import type {
  CommerceCustomerGroup,
  CommerceCustomerGroupMembership,
  CommerceCustomerProfileSubject,
} from '../../shared/domain/group-contract.ts';
import { CustomerGroupMeaningKeySchema } from '../../shared/domain/group-contract.ts';
import { CustomerGroupMembershipRefSchema } from '../../shared/resources/customer-group-membership.ts';
import { CustomerGroupRefSchema } from '../../shared/resources/customer-group.ts';
import type { CustomerGroupRef } from '../../shared/resources/customer-group.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const groupRef = Schema.decodeUnknownSync(CustomerGroupRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
});
const otherGroupRef = Schema.decodeUnknownSync(CustomerGroupRefSchema)({
  ...groupRef,
  resourceId: '20000000-0000-4000-8000-000000000002',
});
const profile: CommerceCustomerProfileSubject = {
  profileKind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '30000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
};

const createGroup = (ref = groupRef, recordedAt = '2026-01-01T00:00:00.000Z'): CommerceCustomerGroup =>
  makeCustomerGroup({
    businessCode: ref === groupRef ? 'DEALERS' : 'STRATEGIC_CUSTOMERS',
    description: 'Staff-facing explanation of the approved segment.',
    groupRef: ref,
    meaningKey: Schema.decodeUnknownSync(CustomerGroupMeaningKeySchema)(
      ref === groupRef ? 'dealer.relationship' : 'strategic.relationship',
    ),
    membershipCriteria: 'A current signed dealer agreement exists.',
    name: ref === groupRef ? 'Dealers' : 'Strategic customers',
    purpose: 'Segment profiles with an explainable commercial relationship.',
    reason: 'Initial approved segmentation catalog',
    recordedAt,
  });

const membership = (
  id: string,
  group: CustomerGroupRef = groupRef,
  effectiveFrom = '2026-02-01T00:00:00.000Z',
  effectiveTo: null | string = null,
): CommerceCustomerGroupMembership => ({
  assignedAt: '2026-01-15T00:00:00.000Z',
  assignmentReason: 'Approved account segmentation',
  effectiveFrom,
  effectiveTo,
  groupRef: group,
  membershipRef: Schema.decodeUnknownSync(CustomerGroupMembershipRefSchema)({
    moduleId: 'commerce.customer-context',
    resourceId: id,
    resourceType: 'commerce.customer-context.customer-group-membership',
    tenantId,
  }),
  profile,
  removal: null,
  revision: 1,
  state: 'VALID',
});

const isNewGroupRequired = (outcome: ReturnType<typeof reviseCustomerGroup>): boolean =>
  Match.value(outcome).pipe(
    Match.tag('new_group_required', () => true),
    Match.orElse(() => false),
  );

const archivedGroupFixture = (): CommerceCustomerGroup => {
  const archived = archiveCustomerGroup(createGroup(), [], {
    effectiveAt: '2026-04-01T00:00:00.000Z',
    expectedRevision: 1,
    reason: 'Segment retired',
    recordedAt: '2026-04-01T00:00:00.000Z',
  });
  const archivedGroup = Match.value(archived).pipe(
    Match.tag('archived', ({ group }) => group),
    Match.orElse(() => null),
  );
  expect(archivedGroup).not.toBeNull();
  if (archivedGroup === null) {
    throw new Error('fixture must archive');
  }
  return archivedGroup;
};

describe('Commerce Customer Group domain', () => {
  it('keeps identity and criteria stable while appending an auditable presentation revision', () => {
    const original = createGroup();
    const result = reviseCustomerGroup(original, {
      description: 'A clearer staff-facing explanation of the same approved segment.',
      expectedRevision: 1,
      membershipCriteria: original.currentDefinition.membershipCriteria,
      name: 'Authorised dealers',
      purpose: original.currentDefinition.purpose,
      reason: 'Improve staff-facing wording',
      recordedAt: '2026-01-02T00:00:00.000Z',
    });

    const updated = Match.value(result).pipe(
      Match.tag('updated', (value) => value),
      Match.orElse(() => null),
    );
    expect(updated).not.toBeNull();
    expect(updated?.group.groupRef).toEqual(groupRef);
    expect(updated?.group.currentDefinition.revision).toBe(2);
    expect(updated?.group.currentDefinition.changeKind).toBe('DESCRIPTION_CLARIFICATION');
    expect(updated?.group.currentDefinition.membershipCriteria).toBe(original.currentDefinition.membershipCriteria);
    expect(updated?.group.definitionHistory).toHaveLength(2);
    expect(updated?.group.definitionHistory[0]).toEqual(original.currentDefinition);
  });

  it('requires a new group when criteria or stable purpose changes', () => {
    const original = createGroup();
    const criteriaChange = reviseCustomerGroup(original, {
      description: original.currentDefinition.description,
      expectedRevision: 1,
      membershipCriteria: 'Any profile with annual sales above a threshold.',
      name: original.currentDefinition.name,
      purpose: original.currentDefinition.purpose,
      reason: 'Change the segment',
      recordedAt: '2026-01-02T00:00:00.000Z',
    });
    const purposeChange = reviseCustomerGroup(original, {
      description: original.currentDefinition.description,
      expectedRevision: 1,
      membershipCriteria: original.currentDefinition.membershipCriteria,
      name: original.currentDefinition.name,
      purpose: 'A materially different customer relationship.',
      reason: 'Attempt to redefine the segment',
      recordedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(isNewGroupRequired(criteriaChange)).toBe(true);
    expect(isNewGroupRequired(purposeChange)).toBe(true);
  });

  it('rejects stale definition revisions instead of applying last-write-wins', () => {
    const result = reviseCustomerGroup(createGroup(), {
      description: 'Staff-facing explanation of the approved segment.',
      expectedRevision: 9,
      membershipCriteria: 'A current signed dealer agreement exists.',
      name: 'Dealers',
      purpose: 'Segment profiles with an explainable commercial relationship.',
      reason: 'Correct typo',
      recordedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(
      Match.value(result).pipe(
        Match.tag('revision_conflict', ({ actualRevision }) => actualRevision),
        Match.orElse(() => null),
      ),
    ).toBe(1);
  });

  it('fails closed on archived corrections without an authoritative correction policy', () => {
    const archived = archiveCustomerGroup(createGroup(), [], {
      effectiveAt: '2026-04-01T00:00:00.000Z',
      expectedRevision: 1,
      reason: 'Segment retired',
      recordedAt: '2026-04-01T00:00:00.000Z',
    });
    const archivedGroup = Match.value(archived).pipe(
      Match.tag('archived', ({ group }) => group),
      Match.orElse(() => null),
    );
    expect(archivedGroup).not.toBeNull();
    if (archivedGroup === null) {
      throw new Error('fixture must archive');
    }
    const correction = reviseCustomerGroup(archivedGroup, {
      description: 'A corrected staff-facing explanation.',
      expectedRevision: archivedGroup.revision,
      membershipCriteria: archivedGroup.currentDefinition.membershipCriteria,
      name: archivedGroup.currentDefinition.name,
      purpose: archivedGroup.currentDefinition.purpose,
      reason: 'Correct archived wording',
      recordedAt: '2026-04-02T00:00:00.000Z',
    });
    expect(
      Match.value(correction).pipe(
        Match.tag('archived_correction_forbidden', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
  });

  it('allows concurrent memberships in different groups but rejects overlap for one pair', () => {
    const first = membership('40000000-0000-4000-8000-000000000001');
    const duplicate = membership('40000000-0000-4000-8000-000000000002');
    const overlap = membership('40000000-0000-4000-8000-000000000003', groupRef, '2026-03-01T00:00:00.000Z');
    const anotherGroup = membership('40000000-0000-4000-8000-000000000004', otherGroupRef, '2026-03-01T00:00:00.000Z');

    expect(
      Match.value(assignCustomerGroupMembership(createGroup(), 'ACTIVE', [first], duplicate)).pipe(
        Match.tag('already_assigned', ({ membership: found }) => found),
        Match.orElse(() => null),
      ),
    ).toEqual(first);
    expect(
      Match.value(assignCustomerGroupMembership(createGroup(), 'ACTIVE', [first], overlap)).pipe(
        Match.tag('overlap', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(
      Match.value(assignCustomerGroupMembership(createGroup(otherGroupRef), 'ACTIVE', [first], anotherGroup)).pipe(
        Match.tag('assigned', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
  });

  it('uses inclusive starts, exclusive ends, and deterministic all-membership ordering', () => {
    const dealers = createGroup();
    const strategic = createGroup(otherGroupRef);
    const laterId = '40000000-0000-4000-8000-000000000009';
    const earlierId = '40000000-0000-4000-8000-000000000001';
    const periods = [
      membership(laterId, otherGroupRef, '2026-02-01T00:00:00.000Z'),
      membership(earlierId, groupRef, '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    ];

    expect(
      effectiveCustomerGroupMemberships(
        [dealers, strategic],
        periods,
        profile,
        'ACTIVE',
        '2026-02-01T00:00:00.000Z',
      ).map(({ membershipRef }) => membershipRef.resourceId),
    ).toEqual([earlierId, laterId]);
    expect(
      effectiveCustomerGroupMemberships(
        [dealers, strategic],
        periods,
        profile,
        'ACTIVE',
        '2026-03-01T00:00:00.000Z',
      ).map(({ membershipRef }) => membershipRef.resourceId),
    ).toEqual([laterId]);
  });

  it('archives atomically by ending effective memberships and cancelling future periods', () => {
    const current = membership('40000000-0000-4000-8000-000000000001', groupRef, '2026-02-01T00:00:00.000Z');
    const future = membership('40000000-0000-4000-8000-000000000002', groupRef, '2026-05-01T00:00:00.000Z');
    const result = archiveCustomerGroup(createGroup(), [current, future], {
      effectiveAt: '2026-04-01T00:00:00.000Z',
      expectedRevision: 1,
      reason: 'Segment retired',
      recordedAt: '2026-04-01T00:00:00.000Z',
    });

    const archived = Match.value(result).pipe(
      Match.tag('archived', (value) => value),
      Match.orElse(() => null),
    );
    expect(archived?.endedCount).toBe(1);
    expect(archived?.cancelledCount).toBe(1);
    expect(archived?.memberships[0]?.effectiveTo).toBe('2026-04-01T00:00:00.000Z');
    expect(archived?.memberships[1]?.state).toBe('CANCELLED');
  });

  it('reactivates the same identity without restoring memberships', () => {
    const archivedGroup = archivedGroupFixture();
    const result = reactivateCustomerGroup(archivedGroup, {
      effectiveAt: '2026-06-01T00:00:00.000Z',
      expectedRevision: 2,
      reason: 'Segment approved again',
      recordedAt: '2026-06-01T00:00:00.000Z',
    });

    const reactivated = Match.value(result).pipe(
      Match.tag('reactivated', (value) => value),
      Match.orElse(() => null),
    );
    expect(reactivated?.group.groupRef).toEqual(groupRef);
    expect(reactivated?.group.lifecycleHistory).toHaveLength(2);
  });

  it('treats the same archive state as idempotent even with the original revision', () => {
    const archivedGroup = archivedGroupFixture();
    const replay = archiveCustomerGroup(archivedGroup, [], {
      effectiveAt: '2026-04-01T00:00:00.000Z',
      expectedRevision: 1,
      reason: 'Segment retired',
      recordedAt: '2026-04-02T00:00:00.000Z',
    });
    expect(
      Match.value(replay).pipe(
        Match.tag('archived', ({ changed }) => changed),
        Match.orElse(() => true),
      ),
    ).toBe(false);
  });

  it('cancels never-effective future memberships without inventing effective history', () => {
    const future = membership('40000000-0000-4000-8000-000000000001', groupRef, '2026-05-01T00:00:00.000Z');
    const result = removeCustomerGroupMembership(future, {
      effectiveAt: '2026-04-10T00:00:00.000Z',
      reason: 'Assignment withdrawn',
      recordedAt: '2026-04-01T00:00:00.000Z',
    });

    const removed = Match.value(result).pipe(
      Match.tag('removed', (value) => value),
      Match.orElse(() => null),
    );
    expect(removed?.membership.state).toBe('CANCELLED');
    const removedMemberships = removed === null ? [] : [removed.membership];
    expect(
      effectiveCustomerGroupMemberships(
        [createGroup()],
        removedMemberships,
        profile,
        'ACTIVE',
        '2026-05-15T00:00:00.000Z',
      ),
    ).toEqual([]);
  });

  it('treats an exact cancelled-period reassignment as replay instead of resurrecting it', () => {
    const future = membership('40000000-0000-4000-8000-000000000001', groupRef, '2026-05-01T00:00:00.000Z');
    const removal = removeCustomerGroupMembership(future, {
      effectiveAt: '2026-04-10T00:00:00.000Z',
      reason: 'Assignment withdrawn',
      recordedAt: '2026-04-01T00:00:00.000Z',
    });
    const cancelled = Match.value(removal).pipe(
      Match.tag('removed', ({ membership: value }) => value),
      Match.orElse(() => null),
    );
    expect(cancelled).not.toBeNull();
    if (cancelled === null) {
      throw new Error('fixture must cancel');
    }
    const replay = assignCustomerGroupMembership(createGroup(), 'ACTIVE', [cancelled], future);
    expect(
      Match.value(replay).pipe(
        Match.tag('already_assigned', ({ membership: value }) => value),
        Match.orElse(() => null),
      ),
    ).toEqual(cancelled);
  });

  it('replays an exact archived cancellation before mutable group and profile lifecycle gates', () => {
    const future = membership('40000000-0000-4000-8000-000000000001', groupRef, '2026-05-01T00:00:00.000Z');
    const archive = archiveCustomerGroup(createGroup(), [future], {
      effectiveAt: '2026-04-10T00:00:00.000Z',
      expectedRevision: 1,
      reason: 'Group retired before the scheduled membership',
      recordedAt: '2026-04-10T00:00:00.000Z',
    });
    const archived = Match.value(archive).pipe(
      Match.tag('archived', (value) => value),
      Match.orElse(() => null),
    );
    expect(archived).not.toBeNull();
    if (archived === null) {
      throw new Error('fixture must archive');
    }
    const replay = assignCustomerGroupMembership(archived.group, 'SUSPENDED', archived.memberships, future);
    expect(
      Match.value(replay).pipe(
        Match.tag('already_assigned', ({ membership: value }) => value.state),
        Match.orElse(() => null),
      ),
    ).toBe('CANCELLED');
  });

  it('allows a future assignment to become effective before its scheduled end', () => {
    const future = membership('40000000-0000-4000-8000-000000000001', groupRef, '2026-05-01T00:00:00.000Z');
    const result = removeCustomerGroupMembership(future, {
      effectiveAt: '2026-06-01T00:00:00.000Z',
      reason: 'Membership scheduled to end',
      recordedAt: '2026-04-01T00:00:00.000Z',
    });
    const removed = Match.value(result).pipe(
      Match.tag('removed', ({ membership: value }) => value),
      Match.orElse(() => null),
    );
    expect(removed?.state).toBe('VALID');
    expect(removed?.effectiveTo).toBe('2026-06-01T00:00:00.000Z');
    expect(
      effectiveCustomerGroupMemberships(
        [createGroup()],
        removed === null ? [] : [removed],
        profile,
        'ACTIVE',
        '2026-05-15T00:00:00.000Z',
      ),
    ).toHaveLength(1);
    expect(
      effectiveCustomerGroupMemberships(
        [createGroup()],
        removed === null ? [] : [removed],
        profile,
        'ACTIVE',
        '2026-06-01T00:00:00.000Z',
      ),
    ).toEqual([]);
  });
});
