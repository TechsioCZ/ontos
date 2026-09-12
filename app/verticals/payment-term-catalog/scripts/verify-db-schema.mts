// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Operator verifier is an executable boundary; expires: 2026-12-31.
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';
import { comparePaymentTermCatalog } from '../src/database/catalog.ts';
import { PaymentTermCatalogDatabase, PaymentTermCatalogDatabaseLive } from '../src/database/client.ts';
import { PAYMENT_TERM_CATALOG_SCHEMA_NAME, PAYMENT_TERM_CATALOG_TABLES } from '../src/database/schema.ts';

class PaymentTermCatalogVerificationError extends Schema.TaggedError<PaymentTermCatalogVerificationError>()(
  'PaymentTermCatalogVerificationError',
  { reason: Schema.String },
) {}

interface TableCatalogRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}

interface ColumnCatalogRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly table_name: string;
}

interface InfrastructureRow extends Readonly<Record<string, boolean | number | string>> {
  readonly append_only_trigger_count: number;
  readonly force_rls_count: number;
  readonly foreign_key_count: number;
  readonly governed_routine_count: number;
  readonly identity_trigger_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly private_routine_executable: boolean;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly runtime_usage: boolean;
  readonly table_count: number;
  readonly unexpected_runtime_routine_count: number;
  readonly wrong_owner_count: number;
}

const expectedColumns = EffectArray.sort(
  PAYMENT_TERM_CATALOG_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);

const schemaInfrastructureIsValid = (infrastructure: InfrastructureRow): boolean =>
  infrastructure.table_count === 4 &&
  infrastructure.force_rls_count === 4 &&
  infrastructure.wrong_owner_count === 0 &&
  infrastructure.policy_count === 16 &&
  infrastructure.foreign_key_count === 4 &&
  infrastructure.append_only_trigger_count === 3 &&
  infrastructure.identity_trigger_count === 1 &&
  infrastructure.journal_count === 1 &&
  infrastructure.governed_routine_count === 8 &&
  infrastructure.unexpected_runtime_routine_count === 0;

const runtimePrivilegesAreValid = (infrastructure: InfrastructureRow): boolean =>
  !infrastructure.runtime_create &&
  infrastructure.runtime_usage &&
  !infrastructure.runtime_select &&
  !infrastructure.runtime_insert &&
  !infrastructure.runtime_update &&
  !infrastructure.runtime_delete &&
  !infrastructure.private_routine_executable &&
  !infrastructure.role_super &&
  !infrastructure.role_bypass_rls;

