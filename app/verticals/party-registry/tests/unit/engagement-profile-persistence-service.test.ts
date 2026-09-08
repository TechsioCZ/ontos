import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
/* eslint-disable anti-slop/no-chained-type-assertions -- Focused harness implements only the mutation insert's Drizzle seam. expires: 2026-12-31. */
import { DateTime, Effect } from 'effect';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/engagement-schema.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
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

test('reconstructs typed references from the owner-local persistence record', () => {
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

test('fails closed when a caller-supplied ref crosses the trusted tenant', async () => {
  const failure = await runEffectTestPromise(
    Effect.flip(
      ensureReferencesBelongToTenant(tenantId, {
        ...refs,
        partyRef: { ...refs.partyRef, tenantId: 'c9000000-0000-4000-8000-000000000001' },
      }),
    ),
  );
  assert.equal(failure._tag, 'EngagementProfileConflict');
  assert.equal(failure.code, 'contacts_party_counterparty_mismatch');
});

test('maps a wrapped owner uniqueness constraint to the declared engagement conflict', async () => {
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

  assert.equal(failure._tag, 'EngagementProfileConflict');
  assert.equal(failure.code, 'contacts_engagement_profile_already_exists');
  assert.equal(
    failure.reason,
    'An engagement profile already exists for these canonical references',
  );
});

test('continues past an unrelated wrapper code to the owner uniqueness constraint', async () => {
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

  assert.equal(failure._tag, 'EngagementProfileConflict');
  assert.equal(failure.code, 'contacts_engagement_profile_already_exists');
});

test('maps an unrelated uniqueness constraint to the existing persistence fallback', async () => {
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

  assert.equal(failure._tag, 'EngagementProfilePersistenceUnavailable');
  assert.equal(failure.code, 'contacts_engagement_profile_persistence_unavailable');
  assert.equal(
    failure.reason,
    'Contacts engagement profile persistence is temporarily unavailable',
  );
});

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
  test(`${kind.resourceType} binds creation, lookup and lifecycle to its own tenant-qualified table`, () =>
    runEffectTestPromise(
      Effect.gen(function* verifyProfilePersistence() {
        let current: OrganizationEngagementProfileRecord | undefined = row;
        let writes = 0;
        let locks = 0;
        const rows = () => (current === undefined ? [] : [current]);
        const where = (predicate: SQL) => {
          assert.deepEqual(new PgDialect().sqlToQuery(predicate).params, [
            tenantId,
            row.engagementProfileId,
          ]);
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
              set: (
                values: Pick<OrganizationEngagementProfileRecord, 'archivedAt' | 'updatedAt'>,
              ) => {
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
        assert.deepEqual(yield* kind.find(transaction, tenantId, row.engagementProfileId), {
          _tag: 'found',
          value: created,
        });
        assert.deepEqual(
          yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'active'),
          { _tag: 'conflict', value: created },
        );
        assert.equal(writes, 0);
        const archived = yield* kind.transition(
          transaction,
          tenantId,
          row.engagementProfileId,
          'archived',
        );
        assert.deepEqual(
          archived,
          yield* kind.find(transaction, tenantId, row.engagementProfileId),
        );
        assert.notEqual(current?.archivedAt, null);
        yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'active');
        assert.equal(current?.archivedAt, null);
        assert.equal(writes, 2);
        current = undefined;
        assert.deepEqual(yield* kind.find(transaction, tenantId, row.engagementProfileId), {
          _tag: 'not_found',
        });
        assert.deepEqual(
          yield* kind.transition(transaction, tenantId, row.engagementProfileId, 'archived'),
          { _tag: 'not_found' },
        );
        assert.equal(writes, 2);
        assert.equal(locks, 4);
      }),
    ));
}
