/// <reference types="node" />

import { fileURLToPath } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Option, Order, Redacted, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Reactivity } from 'effect/unstable/reactivity';

import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { loadOptionalCommercePortalAuthDatabaseConfig } from '../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';
import type { CommercePortalAuthDatabaseConnectionPair } from '../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';
import { assertDatabaseRoleManifestComplete } from './postgres/runtime-role-bootstrap.mts';

const EXPECTED_APPLICATION_SCHEMAS = [
  'assortment',
  'auth',
  'catalog',
  'commerce_customer_context',
  'commerce_customer_context_gateway',
  'commerce_market_catalog',
  'contacts',
  'core',
  'demo_email',
  'inventory',
  'party',
  'payment_term_catalog',
  'price_group_catalog',
  'pricing',
  'privacy',
  'legal_agreements',
  'finance_billing',
  'property_leasing',
  'property_portfolio',
  'crm_activities',
  'work_tasks',
  'demo_workforce',
  'demo_tagging',
  'demo_crm',
  'demo_sales_pipeline',
  'demo_merchandise',
  'facility_operations',
  'demo_sales_insights',
  'storefront_registry',
  'tax',
  'trust',
] as const;
const EXPECTED_MIGRATION_JOURNALS = [
  '__drizzle_migrations_assortment',
  '__drizzle_migrations_auth',
  '__drizzle_migrations_catalog',
  '__drizzle_migrations_commerce_customer_context',
  '__drizzle_migrations_commerce_market_catalog',
  '__drizzle_migrations_contacts',
  '__drizzle_migrations_core',
  '__drizzle_migrations_inventory',
  '__drizzle_migrations_party',
  '__drizzle_migrations_payment_term_catalog',
  '__drizzle_migrations_price_group_catalog',
  '__drizzle_migrations_pricing',
  '__drizzle_migrations_privacy',
  '__drizzle_migrations_legal_agreements',
  '__drizzle_migrations_finance_billing',
  '__drizzle_migrations_property_leasing',
  '__drizzle_migrations_property_portfolio',
  '__drizzle_migrations_crm_activities',
  '__drizzle_migrations_work_tasks',
  '__drizzle_migrations_demo_workforce',
  '__drizzle_migrations_demo_tagging',
  '__drizzle_migrations_demo_crm',
  '__drizzle_migrations_demo_sales_pipeline',
  '__drizzle_migrations_demo_merchandise',
  '__drizzle_migrations_facility_operations',
  '__drizzle_migrations_demo_sales_insights',
  '__drizzle_migrations_storefront_registry',
  '__drizzle_migrations_tax',
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

const query = <Row extends object>(
  client: PgClient.PgClient,
  text: string,
  reason: string,
): Effect.Effect<readonly Row[], ApplicationDatabaseVerificationError> =>
  client.unsafe<Row>(text).pipe(Effect.mapError((cause) => verificationFailure(reason, cause)));

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
    return {
      journals: EffectArray.sort(EXPECTED_MIGRATION_JOURNALS, Order.String),
      schemas: EffectArray.sort(EXPECTED_APPLICATION_SCHEMAS, Order.String),
    };
  }
  return {
    journals: EffectArray.sort([...EXPECTED_MIGRATION_JOURNALS, COMMERCE_PORTAL_AUTH_MIGRATION_JOURNAL], Order.String),
    schemas: EffectArray.sort([...EXPECTED_APPLICATION_SCHEMAS, COMMERCE_PORTAL_AUTH_SCHEMA_NAME], Order.String),
  };
};

const verifyApplicationCatalog = (client: PgClient.PgClient, expected: ApplicationCatalogExpectation) =>
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
    const actualSchemas = schemas.map((row) => row.schema_name);
    const actualJournals = journals.map((row) => row.table_name);

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

