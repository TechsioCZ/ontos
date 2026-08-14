// @effect-diagnostics asyncFunction:off globalDate:off
/* eslint-disable unicorn/no-await-expression-member -- Live database assertions keep each typed query beside its expected result. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { contacts, crmDatabaseSchema, customers } from '../../src/db/schema.ts';

const tenantA = 'c1000000-0000-4000-8000-000000000001';
const tenantB = 'c1000000-0000-4000-8000-000000000002';
const customerA = 'c2000000-0000-4000-8000-000000000001';
const customerB = 'c2000000-0000-4000-8000-000000000002';
const customerA2 = 'c2000000-0000-4000-8000-000000000003';
const contactA1 = 'c3000000-0000-4000-8000-000000000001';
const contactA2 = 'c3000000-0000-4000-8000-000000000002';
const fixtureTenants = [tenantA, tenantB] as const;

const hasPostgreSqlCode =
  (expected: string) =>
  (error: unknown): boolean => {
    let current = error;
    while (typeof current === 'object' && current !== null) {
      if ('code' in current && current.code === expected) {
        return true;
      }
      current = 'cause' in current ? current.cause : undefined;
    }
    return false;
  };

test('enforces CRM constraints, tenant RLS, parent integrity, and durable archiving', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const adminPool = new Pool({ connectionString: connections.admin.connectionString });
  const runtimePool = new Pool({
    connectionString: connections.runtime.connectionString,
    max: 1,
  });
  const admin = drizzle({ client: adminPool, schema: crmDatabaseSchema });
  const runtime = drizzle({ client: runtimePool, schema: crmDatabaseSchema });
  const cleanup = async () => {
    await admin.delete(contacts).where(inArray(contacts.tenantId, fixtureTenants));
    await admin.delete(customers).where(inArray(customers.tenantId, fixtureTenants));
  };

  try {
    await cleanup();
    await admin.insert(customers).values([
      { customerId: customerA, name: 'Tenant A customer', tenantId: tenantA },
      { customerId: customerB, name: 'Tenant B customer', tenantId: tenantB },
    ]);

    assert.deepEqual(await runtime.select().from(customers), []);
    await assert.rejects(
      runtime.insert(customers).values({ name: 'Unscoped customer', tenantId: tenantA }),
      hasPostgreSqlCode('42501'),
    );

    await runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
      assert.deepEqual(
        await transaction
          .select({ customerId: customers.customerId })
          .from(customers)
          .orderBy(customers.customerId),
        [{ customerId: customerA }],
      );
      assert.deepEqual(
        await transaction
          .update(customers)
          .set({ name: 'Cross-tenant update' })
          .where(eq(customers.customerId, customerB))
          .returning({ customerId: customers.customerId }),
        [],
      );
    });

    await assert.rejects(
      runtime.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        await transaction.insert(customers).values({ name: ' padded ', tenantId: tenantA });
      }),
      hasPostgreSqlCode('23514'),
    );
    await assert.rejects(
      runtime.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        await transaction.insert(contacts).values({
          customerId: 'c2000000-0000-4000-8000-000000000099',
          email: 'missing@example.test',
          name: 'Missing parent',
          phone: '+420111111111',
          tenantId: tenantA,
        });
      }),
      hasPostgreSqlCode('23503'),
    );
    await assert.rejects(
      runtime.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        await transaction.insert(contacts).values({
          customerId: customerB,
          email: 'foreign@example.test',
          name: 'Foreign parent',
          phone: '+420222222222',
          tenantId: tenantA,
        });
      }),
      hasPostgreSqlCode('23503'),
    );
    await Promise.all(
      [
        {
          email: 'valid@example.test',
          name: ' padded ',
          phone: '+420333333331',
        },
        {
          email: '   ',
          name: 'Empty email',
          phone: '+420333333332',
        },
        {
          email: 'valid@example.test',
          name: 'Empty phone',
          phone: '   ',
        },
      ].map((invalidContact) =>
        assert.rejects(
          runtime.transaction(async (transaction) => {
            await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
            await transaction.insert(contacts).values({
              customerId: customerA,
              tenantId: tenantA,
              ...invalidContact,
            });
          }),
          hasPostgreSqlCode('23514'),
        ),
      ),
    );

    const archivedAt = new Date('2026-08-13T12:00:00.000Z');
    await runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
      await transaction.insert(customers).values({
        customerId: customerA2,
        name: 'Tenant A customer',
        tenantId: tenantA,
      });
      await transaction.insert(contacts).values([
        {
          contactId: contactA1,
          customerId: customerA,
          email: 'shared@example.test',
          name: 'Shared contact',
          phone: '+420444444444',
          tenantId: tenantA,
        },
        {
          contactId: contactA2,
          customerId: customerA,
          email: 'shared@example.test',
          name: 'Shared contact',
          phone: '+420444444444',
          tenantId: tenantA,
        },
      ]);
      assert.equal(
        (
          await transaction
            .select({ contactId: contacts.contactId })
            .from(contacts)
            .where(eq(contacts.customerId, customerA))
        ).length,
        2,
      );
      await transaction
        .update(contacts)
        .set({ archivedAt })
        .where(eq(contacts.contactId, contactA1));
      await transaction
        .update(customers)
        .set({ archivedAt })
        .where(eq(customers.customerId, customerA));
    });

    const persisted = await admin
      .select({
        archivedAt: contacts.archivedAt,
        contactId: contacts.contactId,
        customerArchivedAt: customers.archivedAt,
      })
      .from(contacts)
      .innerJoin(
        customers,
        and(
          eq(contacts.tenantId, customers.tenantId),
          eq(contacts.customerId, customers.customerId),
        ),
      )
      .where(eq(contacts.tenantId, tenantA))
      .orderBy(contacts.contactId);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0]?.archivedAt?.toISOString(), archivedAt.toISOString());
    assert.equal(persisted[1]?.archivedAt, null);
    assert.equal(persisted[0]?.customerArchivedAt?.toISOString(), archivedAt.toISOString());
    assert.equal(persisted[1]?.customerArchivedAt?.toISOString(), archivedAt.toISOString());

    await runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantB}, true)`);
      assert.deepEqual(
        await transaction.select().from(contacts).where(eq(contacts.tenantId, tenantA)),
        [],
      );
    });
    await assert.rejects(
      runtime.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${'not-a-uuid'}, true)`);
        await transaction.select().from(customers);
      }),
      hasPostgreSqlCode('22P02'),
    );
  } finally {
    await cleanup();
    await runtimePool.end();
    await adminPool.end();
  }
});
