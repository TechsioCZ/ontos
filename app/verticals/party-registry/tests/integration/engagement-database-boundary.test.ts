import { eq, inArray, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import {
  contactsRelations,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/engagement-schema.ts';
import { hasPostgreSqlCode, openBoundaryDatabases } from '../support/database-boundary.ts';

const tenantA = 'c1000000-0000-4000-8000-000000000001';
const tenantB = 'c1000000-0000-4000-8000-000000000002';
const fixtureTenants = [tenantA, tenantB] as const;

it.live('enforces tenant isolation and canonical-reference uniqueness without cross-vertical FKs', () =>
  Effect.gen(function* testEffect1() {
    const { admin, runtime } = yield* openBoundaryDatabases(
      (pool) => makeTestDatabaseFromPool(pool, contactsRelations),
      1,
    );
    const cleanup = () =>
      purgeFixtureRows(
        [personEngagementProfiles, organizationEngagementProfiles].map((table) =>
          admin.delete(table).where(inArray(table.tenantId, fixtureTenants)),
        ),
      );

    yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
    yield* cleanup();
    expect(yield* runtime.select().from(organizationEngagementProfiles)).toEqual([]);
    expect(
      hasPostgreSqlCode('42501')(
        yield* Effect.flip(
          runtime.insert(organizationEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'party-a',
            tenantId: tenantA,
          }),
        ),
      ),
    ).toBe(true);
    yield* runtime.transaction((transaction) =>
      Effect.gen(function* transactionTestBody() {
        yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`, 'objects');
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
        expect(prospect?.counterpartyResourceId).toBe(null);
        const [unresolvedPerson] = yield* transaction
          .insert(personEngagementProfiles)
          .values({
            partyResourceId: 'unresolved-person-a',
            tenantId: tenantA,
          })
          .returning();
        expect(unresolvedPerson?.counterpartyResourceId).toBe(null);
      }),
    );
    expect(
      hasPostgreSqlCode('23505')(
        yield* Effect.flip(
          runtime.transaction((transaction) =>
            Effect.gen(function* transactionTestBody() {
              yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`, 'objects');
              yield* transaction.insert(personEngagementProfiles).values({
                partyResourceId: 'unresolved-person-a',
                tenantId: tenantA,
              });
            }),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      hasPostgreSqlCode('23505')(
        yield* Effect.flip(
          runtime.transaction((transaction) =>
            Effect.gen(function* transactionTestBody() {
              yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`, 'objects');
              yield* transaction.insert(organizationEngagementProfiles).values({
                counterpartyResourceId: 'counterparty-a',
                partyResourceId: 'party-b',
                tenantId: tenantA,
              });
            }),
          ),
        ),
      ),
    ).toBe(true);
    yield* runtime.transaction((transaction) =>
      Effect.gen(function* transactionTestBody() {
        yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantB}, true)`, 'objects');
        yield* transaction.insert(organizationEngagementProfiles).values({
          counterpartyResourceId: 'counterparty-a',
          partyResourceId: 'party-a',
          tenantId: tenantB,
        });
        expect(
          yield* transaction
            .select()
            .from(organizationEngagementProfiles)
            .where(eq(organizationEngagementProfiles.tenantId, tenantA)),
        ).toEqual([]);
      }),
    );
  }),
);
