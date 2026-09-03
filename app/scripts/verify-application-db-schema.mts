import { Effect } from 'effect';
import { Client } from 'pg';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';

const EXPECTED_APPLICATION_SCHEMAS = ['auth', 'contacts', 'core', 'projects'] as const;
const EXPECTED_MIGRATION_JOURNALS = [
  '__drizzle_migrations_auth',
  '__drizzle_migrations_contacts',
  '__drizzle_migrations_core',
  '__drizzle_migrations_projects',
] as const;

const configuration = await Effect.runPromise(loadDatabaseConnectionPair());
const client = new Client({ connectionString: configuration.admin.connectionString });
await client.connect();
try {
  // PostgreSQL catalogs have no Drizzle table model. This verification-only query
  // exact-matches every application schema and independent migration journal.
  const schemas = await client.query<{ schema_name: string }>(`
    select namespace.nspname as schema_name
    from pg_catalog.pg_namespace as namespace
    where namespace.nspname <> 'information_schema'
      and namespace.nspname not like 'pg\\_%'
      and namespace.nspname not in ('drizzle', 'public')
    order by namespace.nspname
  `);
  const journals = await client.query<{ table_name: string }>(`
    select relation.relname as table_name
    from pg_catalog.pg_class as relation
    inner join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'drizzle'
      and relation.relkind = 'r'
    order by relation.relname
  `);
  const actualSchemas = schemas.rows.map((row) => row.schema_name);
  const actualJournals = journals.rows.map((row) => row.table_name);

  if (JSON.stringify(actualSchemas) !== JSON.stringify(EXPECTED_APPLICATION_SCHEMAS)) {
    throw new Error(
      `Application schema mismatch; expected=[${EXPECTED_APPLICATION_SCHEMAS.join(', ')}], actual=[${actualSchemas.join(', ')}]`,
    );
  }
  if (JSON.stringify(actualJournals) !== JSON.stringify(EXPECTED_MIGRATION_JOURNALS)) {
    throw new Error(
      `Migration journal mismatch; expected=[${EXPECTED_MIGRATION_JOURNALS.join(', ')}], actual=[${actualJournals.join(', ')}]`,
    );
  }
} finally {
  await client.end();
}

console.log('Verified exact application schemas and migration journals');
await import('../packages/core-runtime/scripts/verify-db-schema.mts');
await import('../apps/shell-super-app/scripts/verify-auth-db-schema.mts');
await import('../verticals/contacts/scripts/verify-db-schema.mts');
