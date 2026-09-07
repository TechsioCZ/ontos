import { Console, Effect, Exit, Schema } from 'effect';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';

const EXPECTED_APPLICATION_SCHEMAS = ['auth', 'contacts', 'core', 'party'] as const;
const EXPECTED_MIGRATION_JOURNALS = [
  '__drizzle_migrations_auth',
  '__drizzle_migrations_contacts',
  '__drizzle_migrations_core',
  '__drizzle_migrations_party',
] as const;

class ApplicationDatabaseVerificationError extends Schema.TaggedError<ApplicationDatabaseVerificationError>()(
  'ApplicationDatabaseVerificationError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    reason: Schema.String,
  },
) {}

const verificationFailure = (
  reason: string,
  cause?: unknown,
): ApplicationDatabaseVerificationError =>
  new ApplicationDatabaseVerificationError(cause === undefined ? { reason } : { cause, reason });

const query = <Row extends QueryResultRow>(
  client: Client,
  text: string,
  reason: string,
): Effect.Effect<QueryResult<Row>, ApplicationDatabaseVerificationError> =>
  Effect.tryPromise({
    catch: (cause) => verificationFailure(reason, cause),
    try: async () => await client.query<Row>(text),
  });

const orderedValuesMatch = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const verifyApplicationCatalog = (client: Client) =>
  Effect.gen(function* verifyApplicationCatalogEffect() {
    // PostgreSQL catalogs have no Drizzle table model. This verification-only query
    // exact-matches every application schema and independent migration journal.
    const schemas = yield* query<{ schema_name: string }>(
      client,
      `
        select namespace.nspname as schema_name
        from pg_catalog.pg_namespace as namespace
        where namespace.nspname <> 'information_schema'
          and namespace.nspname not like 'pg\\_%'
          and namespace.nspname not in ('drizzle', 'public')
        order by namespace.nspname
      `,
      'Unable to verify the application schema catalog',
    );
    const journals = yield* query<{ table_name: string }>(
      client,
      `
        select relation.relname as table_name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'drizzle'
          and relation.relkind = 'r'
        order by relation.relname
      `,
      'Unable to verify the application migration journals',
    );
    const actualSchemas = schemas.rows.map((row) => row.schema_name);
    const actualJournals = journals.rows.map((row) => row.table_name);

    if (!orderedValuesMatch(actualSchemas, EXPECTED_APPLICATION_SCHEMAS)) {
      yield* verificationFailure(
        `Application schema mismatch; expected=[${EXPECTED_APPLICATION_SCHEMAS.join(', ')}], actual=[${actualSchemas.join(', ')}]`,
      );
    }
    if (!orderedValuesMatch(actualJournals, EXPECTED_MIGRATION_JOURNALS)) {
      yield* verificationFailure(
        `Migration journal mismatch; expected=[${EXPECTED_MIGRATION_JOURNALS.join(', ')}], actual=[${actualJournals.join(', ')}]`,
      );
    }
  });

const ownerVerifierPaths = [
  '../packages/core-runtime/scripts/verify-db-schema.mts',
  '../apps/shell-super-app/scripts/verify-auth-db-schema.mts',
  '../verticals/party-registry/scripts/verify-db-schema.mts',
  '../verticals/party-registry/scripts/verify-engagement-db-schema.mts',
] as const;

const main = Effect.gen(function* verifyApplicationDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  yield* Effect.acquireUseRelease(
    Effect.gen(function* acquireAdministrativeClient() {
      const client = yield* Effect.try({
        catch: (cause) =>
          verificationFailure('Unable to create the administrative PostgreSQL client', cause),
        try: () => new Client({ connectionString: configuration.admin.connectionString }),
      });
      yield* Effect.tryPromise({
        catch: (cause) =>
          verificationFailure('Unable to connect to the administrative PostgreSQL database', cause),
        try: async () => await client.connect(),
      });
      return client;
    }),
    verifyApplicationCatalog,
    (client) =>
      Effect.tryPromise({
        catch: (cause) =>
          verificationFailure('Unable to close the administrative PostgreSQL connection', cause),
        try: async () => await client.end(),
      }),
  );

  yield* Console.log('Verified exact application schemas and migration journals');
  for (const ownerVerifierPath of ownerVerifierPaths) {
    yield* Effect.tryPromise({
      catch: (cause) => verificationFailure('An owner database verifier failed', cause),
      try: async () => {
        await import(ownerVerifierPath);
      },
    });
  }
}).pipe(Effect.tapError((failure) => Console.error(failure.reason)));

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
