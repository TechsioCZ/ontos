import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Console, Effect, Exit, Option, Order, Schema } from 'effect';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { loadOptionalCommercePortalAuthDatabaseConfig } from '../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';
import type { CommercePortalAuthDatabaseConnectionPair } from '../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';

const EXPECTED_APPLICATION_SCHEMAS = [
  'auth',
  'commerce_customer_context',
  'contacts',
  'core',
  'party',
  'payment_term_catalog',
] as const;
const EXPECTED_MIGRATION_JOURNALS = [
  '__drizzle_migrations_auth',
  '__drizzle_migrations_commerce_customer_context',
  '__drizzle_migrations_contacts',
  '__drizzle_migrations_core',
  '__drizzle_migrations_party',
  '__drizzle_migrations_payment_term_catalog',
] as const;
const COMMERCE_PORTAL_AUTH_SCHEMA_NAME = 'commerce_auth' as const;
const COMMERCE_PORTAL_AUTH_MIGRATION_JOURNAL = '__drizzle_migrations_commerce_portal_auth' as const;

class ApplicationDatabaseVerificationError extends Schema.TaggedError<ApplicationDatabaseVerificationError>()(
  'ApplicationDatabaseVerificationError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    reason: Schema.String,
  },
) {}

const verificationFailure = (reason: string, cause?: unknown): ApplicationDatabaseVerificationError =>
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

interface DatabaseTarget {
  readonly database: string;
  readonly host: string;
  readonly port: number;
}

interface ApplicationCatalogExpectation {
  readonly journals: readonly string[];
  readonly schemas: readonly string[];
}

const sameDatabaseTarget = (left: DatabaseTarget, right: DatabaseTarget): boolean =>
  left.database === right.database && left.host === right.host && left.port === right.port;

const applicationCatalogExpectation = (
  primaryDatabase: DatabaseTarget,
  commerceConfiguration: Option.Option<CommercePortalAuthDatabaseConnectionPair>,
): ApplicationCatalogExpectation => {
  const commerceUsesPrimaryDatabase =
    Option.isSome(commerceConfiguration) && sameDatabaseTarget(primaryDatabase, commerceConfiguration.value.admin);
  if (!commerceUsesPrimaryDatabase) {
    return { journals: EXPECTED_MIGRATION_JOURNALS, schemas: EXPECTED_APPLICATION_SCHEMAS };
  }
  return {
    journals: EffectArray.sort([...EXPECTED_MIGRATION_JOURNALS, COMMERCE_PORTAL_AUTH_MIGRATION_JOURNAL], Order.String),
    schemas: EffectArray.sort([...EXPECTED_APPLICATION_SCHEMAS, COMMERCE_PORTAL_AUTH_SCHEMA_NAME], Order.String),
  };
};

const verifyApplicationCatalog = (client: Client, expected: ApplicationCatalogExpectation) =>
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

    if (!orderedValuesMatch(actualSchemas, expected.schemas)) {
      yield* verificationFailure(
        `Application schema mismatch; expected=[${expected.schemas.join(', ')}], actual=[${actualSchemas.join(', ')}]`,
      );
    }
    if (!orderedValuesMatch(actualJournals, expected.journals)) {
      yield* verificationFailure(
        `Migration journal mismatch; expected=[${expected.journals.join(', ')}], actual=[${actualJournals.join(', ')}]`,
      );
    }
  });

const ownerVerifierPaths = [
  '../packages/core-runtime/scripts/verify-db-schema.mts',
  '../apps/shell-super-app/scripts/verify-auth-db-schema.mts',
  '../verticals/party-registry/scripts/verify-db-schema.mts',
  '../verticals/party-registry/scripts/verify-engagement-db-schema.mts',
  '../verticals/payment-term-catalog/scripts/verify-db-schema.mts',
  '../verticals/commerce-customer-context/scripts/verify-db-schema.mts',
] as const;

const COMMERCE_PORTAL_AUTH_VERIFIER = '../verticals/commerce-customer-context/scripts/verify-portal-auth-db-schema.mts';

/**
 * The Commerce portal realm is optional, so its owner verifier only runs for a workspace that
 * opted in — the same condition `scripts/run-zerops-migrator.mjs` applies before migrating it.
 * Unlike the verifiers above it reports through its exit code rather than by rejecting, so it is
 * run as its own process and that exit code is what this verification reads.
 */
const verifyCommercePortalAuthOwnerSchema = Effect.callback<boolean, ApplicationDatabaseVerificationError>((resume) => {
  const { spawn } = process.getBuiltinModule('node:child_process');
  const verifier = fileURLToPath(new URL(COMMERCE_PORTAL_AUTH_VERIFIER, import.meta.url));
  const child = spawn(process.execPath, [verifier], { stdio: 'inherit' });
  const onError = (cause: Error) => {
    resume(Effect.fail(verificationFailure(`Owner database verifier ${COMMERCE_PORTAL_AUTH_VERIFIER} failed`, cause)));
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const outcome = signal ?? `code ${String(code)}`;
    resume(
      code === 0
        ? Effect.succeed(true)
        : Effect.fail(
            verificationFailure(`Owner database verifier ${COMMERCE_PORTAL_AUTH_VERIFIER} exited with ${outcome}`),
          ),
    );
  };

  child.once('error', onError);
  child.once('exit', onExit);
  return Effect.sync(() => {
    child.off('error', onError);
    child.off('exit', onExit);
  });
}).pipe(Effect.asVoid);

const main = Effect.gen(function* verifyApplicationDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const commerceConfiguration = yield* loadOptionalCommercePortalAuthDatabaseConfig().pipe(
    Effect.mapError((failure) => verificationFailure(failure.reason)),
  );
  const expected = applicationCatalogExpectation(configuration.admin, commerceConfiguration);
  yield* Effect.acquireUseRelease(
    Effect.gen(function* acquireAdministrativeClient() {
      const client = yield* Effect.try({
        catch: (cause) => verificationFailure('Unable to create the administrative PostgreSQL client', cause),
        try: () =>
          new Client({
            connectionString: configuration.admin.connectionString,
          }),
      });
      yield* Effect.tryPromise({
        catch: (cause) => verificationFailure('Unable to connect to the administrative PostgreSQL database', cause),
        try: async () => await client.connect(),
      });
      return client;
    }),
    (client) => verifyApplicationCatalog(client, expected),
    (client) =>
      Effect.tryPromise({
        catch: (cause) => verificationFailure('Unable to close the administrative PostgreSQL connection', cause),
        try: async () => await client.end(),
      }),
  );

  yield* Console.log('Verified exact application schemas and migration journals');
  for (const ownerVerifierPath of ownerVerifierPaths) {
    yield* Effect.tryPromise({
      catch: (cause) => verificationFailure(`Owner database verifier ${ownerVerifierPath} failed`, cause),
      try: async () => {
        await import(ownerVerifierPath);
      },
    });
  }
  if (Option.isSome(commerceConfiguration)) {
    yield* verifyCommercePortalAuthOwnerSchema;
  }
}).pipe(Effect.tapError((failure) => Console.error(failure.reason)));

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
