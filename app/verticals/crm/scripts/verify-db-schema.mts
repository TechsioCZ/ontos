// @effect-diagnostics processEnv:off globalConsole:off strictEffectProvide:off
import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import type { Context } from 'effect';
import { makeCrmDatabase } from '../src/db/client.ts';
import type { CrmDatabase } from '../src/db/client.ts';
import type { CrmDatabaseConfigValue } from '../src/db/config.ts';
import { loadCrmDatabaseConnectionPair } from '../src/db/config.ts';
import { CRM_SCHEMA_NAME, CRM_TABLE_INVENTORY } from '../src/db/schema.ts';
import { DEAL_CURRENCY_CODES } from '../shared/deal-currencies.ts';

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
    // eslint-disable-next-line complexity -- Exact owner, table, RLS, FK, check, index, and journal verification is intentionally one fail-closed catalog audit.
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
          reason: `CRM table inventory mismatch; expected=[${CRM_TABLE_INVENTORY.join(', ')}], found=[${tableNames.join(', ')}]`,
        });
      }
      const customerBoundary = yield* Effect.tryPromise({
        catch: () =>
          new CrmDatabaseVerificationError({
            reason: 'Unable to inspect the CRM Customer RLS and index boundary',
          }),
        try: () =>
          database.executor.execute<{
            readonly index_name: string | null;
            readonly policy_count: string;
            readonly relforcerowsecurity: boolean;
            readonly relrowsecurity: boolean;
          }>(sql`
            select
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              count(distinct policy.polname)::text as policy_count,
              max(index_relation.relname) filter (
                where index_relation.relname = ${'crm_customers_active_registration_uk'}
              ) as index_name
            from pg_catalog.pg_class as relation
            inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
            left join pg_catalog.pg_policy as policy on policy.polrelid = relation.oid
            left join pg_catalog.pg_index as index_entry on index_entry.indrelid = relation.oid
            left join pg_catalog.pg_class as index_relation on index_relation.oid = index_entry.indexrelid
            where namespace.nspname = ${CRM_SCHEMA_NAME} and relation.relname = ${'customers'}
            group by relation.relrowsecurity, relation.relforcerowsecurity
          `),
      });
      const [boundary] = customerBoundary.rows;
      if (
        boundary === undefined ||
        !boundary.relrowsecurity ||
        !boundary.relforcerowsecurity ||
        boundary.policy_count !== '4' ||
        boundary.index_name !== 'crm_customers_active_registration_uk'
      ) {
        return yield* new CrmDatabaseVerificationError({
          reason: 'CRM Customer table is missing forced tenant RLS, policies, or uniqueness',
        });
      }
      const contactBoundary = yield* Effect.tryPromise({
        catch: () =>
          new CrmDatabaseVerificationError({
            reason: 'Unable to inspect the CRM Contact RLS and constraint boundary',
          }),
        try: () =>
          database.executor.execute<{
            readonly check_count: string;
            readonly foreign_key_name: null | string;
            readonly index_name: null | string;
            readonly policy_count: string;
            readonly relforcerowsecurity: boolean;
            readonly relrowsecurity: boolean;
          }>(sql`
            select
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              count(distinct policy.polname)::text as policy_count,
              count(distinct constraint_entry.conname) filter (
                where constraint_entry.contype = ${'c'}
              )::text as check_count,
              max(constraint_entry.conname) filter (
                where constraint_entry.conname = ${'crm_contacts_customer_fk'}
              ) as foreign_key_name,
              max(index_relation.relname) filter (
                where index_relation.relname = ${'crm_contacts_active_customer_name_id_idx'}
              ) as index_name
            from pg_catalog.pg_class as relation
            inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
            left join pg_catalog.pg_policy as policy on policy.polrelid = relation.oid
            left join pg_catalog.pg_constraint as constraint_entry
              on constraint_entry.conrelid = relation.oid
            left join pg_catalog.pg_index as index_entry on index_entry.indrelid = relation.oid
            left join pg_catalog.pg_class as index_relation on index_relation.oid = index_entry.indexrelid
            where namespace.nspname = ${CRM_SCHEMA_NAME} and relation.relname = ${'contacts'}
            group by relation.relrowsecurity, relation.relforcerowsecurity
          `),
      });
      const [contact] = contactBoundary.rows;
      if (
        contact === undefined ||
        !contact.relrowsecurity ||
        !contact.relforcerowsecurity ||
        contact.policy_count !== '4' ||
        contact.check_count !== '2' ||
        contact.foreign_key_name !== 'crm_contacts_customer_fk' ||
        contact.index_name !== 'crm_contacts_active_customer_name_id_idx'
      ) {
        return yield* new CrmDatabaseVerificationError({
          reason:
            'CRM Contact table is missing forced tenant RLS, parent FK, checks, or pagination index',
        });
      }
      const dealBoundary = yield* Effect.tryPromise({
        catch: () =>
          new CrmDatabaseVerificationError({
            reason: 'Unable to inspect the CRM Deal RLS and constraint boundary',
          }),
        try: () =>
          database.executor.execute<{
            readonly check_count: string;
            readonly contact_foreign_key_name: null | string;
            readonly currency_codes: null | string;
            readonly customer_foreign_key_name: null | string;
            readonly policy_count: string;
            readonly relforcerowsecurity: boolean;
            readonly relrowsecurity: boolean;
            readonly scope_index_name: null | string;
          }>(sql`
            select
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              count(distinct policy.polname)::text as policy_count,
              count(distinct constraint_entry.conname) filter (
                where constraint_entry.contype = ${'c'}
              )::text as check_count,
              max(constraint_entry.conname) filter (
                where constraint_entry.conname = ${'crm_deals_customer_fk'}
              ) as customer_foreign_key_name,
              max(constraint_entry.conname) filter (
                where constraint_entry.conname = ${'crm_deals_contact_fk'}
              ) as contact_foreign_key_name,
              max(index_relation.relname) filter (
                where index_relation.relname = ${'crm_deals_active_scope_updated_id_idx'}
              ) as scope_index_name,
              (
                select string_agg(enum_entry.enumlabel, ${','} order by enum_entry.enumsortorder)
                from pg_catalog.pg_type as enum_type
                inner join pg_catalog.pg_namespace as enum_namespace
                  on enum_namespace.oid = enum_type.typnamespace
                inner join pg_catalog.pg_enum as enum_entry on enum_entry.enumtypid = enum_type.oid
                where enum_namespace.nspname = ${CRM_SCHEMA_NAME}
                  and enum_type.typname = ${'deal_currency_code'}
              ) as currency_codes
            from pg_catalog.pg_class as relation
            inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
            left join pg_catalog.pg_policy as policy on policy.polrelid = relation.oid
            left join pg_catalog.pg_constraint as constraint_entry
              on constraint_entry.conrelid = relation.oid
            left join pg_catalog.pg_index as index_entry on index_entry.indrelid = relation.oid
            left join pg_catalog.pg_class as index_relation on index_relation.oid = index_entry.indexrelid
            where namespace.nspname = ${CRM_SCHEMA_NAME} and relation.relname = ${'deals'}
            group by relation.relrowsecurity, relation.relforcerowsecurity
          `),
      });
      const [deal] = dealBoundary.rows;
      if (
        deal === undefined ||
        !deal.relrowsecurity ||
        !deal.relforcerowsecurity ||
        deal.policy_count !== '4' ||
        deal.check_count !== '6' ||
        deal.currency_codes !== DEAL_CURRENCY_CODES.join(',') ||
        deal.customer_foreign_key_name !== 'crm_deals_customer_fk' ||
        deal.contact_foreign_key_name !== 'crm_deals_contact_fk' ||
        deal.scope_index_name !== 'crm_deals_active_scope_updated_id_idx'
      ) {
        return yield* new CrmDatabaseVerificationError({
          reason:
            'CRM Deal table is missing forced tenant/Legal Entity RLS, scope FKs, checks, or pagination index',
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
