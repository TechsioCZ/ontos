import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { Client } from 'pg';

class ApplicationDatabaseVerificationError extends Schema.TaggedErrorClass<ApplicationDatabaseVerificationError>()(
  'ApplicationDatabaseVerificationError',
  { reason: Schema.String },
) {}

const EXPECTED_APPLICATION_SCHEMAS = ['auth', 'core', 'crm'] as const;
const EXPECTED_MIGRATION_JOURNALS = [
  '__drizzle_migrations_auth',
  '__drizzle_migrations_core',
  '__drizzle_migrations_crm',
] as const;

const verifyGlobalApplicationCatalog = Effect.gen(function* verifyGlobalApplicationCatalogEffect() {
  const { admin } = yield* loadDatabaseConnectionPair();
  const client = new Client({ connectionString: admin.connectionString });
  yield* Effect.tryPromise({
    catch: () =>
      new ApplicationDatabaseVerificationError({
        reason: 'Unable to connect as the PostgreSQL administrative identity',
      }),
    try: () => client.connect(),
  });
  const catalog = yield* Effect.tryPromise({
    catch: () =>
      new ApplicationDatabaseVerificationError({
        reason: 'Unable to inspect the global application database catalog',
      }),
    try: () =>
      client.query<{
        readonly kind: 'journal' | 'schema';
        readonly name: string;
      }>(`
        select 'schema'::text as kind, namespace.nspname as name
        from pg_catalog.pg_namespace as namespace
        where namespace.nspname not in ('drizzle', 'information_schema', 'public')
          and namespace.nspname not like 'pg\\_%'
        union all
        select 'journal'::text as kind, relation.relname as name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'drizzle' and relation.relkind = 'r'
        order by kind, name
      `),
  }).pipe(Effect.ensuring(Effect.promise(() => client.end())));
  const schemas = catalog.rows
    .filter(({ kind }) => kind === 'schema')
    .map(({ name }) => name)
    .toSorted();
  const journals = catalog.rows
    .filter(({ kind }) => kind === 'journal')
    .map(({ name }) => name)
    .toSorted();
  if (
    JSON.stringify(schemas) !== JSON.stringify(EXPECTED_APPLICATION_SCHEMAS) ||
    JSON.stringify(journals) !== JSON.stringify(EXPECTED_MIGRATION_JOURNALS)
  ) {
    return yield* new ApplicationDatabaseVerificationError({
      reason: `Global application catalog mismatch; schemas=[${schemas.join(', ')}], migrationJournals=[${journals.join(', ')}]`,
    });
  }
});

await Effect.runPromise(verifyGlobalApplicationCatalog);
await import('../packages/core-runtime/scripts/verify-db-schema.mts');
await import('../apps/shell-super-app/scripts/verify-auth-db-schema.mts');
await import('../verticals/crm/scripts/verify-db-schema.mts');
