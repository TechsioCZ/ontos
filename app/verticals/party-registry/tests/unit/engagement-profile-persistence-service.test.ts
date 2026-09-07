import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
/* eslint-disable anti-slop/no-chained-type-assertions -- Focused harness implements only the mutation insert's Drizzle seam. expires: 2026-12-31. */
import { DateTime, Effect, Predicate } from 'effect';
import assert from 'node:assert/strict';
import test from 'node:test';
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

void test('reconstructs typed references from the owner-local persistence record', () => {
  const result = organizationEngagementProfileFromRecord(row);
  assert.deepEqual(result.partyRef, refs.partyRef);
  assert.deepEqual(result.counterpartyRef, refs.counterpartyRef);
  assert.equal('name' in result, false);
  assert.equal('ico' in result, false);
  assert.equal(
    organizationEngagementProfileFromRecord({ ...row, counterpartyResourceId: null })
      .counterpartyRef,
    null,
  );
});

void test('fails closed when a caller-supplied ref crosses the trusted tenant', async () => {
  const failure = await runEffectTestPromise(
    Effect.flip(
      ensureReferencesBelongToTenant(tenantId, {
        ...refs,
        partyRef: { ...refs.partyRef, tenantId: 'c9000000-0000-4000-8000-000000000001' },
      }),
    ),
  );
  assert.ok(Predicate.isTagged(failure, 'EngagementProfileConflict'));
  assert.equal(failure.code, 'contacts_party_counterparty_mismatch');
});

void test('maps a wrapped owner uniqueness constraint to the declared engagement conflict', async () => {
  const failure = await runEffectTestPromise(
    Effect.flip(
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
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'EngagementProfileConflict'));
  assert.equal(failure.code, 'contacts_engagement_profile_already_exists');
  assert.equal(
    failure.reason,
    'An engagement profile already exists for these canonical references',
  );
});

void test('continues past an unrelated wrapper code to the owner uniqueness constraint', async () => {
  const failure = await runEffectTestPromise(
    Effect.flip(
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
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'EngagementProfileConflict'));
  assert.equal(failure.code, 'contacts_engagement_profile_already_exists');
});

void test('maps an unrelated uniqueness constraint to the existing persistence fallback', async () => {
  const failure = await runEffectTestPromise(
    Effect.flip(
      createOrganizationEngagementProfile(
        rejectingMutationTransaction({
          code: '23505',
          constraint: 'contacts_future_internal_integrity_uk',
        }),
        { ...refs, tenantId },
      ),
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'EngagementProfilePersistenceUnavailable'));
  assert.equal(failure.code, 'contacts_engagement_profile_persistence_unavailable');
  assert.equal(
    failure.reason,
    'Contacts engagement profile persistence is temporarily unavailable',
  );
});
