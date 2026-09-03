import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { APP_ENV_PATH } from '../../packages/core-runtime/src/environment/workspace-environment.ts';

loadDotenv({ path: APP_ENV_PATH, quiet: true });

const adminUrl = process.env['DATABASE_ADMIN_URL']?.trim();
const runtimeUrl = process.env['DATABASE_URL']?.trim();
if (adminUrl === undefined || runtimeUrl === undefined) {
  throw new Error('DATABASE_ADMIN_URL and DATABASE_URL are required');
}
const admin = new URL(adminUrl);
const runtime = new URL(runtimeUrl);
if (
  adminUrl === runtimeUrl ||
  admin.username === runtime.username ||
  runtime.username === 'postgres'
) {
  throw new Error('Administrative and runtime PostgreSQL identities must be distinct');
}
if (runtime.username !== 'ontos_runtime' || runtime.password.length === 0) {
  throw new Error('DATABASE_URL must use the configured ontos_runtime login');
}

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const client = new Client({ connectionString: adminUrl });
await client.connect();
try {
  await client.query('begin');
  const exists = await client.query<{ exists: boolean }>(
    'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
    [runtime.username],
  );
  const password = quoteLiteral(decodeURIComponent(runtime.password));
  await client.query(
    exists.rows[0]?.exists === true
      ? `alter role ontos_runtime login password ${password} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
      : `create role ontos_runtime login password ${password} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
  );
  await client.query(
    `grant connect on database "${admin.pathname.slice(1).replaceAll('"', '""')}" to ontos_runtime`,
  );
  for (const schema of ['core', 'auth', 'contacts', 'projects']) {
    const schemaExists = await client.query<{ exists: boolean }>(
      'select exists(select 1 from pg_catalog.pg_namespace where nspname = $1) as exists',
      [schema],
    );
    if (schemaExists.rows[0]?.exists !== true) {
      continue;
    }
    await client.query(`grant usage on schema ${schema} to ontos_runtime`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema ${schema} to ontos_runtime`,
    );
    await client.query(`grant usage, select on all sequences in schema ${schema} to ontos_runtime`);
    await client.query(
      `alter default privileges in schema ${schema} grant select, insert, update, delete on tables to ontos_runtime`,
    );
    await client.query(
      `alter default privileges in schema ${schema} grant usage, select on sequences to ontos_runtime`,
    );
  }
  const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'select rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = $1',
    [runtime.username],
  );
  if (role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false) {
    throw new Error('Runtime role must be non-superuser and must not bypass RLS');
  }
  await client.query('commit');
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
console.log('Verified least-privilege PostgreSQL role ontos_runtime');
