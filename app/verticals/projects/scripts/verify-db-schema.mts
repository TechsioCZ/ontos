/* eslint-disable curly -- Verification failures are single-statement fail-fast branches. */
// @effect-diagnostics globalConsole:off
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Client } from 'pg';
import { compareProjectsCatalog } from '../src/db/catalog.ts';
import { PROJECTS_SCHEMA_NAME, projects } from '../src/db/schema.ts';

const connections = await Effect.runPromise(loadDatabaseConnectionPair());
const client = new Client({ connectionString: connections.admin.connectionString });
await client.connect();
try {
  const database = drizzle(client);
  await database.select().from(projects).limit(0);
  const catalog = await database.execute<{ table_name: string }>(sql`
    select relation.relname as table_name
    from pg_catalog.pg_class as relation
    inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = ${PROJECTS_SCHEMA_NAME} and relation.relkind in (${'r'}, ${'p'})
    order by relation.relname
  `);
  const difference = compareProjectsCatalog(
    catalog.rows.map((row) => `${PROJECTS_SCHEMA_NAME}.${row.table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0)
    throw new Error(
      `Projects catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    );
  const infrastructure = await database.execute<{
    forced_rls: boolean;
    journal_count: number;
    policy_count: number;
    role_bypass_rls: boolean;
    role_super: boolean;
  }>(sql`
    select relation.relforcerowsecurity as forced_rls,
      (select count(*)::integer from pg_catalog.pg_policy where polrelid = relation.oid) as policy_count,
      (select count(*)::integer from pg_catalog.pg_class as journal
        inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace
        where journal_namespace.nspname = ${'drizzle'}
          and journal.relname = ${'__drizzle_migrations_projects'}) as journal_count,
      runtime_role.rolsuper as role_super, runtime_role.rolbypassrls as role_bypass_rls
    from pg_catalog.pg_class as relation
    inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join pg_catalog.pg_roles as runtime_role
    where namespace.nspname = ${PROJECTS_SCHEMA_NAME} and relation.relname = ${'projects'}
      and runtime_role.rolname = ${'ontos_runtime'}
  `);
  const [verified] = infrastructure.rows;
  if (
    verified === undefined ||
    !verified.forced_rls ||
    verified.policy_count !== 4 ||
    verified.journal_count !== 1 ||
    verified.role_super ||
    verified.role_bypass_rls
  )
    throw new Error('Projects RLS, journal, or runtime-role contract does not match');
} finally {
  await client.end();
}

console.log('Verified typed Projects schema, owner journal, and forced tenant RLS');
