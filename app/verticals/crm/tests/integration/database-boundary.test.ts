import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import { Client } from 'pg';
import { loadCrmDatabaseConnectionPair } from '../../src/db/config.ts';

test('keeps CRM schema ownership administrative and runtime access least-privilege', async () => {
  const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
  const admin = new Client({ connectionString: configuration.admin.connectionString });
  const runtime = new Client({ connectionString: configuration.runtime.connectionString });

  await admin.connect();
  await runtime.connect();
  try {
    const ownership = await admin.query<{
      readonly owner_name: string;
      readonly table_count: string;
    }>(`
      select owner.rolname as owner_name, count(relation.oid)::text as table_count
      from pg_catalog.pg_namespace as namespace
      inner join pg_catalog.pg_roles as owner on owner.oid = namespace.nspowner
      left join pg_catalog.pg_class as relation
        on relation.relnamespace = namespace.oid
        and relation.relkind in ('r', 'p')
      where namespace.nspname = 'crm'
      group by owner.rolname
    `);
    assert.equal(ownership.rows[0]?.owner_name, configuration.admin.user);
    assert.equal(ownership.rows[0]?.table_count, '0');

    const privileges = await runtime.query<{
      readonly can_create: boolean;
      readonly can_use: boolean;
      readonly rolbypassrls: boolean;
      readonly rolsuper: boolean;
    }>(`
      select
        has_schema_privilege(current_user, 'crm', 'USAGE') as can_use,
        has_schema_privilege(current_user, 'crm', 'CREATE') as can_create,
        role.rolsuper,
        role.rolbypassrls
      from pg_catalog.pg_roles as role
      where role.rolname = current_user
    `);
    assert.deepEqual(privileges.rows, [
      {
        can_create: false,
        can_use: true,
        rolbypassrls: false,
        rolsuper: false,
      },
    ]);
    await assert.rejects(
      runtime.query('create table crm.runtime_boundary_violation (id integer)'),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
    );
  } finally {
    await Promise.all([admin.end(), runtime.end()]);
  }
});
