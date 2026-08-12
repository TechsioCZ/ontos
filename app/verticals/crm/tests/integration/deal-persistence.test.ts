import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Client, Pool } from 'pg';
import { loadCrmDatabaseConnectionPair } from '../../src/db/config.ts';
import { crmDatabaseSchema } from '../../src/db/schema.ts';
import { makeDealService } from '../../src/deals/deal-service.ts';

const tenantA = '71000000-0000-4000-8000-000000000001';
const tenantB = '71000000-0000-4000-8000-000000000002';
const legalEntityA = '72000000-0000-4000-8000-000000000001';
const legalEntityB = '72000000-0000-4000-8000-000000000002';
const customerA = '73000000-0000-4000-8000-000000000001';
const customerB = '73000000-0000-4000-8000-000000000002';
const customerOtherTenant = '73000000-0000-4000-8000-000000000003';
const contactA = '74000000-0000-4000-8000-000000000001';
const contactB = '74000000-0000-4000-8000-000000000002';

test('enforces trusted Deal scope, parent eligibility, optimistic writes, list filters, RLS, and soft deletion', async () => {
  const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
  const admin = new Client({ connectionString: configuration.admin.connectionString });
  const runtimePool = new Pool({ connectionString: configuration.runtime.connectionString });
  await admin.connect();

  const cleanup = async () => {
    await admin.query('delete from crm.deals where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
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
       values ($1, $2, 'Acme'), ($3, $2, 'Beta'), ($4, $5, 'Other tenant')`,
      [customerA, tenantA, customerB, customerOtherTenant, tenantB],
    );
    await admin.query(
      `insert into crm.contacts
        (contact_id, tenant_id, customer_id, first_name, last_name)
       values ($1, $2, $3, 'Ada', 'Lovelace'), ($4, $2, $5, 'Grace', 'Hopper')`,
      [contactA, tenantA, customerA, contactB, customerB],
    );

    const database = drizzle({ client: runtimePool, schema: crmDatabaseSchema });
    let dealId = '';
    let otherDealId = '';
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantA}, true),
          set_config('ontos.legal_entity_id', ${legalEntityA}, true)`,
      );
      const service = makeDealService(
        transaction,
        tenantA,
        legalEntityA,
        () => new Date('2026-08-12T10:00:00.000Z'),
      );
      const crossCustomer = await Effect.runPromise(
        Effect.flip(
          service.createDeal({
            contactId: contactB,
            currency: 'CZK',
            customerId: customerA,
            expectedValue: 1000,
            title: 'Cross customer',
          }),
        ),
      );
      assert.equal(crossCustomer._tag, 'CreateDealRejected');

      const created = await Effect.runPromise(
        service.createDeal({
          contactId: contactA,
          currency: 'CZK',
          customerId: customerA,
          description: ' First opportunity ',
          expectedCloseDate: '2026-12-31',
          expectedValue: 1000.25,
          title: ' First opportunity ',
        }),
      );
      const { result: createdDeal } = created;
      const { dealId: createdDealId } = createdDeal;
      dealId = createdDealId;
      assert.equal(createdDeal.status, 'New');
      assert.equal(createdDeal.customerLabel, 'Acme');
      assert.equal(createdDeal.contactLabel, 'Ada Lovelace');
      assert.equal(createdDeal.title, 'First opportunity');

      const stale = await Effect.runPromise(
        Effect.flip(
          service.editDeal({
            contactId: null,
            currency: 'EUR',
            customerId: customerA,
            dealId,
            expectedValue: 1200,
            expectedVersion: 2,
            title: 'Changed',
          }),
        ),
      );
      assert.equal(stale._tag, 'EditDealConflict');

      const edited = await Effect.runPromise(
        service.editDeal({
          contactId: null,
          currency: 'EUR',
          customerId: customerA,
          dealId,
          expectedCloseDate: null,
          expectedValue: 1200,
          expectedVersion: 1,
          title: 'Changed',
        }),
      );
      assert.equal(edited.result.status, 'New');
      assert.equal(edited.result.version, 2);
      assert.equal(edited.result.contactId, null);

      const otherDeal = await Effect.runPromise(
        service.createDeal({
          currency: 'CZK',
          customerId: customerB,
          expectedValue: 2000,
          title: 'Beta opportunity',
        }),
      );
      otherDealId = otherDeal.result.dealId;
      const firstPage = await Effect.runPromise(service.listDeals(1));
      assert.equal(firstPage.items.length, 1);
      assert.notEqual(firstPage.nextCursor, null);
      const secondPage = await Effect.runPromise(
        service.listDeals(1, undefined, firstPage.nextCursor ?? undefined),
      );
      assert.equal(secondPage.items.length, 1);
      assert.notEqual(secondPage.items[0]?.dealId, firstPage.items[0]?.dealId);
      assert.equal(secondPage.nextCursor, null);
      const filtered = await Effect.runPromise(service.listDeals(10, customerA));
      assert.deepEqual(
        filtered.items.map(({ dealId: id }) => id),
        [dealId],
      );
      assert.equal(filtered.nextCursor, null);
      const foundDeal = await Effect.runPromise(service.getDeal(dealId));
      assert.equal(foundDeal.dealId, dealId);

      const deleted = await Effect.runPromise(service.deleteDeal({ dealId, expectedVersion: 2 }));
      assert.equal(deleted.result.version, 3);
      assert.equal(deleted.result.customerLabel, 'Acme');
      const missingDeal = await Effect.runPromise(Effect.flip(service.getDeal(dealId)));
      assert.equal(missingDeal._tag, 'ReadHandlerNotFound');
    });

    await admin.query('update crm.customers set deleted_at = now() where customer_id = $1', [
      customerA,
    ]);
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantA}, true),
          set_config('ontos.legal_entity_id', ${legalEntityA}, true)`,
      );
      const deletedCustomer = await Effect.runPromise(
        Effect.flip(
          makeDealService(transaction, tenantA, legalEntityA).createDeal({
            currency: 'CZK',
            customerId: customerA,
            expectedValue: 1,
            title: 'Deleted parent',
          }),
        ),
      );
      assert.equal(deletedCustomer._tag, 'CreateDealNotFound');
    });
    await admin.query('update crm.customers set deleted_at = null where customer_id = $1', [
      customerA,
    ]);

    await admin.query('update crm.contacts set deleted_at = now() where contact_id = $1', [
      contactA,
    ]);
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantA}, true),
          set_config('ontos.legal_entity_id', ${legalEntityA}, true)`,
      );
      const deletedContact = await Effect.runPromise(
        Effect.flip(
          makeDealService(transaction, tenantA, legalEntityA).createDeal({
            contactId: contactA,
            currency: 'CZK',
            customerId: customerA,
            expectedValue: 1,
            title: 'Deleted contact',
          }),
        ),
      );
      assert.equal(deletedContact._tag, 'CreateDealNotFound');
    });
    await admin.query('update crm.contacts set deleted_at = null where contact_id = $1', [
      contactA,
    ]);

    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantA}, true),
          set_config('ontos.legal_entity_id', ${legalEntityB}, true)`,
      );
      const hidden = await Effect.runPromise(
        makeDealService(transaction, tenantA, legalEntityB).listDeals(100),
      );
      assert.deepEqual(hidden.items, []);
    });

    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantB}, true),
          set_config('ontos.legal_entity_id', ${legalEntityA}, true)`,
      );
      const tenantService = makeDealService(transaction, tenantB, legalEntityA);
      const tenantDeals = await Effect.runPromise(tenantService.listDeals(100));
      assert.deepEqual(tenantDeals.items, []);
      const hiddenTenantDeal = await Effect.runPromise(
        Effect.flip(tenantService.getDeal(otherDealId)),
      );
      assert.equal(hiddenTenantDeal._tag, 'ReadHandlerNotFound');
      const crossTenantParent = await Effect.runPromise(
        Effect.flip(
          tenantService.createDeal({
            currency: 'CZK',
            customerId: customerA,
            expectedValue: 1,
            title: 'Cross tenant',
          }),
        ),
      );
      assert.equal(crossTenantParent._tag, 'CreateDealNotFound');
    });

    const runtime = await runtimePool.connect();
    try {
      await runtime.query('begin');
      await runtime.query(
        "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
        [tenantA, legalEntityA],
      );
      await runtime.query('savepoint invalid_money');
      await assert.rejects(
        runtime.query(
          `insert into crm.deals
            (tenant_id, legal_entity_id, customer_id, title, expected_value, currency)
           values ($1, $2, $3, 'Invalid', -1, 'CZK')`,
          [tenantA, legalEntityA, customerA],
        ),
        (error: { readonly code?: string; readonly constraint?: string }) =>
          error.code === '23514' && error.constraint === 'crm_deals_expected_value_ck',
      );
      await runtime.query('rollback to savepoint invalid_money');
      await runtime.query('savepoint invalid_currency');
      await assert.rejects(
        runtime.query(
          `insert into crm.deals
            (tenant_id, legal_entity_id, customer_id, title, expected_value, currency)
           values ($1, $2, $3, 'Invalid', 1, 'ZZZ')`,
          [tenantA, legalEntityA, customerA],
        ),
        (error: { readonly code?: string }) => error.code === '22P02',
      );
      await runtime.query('rollback to savepoint invalid_currency');
      await runtime.query('savepoint cross_customer_contact');
      await assert.rejects(
        runtime.query(
          `insert into crm.deals
            (tenant_id, legal_entity_id, customer_id, contact_id, title, expected_value, currency)
           values ($1, $2, $3, $4, 'Invalid', 1, 'CZK')`,
          [tenantA, legalEntityA, customerA, contactB],
        ),
        (error: { readonly code?: string; readonly constraint?: string }) =>
          error.code === '23503' && error.constraint === 'crm_deals_contact_fk',
      );
      await runtime.query('rollback to savepoint cross_customer_contact');
      const visible = await runtime.query<{ readonly legal_entity_id: string }>(
        'select legal_entity_id from crm.deals',
      );
      assert.equal(
        visible.rows.every(({ legal_entity_id }) => legal_entity_id === legalEntityA),
        true,
      );
      await runtime.query('rollback');

      await runtime.query('begin');
      await runtime.query("select set_config('ontos.tenant_id', $1, true)", [tenantA]);
      const rowsWithoutLegalEntity = await runtime.query('select deal_id from crm.deals');
      assert.deepEqual(rowsWithoutLegalEntity.rows, []);
      await assert.rejects(
        runtime.query(
          `insert into crm.deals
            (tenant_id, legal_entity_id, customer_id, title, expected_value, currency)
           values ($1, $2, $3, 'Forbidden', 1, 'CZK')`,
          [tenantA, legalEntityA, customerA],
        ),
        (error: { readonly code?: string }) => error.code === '42501',
      );
      await runtime.query('rollback');
    } finally {
      runtime.release();
    }

    await assert.rejects(
      admin.query('delete from crm.customers where customer_id = $1', [customerA]),
      (error: { readonly code?: string; readonly constraint?: string }) =>
        error.code === '23503' && error.constraint === 'crm_contacts_customer_fk',
    );
    await admin.query('delete from crm.contacts where contact_id = $1', [contactB]);
    await assert.rejects(
      admin.query('delete from crm.customers where customer_id = $1', [customerB]),
      (error: { readonly code?: string; readonly constraint?: string }) =>
        error.code === '23503' && error.constraint === 'crm_deals_customer_fk',
    );
  } finally {
    await cleanup();
    await Promise.all([admin.end(), runtimePool.end()]);
  }
});
