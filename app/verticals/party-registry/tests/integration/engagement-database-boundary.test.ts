import {
  makeEffectTestCallback as nativeTestCallback,
  runEffectTestPromise,
  runEffectTestSync as runNativeSync,
} from '@app/core-runtime/testing/effect-runtime';

// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.

import { eq, inArray, sql } from 'drizzle-orm';
import { Effect, Exit as NativeExit, Scope as NativeScope } from 'effect';
import assert from 'node:assert/strict';
import test, { after as afterNativeDatabase } from 'node:test';
import type { Pool } from 'pg';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { hasPostgreSqlCode, openBoundaryDatabases } from '../support/database-boundary.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import {
  contactsRelations,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/engagement-schema.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

/** Both boundary roles read the same owned schema through the scope closed after these tests. */
const openContactsDatabase = async (pool: Pool) =>
  await runEffectTestPromise(
    makeTestDatabaseFromPool(pool, contactsRelations).pipe(
      NativeScope.provide(nativeDatabaseScope),
    ),
  );

const tenantA = 'c1000000-0000-4000-8000-000000000001';
const tenantB = 'c1000000-0000-4000-8000-000000000002';
const fixtureTenants = [tenantA, tenantB] as const;

test('enforces tenant isolation and canonical-reference uniqueness without cross-vertical FKs', async () => {
  const { admin, adminPool, runtime, runtimePool } =
    await openBoundaryDatabases(openContactsDatabase);
  // Ordered child-before-parent so every delete respects the owned foreign keys.
  const cleanup = async (): Promise<void> => {
    await purgeFixtureRows(
      [personEngagementProfiles, organizationEngagementProfiles].map((table) =>
        admin.delete(table).where(inArray(table.tenantId, fixtureTenants)),
      ),
    );
  };

  try {
    await cleanup();
    assert.deepEqual(
      await runEffectTestPromise(runtime.select().from(organizationEngagementProfiles)),
      [],
    );
    await assert.rejects(
      runEffectTestPromise(
        runtime.insert(organizationEngagementProfiles).values({
          counterpartyResourceId: 'counterparty-a',
          partyResourceId: 'party-a',
          tenantId: tenantA,
        }),
      ),
      hasPostgreSqlCode('42501'),
    );

    await runEffectTestPromise(
      runtime.transaction((transaction) =>
        Effect.gen(function* transactionTestBody() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${tenantA}, true)`,
            'objects',
          );
          yield* transaction.insert(organizationEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'party-a',
            tenantId: tenantA,
          });
          yield* transaction.insert(personEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'person-a',
            tenantId: tenantA,
          });
          const [prospect] = yield* transaction
            .insert(organizationEngagementProfiles)
            .values({
              partyResourceId: 'prospect-a',
              tenantId: tenantA,
            })
            .returning();
          assert.equal(prospect?.counterpartyResourceId, null);
          const [unresolvedPerson] = yield* transaction
            .insert(personEngagementProfiles)
            .values({
              partyResourceId: 'unresolved-person-a',
              tenantId: tenantA,
            })
            .returning();
          assert.equal(unresolvedPerson?.counterpartyResourceId, null);
        }),
      ),
    );

    await assert.rejects(
      runEffectTestPromise(
        runtime.transaction((transaction) =>
          Effect.gen(function* transactionTestBody() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantA}, true)`,
              'objects',
            );
            yield* transaction.insert(personEngagementProfiles).values({
              partyResourceId: 'unresolved-person-a',
              tenantId: tenantA,
            });
          }),
        ),
      ),
      hasPostgreSqlCode('23505'),
    );

    await assert.rejects(
      runEffectTestPromise(
        runtime.transaction((transaction) =>
          Effect.gen(function* transactionTestBody() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantA}, true)`,
              'objects',
            );
            yield* transaction.insert(organizationEngagementProfiles).values({
              counterpartyResourceId: 'counterparty-a',
              partyResourceId: 'party-b',
              tenantId: tenantA,
            });
          }),
        ),
      ),
      hasPostgreSqlCode('23505'),
    );

    await runEffectTestPromise(
      runtime.transaction((transaction) =>
        Effect.gen(function* transactionTestBody() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${tenantB}, true)`,
            'objects',
          );
          yield* transaction.insert(organizationEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'party-a',
            tenantId: tenantB,
          });
          assert.deepEqual(
            yield* transaction
              .select()
              .from(organizationEngagementProfiles)
              .where(eq(organizationEngagementProfiles.tenantId, tenantA)),
            [],
          );
        }),
      ),
    );
  } finally {
    await cleanup();
    await runtimePool.end();
    await adminPool.end();
  }
});