export const ownerVerifierPaths = [
  './verify-core-db-schema.mts',
  '../apps/shell-super-app/scripts/verify-auth-db-schema.mts',
  '../verticals/assortment/scripts/verify-db-schema.mts',
  '../verticals/party-registry/scripts/verify-db-schema.mts',
  '../verticals/party-registry/scripts/verify-engagement-db-schema.mts',
  '../verticals/payment-term-catalog/scripts/verify-db-schema.mts',
  '../verticals/price-group-catalog/scripts/verify-db-schema.mts',
  '../verticals/commerce-customer-context/scripts/verify-db-schema.mts',
  '../verticals/commerce-market-catalog/scripts/verify-db-schema.mts',
  '../verticals/catalog/scripts/verify-db-schema.mts',
  '../verticals/inventory/scripts/verify-db-schema.mts',
  '../verticals/pricing/scripts/verify-db-schema.mts',
  '../verticals/privacy/scripts/verify-db-schema.mts',
  '../verticals/legal-agreements/scripts/verify-db-schema.mts',
  '../verticals/finance-billing/scripts/verify-db-schema.mts',
  '../verticals/property-leasing/scripts/verify-db-schema.mts',
  '../verticals/property-portfolio/scripts/verify-db-schema.mts',
  '../verticals/crm-activities/scripts/verify-db-schema.mts',
  '../verticals/work-tasks/scripts/verify-db-schema.mts',
  '../verticals/workforce/scripts/verify-db-schema.mts',
  '../verticals/tagging/scripts/verify-db-schema.mts',
  '../verticals/crm/scripts/verify-db-schema.mts',
  '../verticals/sales-pipeline/scripts/verify-db-schema.mts',
  '../verticals/merchandise/scripts/verify-db-schema.mts',
  '../verticals/sales-insights/scripts/verify-db-schema.mts',
  '../verticals/facility-operations/scripts/verify-db-schema.mts',
  '../verticals/storefront-registry/scripts/verify-db-schema.mts',
  '../verticals/tax/scripts/verify-db-schema.mts',
] as const;

const COMMERCE_PORTAL_AUTH_VERIFIER = '../verticals/commerce-customer-context/scripts/verify-portal-auth-db-schema.mts';

/** Owner CLIs may start asynchronous runtimes and report failure only through their exit code. */
export const verifyOwnerSchema = Effect.fn('ApplicationDatabase.verifyOwnerSchema')(function* verifyOwnerSchema(
  ownerVerifierPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(process.execPath, [fileURLToPath(new URL(ownerVerifierPath, import.meta.url))], {
        stderr: 'inherit',
        stdout: 'inherit',
      }),
    )
    .pipe(
      Effect.mapError((cause) => verificationFailure(`Owner database verifier ${ownerVerifierPath} failed`, cause)),
    );
  if (code !== 0) {
    return yield* verificationFailure(`Owner database verifier ${ownerVerifierPath} exited with code ${code}`);
  }
  return yield* Effect.void;
});

const main = Effect.gen(function* verifyApplicationDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const commerceConfiguration = yield* loadOptionalCommercePortalAuthDatabaseConfig().pipe(
    Effect.mapError((failure) => verificationFailure(failure.reason)),
  );
  const expected = applicationCatalogExpectation(configuration.admin, commerceConfiguration);
  yield* PgClient.makeClient({ url: Redacted.make(configuration.admin.connectionString) }).pipe(
    Effect.mapError((cause) =>
      verificationFailure('Unable to connect to the administrative PostgreSQL database', cause),
    ),
    Effect.flatMap((client) =>
      Effect.gen(function* verifyCompleteCatalog() {
        yield* verifyApplicationCatalog(client, expected);
        yield* assertDatabaseRoleManifestComplete(client).pipe(
          Effect.mapError((failure) => verificationFailure(failure.reason)),
        );
      }),
    ),
    Effect.scoped,
  );

  yield* Console.log('Verified exact application schemas and migration journals');
  for (const ownerVerifierPath of ownerVerifierPaths) {
    yield* verifyOwnerSchema(ownerVerifierPath);
  }
  if (Option.isSome(commerceConfiguration)) {
    yield* verifyOwnerSchema(COMMERCE_PORTAL_AUTH_VERIFIER);
  }
}).pipe(Effect.tapError((failure) => Console.error(failure.reason)));

if (import.meta.main) {
  NodeRuntime.runMain(main.pipe(Effect.provide([Reactivity.layer, NodeServices.layer])));
}
