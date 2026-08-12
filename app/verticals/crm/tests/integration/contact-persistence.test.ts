import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Client, Pool } from 'pg';
import { makeContactService } from '../../src/contacts/contact-service.ts';
import { loadCrmDatabaseConnectionPair } from '../../src/db/config.ts';
import { crmDatabaseSchema } from '../../src/db/schema.ts';

const tenantA = '82000000-0000-4000-8000-000000000001';
const tenantB = '82000000-0000-4000-8000-000000000002';
const customerA = '83000000-0000-4000-8000-000000000001';
const customerB = '83000000-0000-4000-8000-000000000002';

test('enforces Contact FK, name checks, tenant RLS, optimistic mutation, tombstones, and historical labels', async () => {
  const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
  const admin = new Client({ connectionString: configuration.admin.connectionString });
  const runtimePool = new Pool({ connectionString: configuration.runtime.connectionString });
  await admin.connect();

  const cleanup = async () => {
    await admin.query('delete from crm.contacts where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await admin.query('delete from crm.customers where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
  };

  try {
    await cleanup();
    await admin.query(
      `insert into crm.customers (customer_id, tenant_id, name)
       values ($1, $2, 'Acme'), ($3, $4, 'Other tenant')`,
      [customerA, tenantA, customerB, tenantB],
    );

    const database = drizzle({ client: runtimePool, schema: crmDatabaseSchema });
    let contactId = '';
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
      const service = makeContactService(
        transaction,
        tenantA,
        () => new Date('2026-08-11T10:00:00.000Z'),
      );
      const created = await Effect.runPromise(
        service.createContact({
          customerId: customerA,
          email: ' ADA@EXAMPLE.COM ',
          firstName: ' Ada ',
        }),
      );
      const { contactId: createdContactId } = created.result;
      contactId = createdContactId;
      assert.equal(created.result.isPrimaryContact, false);
      assert.equal(created.result.email, 'ada@example.com');
      assert.equal(created.result.customerLabel, 'Acme');

      const stale = await Effect.runPromise(
        Effect.flip(service.editContact({ contactId, expectedVersion: 2, firstName: 'Grace' })),
      );
      assert.equal(stale._tag, 'EditContactConflict');

      const edited = await Effect.runPromise(
        service.editContact({ contactId, expectedVersion: 1, lastName: 'Lovelace' }),
      );
      assert.equal(edited.result.customerId, customerA);
      assert.equal(edited.result.isPrimaryContact, false);
      assert.equal(edited.result.version, 2);

      const foreignParent = await Effect.runPromise(
        Effect.flip(service.createContact({ customerId: customerB, firstName: 'Hidden' })),
      );
      assert.equal(foreignParent._tag, 'CreateContactNotFound');

      await Effect.runPromise(
        service.createContact({ customerId: customerA, firstName: 'Alan', lastName: 'Turing' }),
      );
      await Effect.runPromise(
        service.createContact({ customerId: customerA, firstName: 'Barbara', lastName: 'Liskov' }),
      );
      const firstPage = await Effect.runPromise(service.listContacts(customerA, 1));
      assert.deepEqual(
        firstPage.items.map(({ displayName }) => displayName),
        ['Barbara Liskov'],
      );
      assert.notEqual(firstPage.nextCursor, null);
      const secondPage = await Effect.runPromise(
        service.listContacts(customerA, 1, firstPage.nextCursor ?? undefined),
      );
      assert.deepEqual(
        secondPage.items.map(({ displayName }) => displayName),
        ['Lovelace'],
      );

      const deleted = await Effect.runPromise(
        service.deleteContact({ contactId, expectedVersion: 2 }),
      );
      assert.equal(deleted.result.version, 3);
      assert.equal(deleted.result.customerLabel, 'Acme');

      const ordinary = await Effect.runPromise(Effect.flip(service.getContact(contactId)));
      assert.equal(ordinary._tag, 'ReadHandlerNotFound');
      assert.deepEqual(await Effect.runPromise(service.getHistoricalContactLabel(contactId)), {
        contactId,
        customerId: customerA,
        customerLabel: 'Acme',
        displayName: 'Lovelace',
      });
    });

    const runtime = await runtimePool.connect();
    try {
      await runtime.query('begin');
      await runtime.query("select set_config('ontos.tenant_id', $1, true)", [tenantA]);
      await runtime.query('savepoint invalid_name');
      await assert.rejects(
        runtime.query('insert into crm.contacts (tenant_id, customer_id) values ($1, $2)', [
          tenantA,
          customerA,
        ]),
        (error: { readonly code?: string; readonly constraint?: string }) =>
          error.code === '23514' && error.constraint === 'crm_contacts_name_ck',
      );
      await runtime.query('rollback to savepoint invalid_name');
      await runtime.query('savepoint whitespace_name');
      await assert.rejects(
        runtime.query(
          "insert into crm.contacts (tenant_id, customer_id, first_name) values ($1, $2, E'\\t')",
          [tenantA, customerA],
        ),
        (error: { readonly code?: string; readonly constraint?: string }) =>
          error.code === '23514' && error.constraint === 'crm_contacts_name_ck',
      );
      await runtime.query('rollback to savepoint whitespace_name');
      await runtime.query('savepoint foreign_parent');
      await assert.rejects(
        runtime.query(
          "insert into crm.contacts (tenant_id, customer_id, first_name) values ($1, $2, 'Hidden')",
          [tenantA, customerB],
        ),
        (error: { readonly code?: string; readonly constraint?: string }) =>
          error.code === '23503' && error.constraint === 'crm_contacts_customer_fk',
      );
      await runtime.query('rollback to savepoint foreign_parent');
      const visible = await runtime.query<{ readonly tenant_id: string }>(
        'select tenant_id from crm.contacts',
      );
      assert.deepEqual(
        visible.rows.map(({ tenant_id }) => tenant_id),
        [tenantA, tenantA, tenantA],
      );
      await runtime.query('commit');
    } finally {
      runtime.release();
    }

    await assert.rejects(
      admin.query('delete from crm.customers where customer_id = $1', [customerA]),
      (error: { readonly code?: string; readonly constraint?: string }) =>
        error.code === '23503' && error.constraint === 'crm_contacts_customer_fk',
    );
    await admin.query('update crm.customers set deleted_at = now() where customer_id = $1', [
      customerA,
    ]);
    const retained = await admin.query<{ readonly contact_id: string }>(
      'select contact_id from crm.contacts where contact_id = $1',
      [contactId],
    );
    assert.deepEqual(retained.rows, [{ contact_id: contactId }]);

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
      const service = makeContactService(transaction, tenantA);
      const deletedParent = await Effect.runPromise(
        Effect.flip(service.createContact({ customerId: customerA, firstName: 'Blocked' })),
      );
      assert.equal(deletedParent._tag, 'CreateContactNotFound');
    });
  } finally {
    await cleanup();
    await Promise.all([admin.end(), runtimePool.end()]);
  }
});