const verification = Effect.gen(function* verifyPaymentTermCatalogDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* PaymentTermCatalogDatabase;

  for (const table of PAYMENT_TERM_CATALOG_TABLES) {
    yield* database.executor
      .select()
      .from(table)
      .limit(0)
      .pipe(
        Effect.mapError(
          () =>
            new PaymentTermCatalogVerificationError({
              reason: 'Typed Payment Term Catalog table verification failed',
            }),
        ),
      );
  }

  const catalog = yield* database.executor
    .execute<TableCatalogRow>(
      sql`
        select relation.relname as table_name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PaymentTermCatalogVerificationError({
            reason: 'Unable to compare the PostgreSQL Payment Term Catalog',
          }),
      ),
    );
  const difference = comparePaymentTermCatalog(
    catalog.map((row) => `${PAYMENT_TERM_CATALOG_SCHEMA_NAME}.${row.table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new PaymentTermCatalogVerificationError({
      reason: `Payment Term Catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* database.executor
    .execute<ColumnCatalogRow>(
      sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
        order by table_name, column_name
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PaymentTermCatalogVerificationError({
            reason: 'Unable to compare Payment Term Catalog columns',
          }),
      ),
    );
  const actualColumns = EffectArray.sort(
    columns.map((row) => `${row.table_name}.${row.column_name}`),
    Order.String,
  );
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    return yield* new PaymentTermCatalogVerificationError({
      reason: `Payment Term Catalog column mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`,
    });
  }

  const [infrastructure] = yield* database.executor
    .execute<InfrastructureRow>(
      sql`
        select
          count(distinct relation.oid)::integer as table_count,
          count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count,
          count(distinct relation.oid) filter (where pg_catalog.pg_get_userbyid(relation.relowner) <> ${connections.admin.user})::integer as wrong_owner_count,
          (select count(*)::integer from pg_catalog.pg_policy as policy
            inner join pg_catalog.pg_class as governed on governed.oid = policy.polrelid
            inner join pg_catalog.pg_namespace as governed_namespace on governed_namespace.oid = governed.relnamespace
            where governed_namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}) as policy_count,
          (select count(*)::integer from pg_catalog.pg_constraint as constraint_record
            inner join pg_catalog.pg_class as constrained on constrained.oid = constraint_record.conrelid
            inner join pg_catalog.pg_namespace as constrained_namespace on constrained_namespace.oid = constrained.relnamespace
            where constrained_namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
              and constraint_record.contype = ${'f'}) as foreign_key_count,
          (select count(*)::integer from pg_catalog.pg_trigger as trigger_record
            inner join pg_catalog.pg_class as triggered on triggered.oid = trigger_record.tgrelid
            inner join pg_catalog.pg_namespace as triggered_namespace on triggered_namespace.oid = triggered.relnamespace
            where triggered_namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
              and trigger_record.tgname in (${'payment_term_revisions_append_only'}, ${'payment_term_lifecycle_events_append_only'}, ${'payment_term_aliases_append_only'})
              and not trigger_record.tgisinternal) as append_only_trigger_count,
          (select count(*)::integer from pg_catalog.pg_trigger as trigger_record
            inner join pg_catalog.pg_class as triggered on triggered.oid = trigger_record.tgrelid
            inner join pg_catalog.pg_namespace as triggered_namespace on triggered_namespace.oid = triggered.relnamespace
            where triggered_namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
              and trigger_record.tgname = ${'payment_terms_identity_immutable'}
              and not trigger_record.tgisinternal) as identity_trigger_count,
          (select count(*)::integer from pg_catalog.pg_class as journal
            inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace
            where journal_namespace.nspname = ${'drizzle'}
              and journal.relname = ${'__drizzle_migrations_payment_term_catalog'}) as journal_count,
          (select count(*)::integer from pg_catalog.pg_proc as routine
            inner join pg_catalog.pg_namespace as routine_namespace on routine_namespace.oid = routine.pronamespace
            where routine_namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
              and routine.oid::regprocedure::text in (
                ${'payment_term_catalog.correct_term(uuid,uuid,jsonb)'},
                ${'payment_term_catalog.create_term(uuid,uuid,jsonb)'},
                ${'payment_term_catalog.get_current(uuid,uuid,uuid)'},
                ${'payment_term_catalog.get_history(uuid,uuid,uuid)'},
                ${'payment_term_catalog.list_current(uuid,uuid,integer,timestamp with time zone)'},
                ${'payment_term_catalog.reconcile_term(uuid,uuid,jsonb)'},
                ${'payment_term_catalog.resolve_reference(uuid,uuid,uuid,timestamp with time zone,text)'},
                ${'payment_term_catalog.retire_term(uuid,uuid,jsonb)'}
              )
              and routine.prosecdef
              and routine.proconfig @> array[${'search_path=pg_catalog, pg_temp'}]::text[]
              and has_function_privilege(${'ontos_runtime'}, routine.oid, ${'EXECUTE'})) as governed_routine_count,
          (select count(*)::integer from pg_catalog.pg_proc as routine
            inner join pg_catalog.pg_namespace as routine_namespace on routine_namespace.oid = routine.pronamespace
            where routine_namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
              and has_function_privilege(${'ontos_runtime'}, routine.oid, ${'EXECUTE'})
              and routine.oid::regprocedure::text not in (
                ${'payment_term_catalog.correct_term(uuid,uuid,jsonb)'},
                ${'payment_term_catalog.create_term(uuid,uuid,jsonb)'},
                ${'payment_term_catalog.get_current(uuid,uuid,uuid)'},
                ${'payment_term_catalog.get_history(uuid,uuid,uuid)'},
                ${'payment_term_catalog.list_current(uuid,uuid,integer,timestamp with time zone)'},
                ${'payment_term_catalog.reconcile_term(uuid,uuid,jsonb)'},
                ${'payment_term_catalog.resolve_reference(uuid,uuid,uuid,timestamp with time zone,text)'},
                ${'payment_term_catalog.retire_term(uuid,uuid,jsonb)'}
              )) as unexpected_runtime_routine_count,
          has_function_privilege(${'ontos_runtime'}, ${'payment_term_catalog.definition_json(uuid,uuid,uuid,integer)'}, ${'EXECUTE'})
            or has_function_privilege(${'ontos_runtime'}, ${'payment_term_catalog.assert_operation_scope(uuid,uuid)'}, ${'EXECUTE'}) as private_routine_executable,
          has_schema_privilege(${'ontos_runtime'}, ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
          has_schema_privilege(${'ontos_runtime'}, ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
          bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'SELECT'})) as runtime_select,
          bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'INSERT'})) as runtime_insert,
          bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'UPDATE'})) as runtime_update,
          bool_or(has_table_privilege(${'ontos_runtime'}, format('%I.%I', namespace.nspname, relation.relname), ${'DELETE'})) as runtime_delete,
          runtime_role.rolsuper as role_super,
          runtime_role.rolbypassrls as role_bypass_rls
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        cross join pg_catalog.pg_roles as runtime_role
        where namespace.nspname = ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
          and runtime_role.rolname = ${'ontos_runtime'}
        group by runtime_role.rolsuper, runtime_role.rolbypassrls
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new PaymentTermCatalogVerificationError({
            reason: 'Unable to verify Payment Term Catalog ownership, RLS, grants, or ledgers',
          }),
      ),
    );

  if (
    infrastructure === undefined ||
    !schemaInfrastructureIsValid(infrastructure) ||
    !runtimePrivilegesAreValid(infrastructure)
  ) {
    return yield* new PaymentTermCatalogVerificationError({
      reason:
        'Payment Term Catalog infrastructure violates its owner, forced-RLS, append-only, journal, or least-privilege contract',
    });
  }

  return { typedTableCount: PAYMENT_TERM_CATALOG_TABLES.length };
});

const runtime = PaymentTermCatalogDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin)))),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));
console.log(`Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${PAYMENT_TERM_CATALOG_SCHEMA_NAME}`);
