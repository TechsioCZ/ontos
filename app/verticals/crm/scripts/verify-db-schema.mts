// @effect-diagnostics processEnv:off globalConsole:off strictEffectProvide:off
import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import type { Context } from 'effect';
import { makeCrmDatabase } from '../src/db/client.ts';
import type { CrmDatabase } from '../src/db/client.ts';
import type { CrmDatabaseConfigValue } from '../src/db/config.ts';
import { loadCrmDatabaseConnectionPair } from '../src/db/config.ts';
import { CRM_SCHEMA_NAME, CRM_TABLE_INVENTORY } from '../src/db/schema.ts';

class CrmDatabaseVerificationError extends Schema.TaggedErrorClass<CrmDatabaseVerificationError>()(
  'CrmDatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

const inspectAs = <Value,>(
  configuration: CrmDatabaseConfigValue,
  inspect: (
    database: Context.Service.Shape<typeof CrmDatabase>,
  ) => Effect.Effect<Value, CrmDatabaseVerificationError>,
) => Effect.scoped(makeCrmDatabase(configuration).pipe(Effect.flatMap(inspect)));

const verifyAdminCatalog = (configuration: CrmDatabaseConfigValue) =>
  inspectAs(configuration, (database) =>
    Effect.gen(function* verifyCrmAdminCatalog() {
      const result = yield* Effect.tryPromise({
        catch: () =>
          new CrmDatabaseVerificationError({
            reason: 'Unable to inspect the CRM PostgreSQL schema boundary',
          }),
        try: () =>
          database.executor.execute<{
            readonly owner_name: string;
            readonly schema_name: string;
            readonly table_name: null | string;
          }>(sql`
            select
              namespace.nspname as schema_name,
              owner.rolname as owner_name,
              relation.relname as table_name
            from pg_catalog.pg_namespace as namespace
            inner join pg_catalog.pg_roles as owner on owner.oid = namespace.nspowner
            left join pg_catalog.pg_class as relation
              on relation.relnamespace = namespace.oid
              and relation.relkind in (${'r'}, ${'p'})
            where namespace.nspname = ${CRM_SCHEMA_NAME}
            order by relation.relname
          `),
      });
      const [schema] = result.rows;
      if (schema === undefined) {
        return yield* new CrmDatabaseVerificationError({
          reason: `PostgreSQL schema ${CRM_SCHEMA_NAME} is missing`,
        });
      }
      if (schema.owner_name !== configuration.user || schema.owner_name === 'ontos_runtime') {
        return yield* new CrmDatabaseVerificationError({
          reason: 'CRM schema is not owned by its configured administrative identity',
        });
      }
      const tableNames = result.rows.flatMap(({ table_name }) =>
        table_name === null ? [] : [table_name],
      );
      if (JSON.stringify(tableNames) !== JSON.stringify(CRM_TABLE_INVENTORY)) {
        return yield* new CrmDatabaseVerificationError({
          reason: `CRM table inventory mismatch; expected=[], found=[${tableNames.join(', ')}]`,
        });
      }
      const journal = yield* Effect.tryPromise({
        catch: () =>
          new CrmDatabaseVerificationError({
            reason: 'Unable to inspect CRM Drizzle migration bookkeeping',
          }),
        try: () =>
          database.executor.execute<{ readonly table_name: string }>(sql`
            select relation.relname as table_name
            from pg_catalog.pg_class as relation
            inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = ${'drizzle'}
              and relation.relkind = ${'r'}
              and relation.relname = ${'__drizzle_migrations_crm'}
          `),
      });
      if (journal.rows.length !== 1) {
        return yield* new CrmDatabaseVerificationError({
          reason: 'CRM migration journal drizzle.__drizzle_migrations_crm is missing',
        });
      }
      return tableNames.length;
    }),
  );

const verifyRuntimeRole = (configuration: CrmDatabaseConfigValue) =>
  inspectAs(configuration, (database) =>
    Effect.gen(function* verifyCrmRuntimeRole() {
      const result = yield* Effect.tryPromise({
        catch: () =>
          new CrmDatabaseVerificationError({
            reason: 'Unable to inspect the CRM runtime-role boundary',
          }),
        try: () =>
          database.executor.execute<{
            readonly can_create: boolean;
            readonly can_use: boolean;
            readonly rolbypassrls: boolean;
            readonly rolsuper: boolean;
            readonly user_name: string;
          }>(sql`
            select
              current_user as user_name,
              role.rolsuper,
              role.rolbypassrls,
              has_schema_privilege(current_user, ${CRM_SCHEMA_NAME}, ${'USAGE'}) as can_use,
              has_schema_privilege(current_user, ${CRM_SCHEMA_NAME}, ${'CREATE'}) as can_create
            from pg_catalog.pg_roles as role
            where role.rolname = current_user
          `),
      });
      const [runtime] = result.rows;
      if (
        runtime === undefined ||
        runtime.user_name !== configuration.user ||
        runtime.rolsuper ||
        runtime.rolbypassrls ||
        !runtime.can_use ||
        runtime.can_create
      ) {
        return yield* new CrmDatabaseVerificationError({
          reason: 'CRM runtime-role grants violate the least-privilege boundary',
        });
      }
    }),
  );

const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
const tableCount = await Effect.runPromise(verifyAdminCatalog(configuration.admin));
await Effect.runPromise(verifyRuntimeRole(configuration.runtime));

console.log(`Verified ${tableCount} typed tables in PostgreSQL schema ${CRM_SCHEMA_NAME}`);
