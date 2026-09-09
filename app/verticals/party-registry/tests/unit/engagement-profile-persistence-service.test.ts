import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
/* eslint-disable anti-slop/no-chained-type-assertions -- Focused harness implements only the mutation insert's Drizzle seam. expires: 2026-12-31. */
import { DateTime, Effect, Match, Predicate } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { organizationEngagementProfiles, personEngagementProfiles } from '../../src/db/engagement-schema.ts';
import type { OrganizationEngagementProfileRecord } from '../../src/db/engagement-schema.ts';
import {
  createOrganizationEngagementProfile,
  createPersonEngagementProfile,
  findOrganizationEngagementProfile,
  findPersonEngagementProfile,
  transitionOrganizationEngagementProfile,
  transitionPersonEngagementProfile,
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
    organizationEngagementProfileFromRecord({
      ...row,
      counterpartyResourceId: null,
    }).counterpartyRef,
  ).toBe(null);
});

it.effect('fails closed when a caller-supplied ref crosses the trusted tenant', () =>
  Effect.gen(function* verifyCase2() {
    const failure = yield* Effect.flip(
      ensureReferencesBelongToTenant(tenantId, {
        ...refs,
        partyRef: {
          ...refs.partyRef,
          tenantId: 'c9000000-0000-4000-8000-000000000001',
        },
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
    expect(failure.reason).toBe('An engagement profile already exists for these canonical references');
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
    expect(failure.reason).toBe('Contacts engagement profile persistence is temporarily unavailable');
  }),
);

const profileKinds = [
  {
    table: organizationEngagementProfiles,
    create: createOrganizationEngagementProfile,
    find: findOrganizationEngagementProfile,
    transition: transitionOrganizationEngagementProfile,
    resourceType: 'party.registry.organization-engagement-profile',
  },
  {
    table: personEngagementProfiles,
    create: createPersonEngagementProfile,
    find: findPersonEngagementProfile,
    transition: transitionPersonEngagementProfile,
    resourceType: 'party.registry.person-engagement-profile',
  },
] as const;

for (const kind of profileKinds) {
  it.effect(`${kind.resourceType} binds creation, lookup and lifecycle to its own tenant-qualified table`, () =>
    Effect.gen(function* verifyProfilePersistence() {
      let current: OrganizationEngagementProfileRecord | undefined = row;
      let writes = 0;
      let locks = 0;
      const rows = () => (current === undefined ? [] : [current]);
      const where = (predicate: SQL) => {
        assert.deepEqual(new PgDialect().sqlToQuery(predicate).params, [tenantId, row.engagementProfileId]);
      };
      // SAFETY: This focused double implements the factory's insert/select/update query chains.
      const transaction = {
        insert: (table: typeof kind.table) => {
          assert.equal(table, kind.table);
          return {
            values: (values: typeof organizationEngagementProfiles.$inferInsert) => {
              assert.deepEqual(values, {
                counterpartyResourceId: refs.counterpartyRef.resourceId,
                partyResourceId: refs.partyRef.resourceId,
                tenantId,
              });
              return { returning: () => Effect.succeed(rows()) };
            },
          };
        },
        select: () => ({
          from: (table: typeof kind.table) => {
            assert.equal(table, kind.table);
            return {
              where: (predicate: SQL) => {
                where(predicate);
                return {
                  limit: () =>
                    Object.assign(Effect.succeed(rows()), {
                      for: (mode: string) => {
                        assert.equal(mode, 'update');
                        locks += 1;
                        return Effect.succeed(rows());
                      },
                    }),
                };
              },
            };
          },
        }),
        update: (table: typeof kind.table) => {
          assert.equal(table, kind.table);
          return {
            set: (values: Pick<OrganizationEngagementProfileRecord, 'archivedAt' | 'updatedAt'>) => {
              writes += 1;
              current = { ...row, ...values };
              return {
                where: (predicate: SQL) => {
                  where(predicate);
                  return { returning: () => Effect.succeed(rows()) };
                },
              };
            },
          };
        },
      } as unknown as Parameters<typeof createOrganizationEngagementProfile>[0];
      const created = yield* kind.create(transaction, { ...refs, tenantId });
      assert.equal(created.profileRef.resourceType, kind.resourceType);
      const found = yield* kind.find(transaction, tenantId, row.engagementProfileId);
      assert.deepEqual(
        Match.value(found).pipe(
          Match.tag('found', ({ value }) => value),
          Match.orElse(() => expect.unreachable('Expected found profile')),
        ),
        created,
      );
      const conflict = yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'active');
      assert.deepEqual(
        Match.value(conflict).pipe(
          Match.tag('conflict', ({ value }) => value),
          Match.orElse(() => expect.unreachable('Expected conflicting profile')),
        ),
        created,
      );
      assert.equal(writes, 0);
      const archived = yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'archived');
      assert.deepEqual(archived, yield* kind.find(transaction, tenantId, row.engagementProfileId));
      assert.notEqual(current?.archivedAt, null);
      yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'active');
      assert.equal(current?.archivedAt, null);
      assert.equal(writes, 2);
      current = undefined;
      expect(Predicate.isTagged(yield* kind.find(transaction, tenantId, row.engagementProfileId), 'not_found')).toBe(
        true,
      );
      expect(
        Predicate.isTagged(
          yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'archived'),
          'not_found',
        ),
      ).toBe(true);
      assert.equal(writes, 2);
      assert.equal(locks, 4);
    }),
  );
}
