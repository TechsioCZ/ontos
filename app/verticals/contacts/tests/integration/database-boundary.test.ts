// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Option, Redacted, Schema } from 'effect';
import { Pool } from 'pg';
import {
  contactsRelations,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/schema.ts';

const tenantA = 'c1000000-0000-4000-8000-000000000001';
const tenantB = 'c1000000-0000-4000-8000-000000000002';
const fixtureTenants = [tenantA, tenantB] as const;

const decodePostgreSqlFailure = Schema.decodeUnknownOption(
  Schema.Struct({
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.optionalKey(Schema.String),
  }),
);
const hasPostgreSqlCode = (expected: string) => {
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- assert.rejects passes arbitrary driver failures into this schema parser boundary.
  const matches = (error: unknown): boolean => {
    let current = error;
    for (let depth = 0; depth < 8; depth += 1) {
      const parsed = decodePostgreSqlFailure(current);
      if (Option.isNone(parsed)) {
        return false;
      }
      if (parsed.value.code === expected) {
        return true;
      }
      current = parsed.value.cause;
    }
    return false;
  };
  return matches;
};

test('enforces tenant isolation and canonical-reference uniqueness without cross-vertical FKs', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const adminPool = new Pool({
    connectionString: Redacted.value(connections.admin.connectionString),
  });
  const runtimePool = new Pool({
    connectionString: Redacted.value(connections.runtime.connectionString),
    max: 1,
  });
  const admin = drizzle({ client: adminPool, relations: contactsRelations });
  const runtime = drizzle({ client: runtimePool, relations: contactsRelations });
  const cleanup = async () => {
    await admin
      .delete(personEngagementProfiles)
      .where(inArray(personEngagementProfiles.tenantId, fixtureTenants));
    await admin
      .delete(organizationEngagementProfiles)
      .where(inArray(organizationEngagementProfiles.tenantId, fixtureTenants));
  };

  try {
    await cleanup();
    assert.deepEqual(await runtime.select().from(organizationEngagementProfiles), []);
    await assert.rejects(
      runtime.insert(organizationEngagementProfiles).values({
        counterpartyResourceId: 'counterparty-a',
        partyResourceId: 'party-a',
        tenantId: tenantA,
      }),
      hasPostgreSqlCode('42501'),
    );

    await runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
      await transaction.insert(organizationEngagementProfiles).values({
        counterpartyResourceId: 'counterparty-a',
        partyResourceId: 'party-a',
        tenantId: tenantA,
      });
      await transaction.insert(personEngagementProfiles).values({
        counterpartyResourceId: 'counterparty-a',
        partyResourceId: 'person-a',
        tenantId: tenantA,
      });
      const [prospect] = await transaction
        .insert(organizationEngagementProfiles)
        .values({
          partyResourceId: 'prospect-a',
          tenantId: tenantA,
        })
        .returning();
      assert.equal(prospect?.counterpartyResourceId, null);
      const [unresolvedPerson] = await transaction
        .insert(personEngagementProfiles)
        .values({
          partyResourceId: 'unresolved-person-a',
          tenantId: tenantA,
        })
        .returning();
      assert.equal(unresolvedPerson?.counterpartyResourceId, null);
    });

    await assert.rejects(
      runtime.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        await transaction.insert(personEngagementProfiles).values({
          partyResourceId: 'unresolved-person-a',
          tenantId: tenantA,
        });
      }),
      hasPostgreSqlCode('23505'),
    );

    await assert.rejects(
      runtime.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        await transaction.insert(organizationEngagementProfiles).values({
          counterpartyResourceId: 'counterparty-a',
          partyResourceId: 'party-b',
          tenantId: tenantA,
        });
      }),
      hasPostgreSqlCode('23505'),
    );

    await runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantB}, true)`);
      await transaction.insert(organizationEngagementProfiles).values({
        counterpartyResourceId: 'counterparty-a',
        partyResourceId: 'party-a',
        tenantId: tenantB,
      });
      assert.deepEqual(
        await transaction
          .select()
          .from(organizationEngagementProfiles)
          .where(eq(organizationEngagementProfiles.tenantId, tenantA)),
        [],
      );
    });
  } finally {
    await cleanup();
    await runtimePool.end();
    await adminPool.end();
  }
});
