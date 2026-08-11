import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import { Client } from 'pg';
import { loadCrmDatabaseConnectionPair } from '../../src/db/config.ts';

const tenantA = '81000000-0000-4000-8000-000000000001';
const tenantB = '81000000-0000-4000-8000-000000000002';

test('enforces tenant RLS, active registration uniqueness, optimistic versions, and tombstones', async () => {
  const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
  const admin = new Client({ connectionString: configuration.admin.connectionString });
  const runtime = new Client({ connectionString: configuration.runtime.connectionString });
  await admin.connect();
  await runtime.connect();

  const transactAs = async (tenantId: string, operation: () => Promise<void>) => {
    await runtime.query('begin');
    try {
      await runtime.query("select set_config('ontos.tenant_id', $1, true)", [tenantId]);
      await operation();
      await runtime.query('commit');
    } catch (error) {
      await runtime.query('rollback');
      throw error;
    }
  };

  try {
    await admin.query('delete from crm.customers where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    let customerId = '';
    await transactAs(tenantA, async () => {
      const created = await runtime.query<{ readonly customer_id: string }>(
        `insert into crm.customers (tenant_id, name, company_registration_number)
         values ($1, 'Acme', 'CZ123456') returning customer_id`,
        [tenantA],
      );
      customerId = created.rows[0]?.customer_id ?? '';
      await runtime.query(
        "insert into crm.customers (tenant_id, name) values ($1, 'Shared name')",
        [tenantA],
      );
      await runtime.query(
        "insert into crm.customers (tenant_id, name) values ($1, 'Shared name')",
        [tenantA],
      );
      await assert.rejects(
        runtime.query(
          "insert into crm.customers (tenant_id, name, company_registration_number) values ($1, 'Duplicate', 'CZ123456')",
          [tenantA],
        ),
        (error: { readonly code?: string; readonly constraint?: string }) =>
          error.code === '23505' && error.constraint === 'crm_customers_active_registration_uk',
      );
    });

    // The duplicate assertion aborts its transaction, so create the durable fixture separately.
    await transactAs(tenantA, async () => {
      const created = await runtime.query<{ readonly customer_id: string }>(
        `insert into crm.customers (tenant_id, name, company_registration_number)
         values ($1, 'Acme', 'CZ123456') returning customer_id`,
        [tenantA],
      );
      customerId = created.rows[0]?.customer_id ?? '';
    });
    await transactAs(tenantB, async () => {
      await runtime.query(
        "insert into crm.customers (tenant_id, name, company_registration_number) values ($1, 'Other tenant', 'CZ123456')",
        [tenantB],
      );
      const visible = await runtime.query<{ readonly tenant_id: string }>(
        'select tenant_id from crm.customers',
      );
      assert.deepEqual(
        visible.rows.map(({ tenant_id }) => tenant_id),
        [tenantB],
      );
    });
    await transactAs(tenantA, async () => {
      const stale = await runtime.query(
        'update crm.customers set name = $1, version = version + 1 where customer_id = $2 and version = $3',
        ['Stale', customerId, 2],
      );
      assert.equal(stale.rowCount, 0);
      const deleted = await runtime.query(
        'update crm.customers set deleted_at = now(), version = version + 1 where customer_id = $1 and version = 1',
        [customerId],
      );
      assert.equal(deleted.rowCount, 1);
      await runtime.query(
        "insert into crm.customers (tenant_id, name, company_registration_number) values ($1, 'Replacement', 'CZ123456')",
        [tenantA],
      );
      const ordinary = await runtime.query<{ readonly name: string }>(
        'select name from crm.customers where deleted_at is null order by name, customer_id',
      );
      assert.deepEqual(ordinary.rows, [{ name: 'Replacement' }]);
    });
  } finally {
    await admin.query('delete from crm.customers where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await Promise.all([admin.end(), runtime.end()]);
  }
});
