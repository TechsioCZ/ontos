import { expect, it } from 'effect-rstest';
/* eslint-disable anti-slop/no-chained-type-assertions -- Focused harness implements only the mutation insert's Drizzle seam. expires: 2026-12-31. */
import { DateTime, Effect, Predicate } from 'effect';
import type { OrganizationEngagementProfileRecord } from '../../src/db/engagement-schema.ts';
import {
  createOrganizationEngagementProfile,
  ensureReferencesBelongToTenant,
  organizationEngagementProfileFromRecord,
} from '../../src/services/engagement-profile-persistence.service.ts';

const tenantId = 'c1000000-0000-4000-8000-000000000001';
const refs = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'c4000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'c2000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
    tenantId,
  },
} as const;

const row: OrganizationEngagementProfileRecord = {
  archivedAt: null,
  counterpartyResourceId: refs.counterpartyRef.resourceId,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-03T08:00:00.000Z')),
  engagementProfileId: 'c5000000-0000-4000-8000-000000000001',
  partyResourceId: refs.partyRef.resourceId,
  tenantId,
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-03T08:00:00.000Z')),
};

const rejectingMutationTransaction = <Failure>(failure: Failure) =>
  // SAFETY: The harness implements exactly the insert/values/returning chain used by create.
  ({
    insert: () => ({
      values: () => ({ returning: () => Effect.fail(failure) }),
    }),
  }) as unknown as Parameters<typeof createOrganizationEngagementProfile>[0];

it('reconstructs typed references from the owner-local persistence record', () => {
  const result = organizationEngagementProfileFromRecord(row);
  expect(result.partyRef).toEqual(refs.partyRef);
  expect(result.counterpartyRef).toEqual(refs.counterpartyRef);
  expect('name' in result).toBe(false);
  expect('ico' in result).toBe(false);
  expect(
    organizationEngagementProfileFromRecord({ ...row, counterpartyResourceId: null })
      .counterpartyRef,
  ).toBe(null);
});

it.effect('fails closed when a caller-supplied ref crosses the trusted tenant', () =>
  Effect.gen(function* verifyCase2() {
    const failure = yield* Effect.flip(
      ensureReferencesBelongToTenant(tenantId, {
        ...refs,
        partyRef: { ...refs.partyRef, tenantId: 'c9000000-0000-4000-8000-000000000001' },
      }),
    );
    expect(Predicate.isTagged(failure, 'EngagementProfileConflict')).toBe(true);
    expect(failure.code).toBe('contacts_party_counterparty_mismatch');
  }),
);

it.effect('maps a wrapped owner uniqueness constraint to the declared engagement conflict', () =>
  Effect.gen(function* verifyCase3() {
    const failure = yield* Effect.flip(
      createOrganizationEngagementProfile(
        rejectingMutationTransaction({
          cause: {
            cause: {
              code: '23505',
              constraint: 'contacts_organization_engagement_profiles_party_uk',
            },
          },
        }),
        { ...refs, tenantId },
      ),
    );

    expect(Predicate.isTagged(failure, 'EngagementProfileConflict')).toBe(true);
    expect(failure.code).toBe('contacts_engagement_profile_already_exists');
    expect(failure.reason).toBe(
      'An engagement profile already exists for these canonical references',
    );
  }),
);

it.effect('continues past an unrelated wrapper code to the owner uniqueness constraint', () =>
  Effect.gen(function* verifyCase4() {
    const failure = yield* Effect.flip(
      createOrganizationEngagementProfile(
        rejectingMutationTransaction({
          code: 'ERR_QUERY_FAILED',
          cause: {
            code: '23505',
            constraint: 'contacts_organization_engagement_profiles_party_uk',
          },
        }),
        { ...refs, tenantId },
      ),
    );

    expect(Predicate.isTagged(failure, 'EngagementProfileConflict')).toBe(true);
    expect(failure.code).toBe('contacts_engagement_profile_already_exists');
  }),
);

it.effect('maps an unrelated uniqueness constraint to the existing persistence fallback', () =>
  Effect.gen(function* verifyCase5() {
    const failure = yield* Effect.flip(
      createOrganizationEngagementProfile(
        rejectingMutationTransaction({
          code: '23505',
          constraint: 'contacts_future_internal_integrity_uk',
        }),
        { ...refs, tenantId },
      ),
    );

    expect(Predicate.isTagged(failure, 'EngagementProfilePersistenceUnavailable')).toBe(true);
    expect(failure.code).toBe('contacts_engagement_profile_persistence_unavailable');
    expect(failure.reason).toBe(
      'Contacts engagement profile persistence is temporarily unavailable',
    );
  }),
);
