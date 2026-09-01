// @effect-diagnostics processEnv:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';

const runtimeUrl = process.env['DATABASE_URL']?.trim();

test(
  'runtime role fails closed without tenant scope and cannot bypass forced RLS',
  { skip: runtimeUrl === undefined ? 'DATABASE_URL is not available' : false },
  async () => {
    assert.ok(runtimeUrl);
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
        'select rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = current_user',
      );
      assert.equal(role.rows[0]?.rolsuper, false);
      assert.equal(role.rows[0]?.rolbypassrls, false);
      const rows = await client.query('select project_id from projects.projects');
      assert.deepEqual(rows.rows, []);
    } finally {
      await client.end();
    }
  },
);
