// @effect-diagnostics asyncFunction:off globalConsole:off nodeBuiltinImport:off -- The operator-only pg verifier adapts the driver's Promise API through Effect.tryPromise; expires: 2027-03-01.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { Client } from 'pg';

import { compareCommerceCustomerContextCatalog } from '../src/database/catalog.ts';
import {
  COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME,
  COMMERCE_CUSTOMER_CONTEXT_TABLES,
} from '../src/database/schema.ts';

class CommerceCustomerContextSchemaVerificationError extends Schema.TaggedError<CommerceCustomerContextSchemaVerificationError>()(
  'CommerceCustomerContextSchemaVerificationError',
  { reason: Schema.String },
) {}

interface VerificationRow {
  readonly append_only_trigger_count: number;
  readonly exclusion_count: number;
  readonly forced_rls_count: number;
  readonly group_description_column_count: number;
  readonly group_description_constraint_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly raw_runtime_privilege_count: number;
  readonly routine_count: number;
  readonly runtime_bypass_rls: boolean;
  readonly runtime_create: boolean;
  readonly runtime_routines: readonly string[];
  readonly runtime_super: boolean;
  readonly runtime_usage: boolean;
  readonly trigger_count: number;
  readonly trigger_names: readonly string[];
  readonly unsafe_routine_count: number;
  readonly unsafe_routines: readonly string[];
}

const EXPECTED_RUNTIME_ROUTINES = [
  'add_saved_address',
  'archive_customer_group',
  'assess_payment_term_entitlement_use',
  'assign_customer_group_membership',
  'assign_price_group',
  'begin_access_grant',
  'begin_access_revoke',
  'change_address_default',
  'change_purchase_limit_policy',
  'consume_invitation_claim_proof',
  'consume_purchase_approval',
  'create_access_invitation',
  'create_approval_hierarchy',
  'create_customer_group',
  'create_purchase_proposal_revision',
  'decide_purchase_approval_request',
  'ensure_counterparty_profile',
  'ensure_retail_profile',
  'finalize_reconciled_access_invitation',
  'finalize_retail_portal_binding_authorization',
  'finalize_retail_portal_profile_binding_permission_mutation',
  'inspect_price_group_profile',
  'list_access_grants',
  'list_access_reconciliation',
  'list_saved_addresses',
  'lock_access_grant_authority',
  'migrate_price_group_assignments',
  'mutate_access_invitation',
  'mutate_retail_portal_binding',
  'observe_party_merge_reconciliation',
  'open_profile_reconciliation',
  'persist_customer_payment_terms',
  'reactivate_customer_group',
  'read_access_invitation',
  'read_access_invitation_claim_reconciliation',
  'read_access_reconciliation',
  'read_address_defaults',
  'read_current_purchase_approval_revalidation',
  'read_current_purchase_proposal_revision',
  'read_customer_group',
  'read_customer_group_history',
  'read_customer_group_members',
  'read_customer_payment_terms',
  'read_customer_profile',
  'read_effective_customer_group_memberships',
  'read_guest_attribution',
  'read_price_group_assignments',
  'read_profile_reconciliation',
  'read_profile_trading_gate',
  'read_purchase_limit_policies',
  'read_retail_portal_binding',
  'read_retail_portal_binding_authorization',
  'read_retail_portal_profile_binding_permission_mutation',
  'read_saved_address',
  'reconcile_profile_reconciliation_owner',
  'record_address_book_reconciliation_receipt',
  'record_guest_attribution',
  'record_profile_reconciliation_owner_outcome',
  'redeem_invitation_claim_secret',
  'register_invitation_claim_proof',
  'remove_customer_group_membership',
  'remove_price_group_assignment',
  'remove_saved_address',
  'revalidate_purchase_approval',
  'reroute_purchase_approval_request',
  'reserve_payment_term_retirement',
  'resolve_price_group_assignments',
  'resolve_profile_reconciliation',
  'resolve_retail_principal',
  'stage_access_invitation_claim_grants',
  'stage_invitation_claim_proof_delivery',
  'stage_retail_portal_profile_binding_permission_mutations',
  'submit_purchase_approval_request',
  'transition_access_grant',
  'transition_profile',
  'update_customer_group',
  'update_saved_address',
  'verify_address_book_reconciliation',
  'verify_invitation_claim_authority',
  'verify_payment_terms_reconciliation_owner',
] as const;

const PROFILE_RUNTIME_ROUTINES = [
  'ensure_counterparty_profile',
  'ensure_retail_profile',
  'finalize_reconciled_access_invitation',
  'finalize_retail_portal_binding_authorization',
  'finalize_retail_portal_profile_binding_permission_mutation',
  'mutate_access_invitation',
  'mutate_retail_portal_binding',
  'observe_party_merge_reconciliation',
  'open_profile_reconciliation',
  'read_access_invitation_claim_reconciliation',
  'read_customer_profile',
  'read_guest_attribution',
  'read_profile_reconciliation',
  'read_profile_trading_gate',
  'read_retail_portal_binding',
  'read_retail_portal_binding_authorization',
  'read_retail_portal_profile_binding_permission_mutation',
  'reconcile_profile_reconciliation_owner',
  'record_address_book_reconciliation_receipt',
  'record_guest_attribution',
  'record_profile_reconciliation_owner_outcome',
  'reserve_payment_term_retirement',
  'resolve_profile_reconciliation',
  'resolve_retail_principal',
  'stage_access_invitation_claim_grants',
  'stage_retail_portal_profile_binding_permission_mutations',
  'transition_profile',
  'verify_address_book_reconciliation',
  'verify_payment_terms_reconciliation_owner',
] as const;

const EXPECTED_TRIGGER_NAMES = [
  'ccc_access_invitations_claim_reset_marker',
  'ccc_access_journal_append_only',
  'ccc_address_reconciliation_receipts_append_only_trg',
  'ccc_group_revisions_append_only',
  'ccc_guest_attributions_append_only',
  'ccc_invitation_claim_proofs_lifecycle_trg',
  'ccc_party_merge_observations_append_only_trg',
  'ccc_portal_binding_history_append_only',
  'ccc_profile_aliases_append_only',
  'ccc_profile_history_append_only',
  'ccc_reconciliation_members_append_only',
  'ccc_reconciliation_owner_outcomes_append_only_trg',
  'customer_payment_term_entitlements_retirement_guard',
  'customer_payment_term_preferences_retirement_guard',
] as const;

const sameStrings = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const failure = (reason: string, cause?: unknown) => {
  const error = new CommerceCustomerContextSchemaVerificationError({ reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};

const verify = Effect.gen(function* verifyCommerceCustomerContextSchema() {
  const connections = yield* loadDatabaseConnectionPair();
  const client = new Client({ connectionString: connections.admin.connectionString });
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      catch: (cause) => failure('Unable to connect to PostgreSQL as the migration owner', cause),
      // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary; an async wrapper is rejected by Effect diagnostics.
      try: () => client.connect().then(() => client),
    }),
    (connected) =>
      Effect.gen(function* inspectCatalog() {
        const catalog = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to read the owner table catalog', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary; an async wrapper is rejected by Effect diagnostics.
          try: () =>
            connected.query<{ readonly table_name: string }>(
              `select relation.relname as table_name
               from pg_catalog.pg_class as relation
               join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
               where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               order by relation.relname`,
              [COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME],
            ),
        });
        const difference = compareCommerceCustomerContextCatalog(
          catalog.rows.map(
            ({ table_name }) => `${COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME}.${table_name}`,
          ),
        );
        if (difference.missing.length > 0 || difference.unexpected.length > 0) {
          return yield* failure(
            `Table catalog mismatch; missing=[${difference.missing.join(',')}], unexpected=[${difference.unexpected.join(',')}]`,
          );
        }

        const result = yield* Effect.tryPromise({
          catch: (cause) => failure('Unable to verify owner database infrastructure', cause),
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary; an async wrapper is rejected by Effect diagnostics.
          try: () =>
            connected.query<VerificationRow>(
              `select
                 (select count(*)::integer
                    from pg_catalog.pg_class as relation
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                     and relation.relrowsecurity and relation.relforcerowsecurity) as forced_rls_count,
                 (select count(*)::integer
                    from pg_catalog.pg_policy as policy
                    join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1) as policy_count,
                 (select count(*)::integer
                    from pg_catalog.pg_class as relation
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1 and relation.relkind in ('r', 'p')
                     and (has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
                       or has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
                       or has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')
                       or has_table_privilege('ontos_runtime', relation.oid, 'DELETE'))) as raw_runtime_privilege_count,
                 (select count(*)::integer
                    from pg_catalog.pg_constraint as constraint_record
                    join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1 and constraint_record.contype = 'x') as exclusion_count,
                 (select count(*)::integer
                    from information_schema.columns as column_record
                   where column_record.table_schema = $1
                     and column_record.table_name = 'customer_group_revisions'
                     and column_record.column_name = 'description'
                     and column_record.data_type = 'text'
                     and column_record.is_nullable = 'NO') as group_description_column_count,
                 (select count(*)::integer
                    from pg_catalog.pg_constraint as constraint_record
                    join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1
                     and relation.relname = 'customer_group_revisions'
                     and constraint_record.conname = 'ccc_group_revisions_description_ck'
                     and constraint_record.contype = 'c') as group_description_constraint_count,
                 (select count(*)::integer
                    from pg_catalog.pg_trigger as trigger_record
                    join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1 and not trigger_record.tgisinternal
                     and trigger_record.tgname in (
                       'ccc_access_journal_append_only',
                       'ccc_address_reconciliation_receipts_append_only_trg',
                       'ccc_group_revisions_append_only',
                       'ccc_guest_attributions_append_only',
                       'ccc_portal_binding_history_append_only',
                       'ccc_profile_aliases_append_only',
                       'ccc_profile_history_append_only',
                       'ccc_reconciliation_members_append_only',
                       'ccc_party_merge_observations_append_only_trg',
                       'ccc_reconciliation_owner_outcomes_append_only_trg'
                     )) as append_only_trigger_count,
                 (select count(*)::integer
                    from pg_catalog.pg_trigger as trigger_record
                    join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1 and not trigger_record.tgisinternal) as trigger_count,
                 (select coalesce(
                           array_agg(trigger_record.tgname::text order by trigger_record.tgname),
                           array[]::text[]
                         )
                    from pg_catalog.pg_trigger as trigger_record
                    join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
                    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
                   where namespace.nspname = $1 and not trigger_record.tgisinternal) as trigger_names,
                 (select count(*)::integer
                    from pg_catalog.pg_class as journal
                    join pg_catalog.pg_namespace as namespace on namespace.oid = journal.relnamespace
                   where namespace.nspname = 'drizzle'
                     and journal.relname = '__drizzle_migrations_commerce_customer_context') as journal_count,
                 (select count(*)::integer
                    from pg_catalog.pg_proc as routine
                    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
                   where namespace.nspname = $1
                     and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as routine_count,
                 (select coalesce(
                           array_agg(routine.proname::text order by routine.proname),
                           array[]::text[]
                         )
                    from pg_catalog.pg_proc as routine
                    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
                   where namespace.nspname = $1
                     and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as runtime_routines,
                 (select count(*)::integer
                    from pg_catalog.pg_proc as routine
                    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
                   where namespace.nspname = $1
                     and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
                     and (not routine.prosecdef
                       or (routine.proname::text = any($2::text[])
                         and not ('search_path=pg_catalog, commerce_customer_context, pg_temp' = any(coalesce(routine.proconfig, array[]::text[]))))
                       or (not (routine.proname::text = any($2::text[]))
                         and not ('search_path=pg_catalog, commerce_customer_context' = any(coalesce(routine.proconfig, array[]::text[])))))) as unsafe_routine_count,
                 (select coalesce(
                           array_agg(routine.proname::text order by routine.proname),
                           array[]::text[]
                         )
                    from pg_catalog.pg_proc as routine
                    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
                   where namespace.nspname = $1
                     and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
                     and (not routine.prosecdef
                       or (routine.proname::text = any($2::text[])
                         and not ('search_path=pg_catalog, commerce_customer_context, pg_temp' = any(coalesce(routine.proconfig, array[]::text[]))))
                       or (not (routine.proname::text = any($2::text[]))
                         and not ('search_path=pg_catalog, commerce_customer_context' = any(coalesce(routine.proconfig, array[]::text[])))))) as unsafe_routines,
                 has_schema_privilege('ontos_runtime', $1, 'USAGE') as runtime_usage,
                 has_schema_privilege('ontos_runtime', $1, 'CREATE') as runtime_create,
                 runtime.rolsuper as runtime_super,
                 runtime.rolbypassrls as runtime_bypass_rls
               from pg_catalog.pg_roles as runtime where runtime.rolname = 'ontos_runtime'`,
              [COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME, PROFILE_RUNTIME_ROUTINES],
            ),
        });
        const [row] = result.rows;
        if (row === undefined) {
          return yield* failure('Commerce Customer Context database infrastructure is absent');
        }
        const unsafeInfrastructure = [
          row.forced_rls_count !== COMMERCE_CUSTOMER_CONTEXT_TABLES.length,
          row.policy_count !== COMMERCE_CUSTOMER_CONTEXT_TABLES.length * 5,
          row.raw_runtime_privilege_count !== 0,
          row.exclusion_count !== 7,
          row.group_description_column_count !== 1,
          row.group_description_constraint_count !== 1,
          row.append_only_trigger_count !== 10,
          row.trigger_count !== EXPECTED_TRIGGER_NAMES.length,
          !sameStrings(row.trigger_names, EXPECTED_TRIGGER_NAMES),
          row.journal_count !== 1,
          row.routine_count !== EXPECTED_RUNTIME_ROUTINES.length,
          !sameStrings(row.runtime_routines, EXPECTED_RUNTIME_ROUTINES),
          row.unsafe_routine_count !== 0,
          !row.runtime_usage,
          row.runtime_create,
          row.runtime_super,
          row.runtime_bypass_rls,
        ].some(Boolean);
        if (unsafeInfrastructure) {
          const expectedRoutines = new Set<string>(EXPECTED_RUNTIME_ROUTINES);
          const actualRoutines = new Set(row.runtime_routines);
          const missingRoutines = EXPECTED_RUNTIME_ROUTINES.filter(
            (routine) => !actualRoutines.has(routine),
          );
          const unexpectedRoutines = row.runtime_routines.filter(
            (routine) => !expectedRoutines.has(routine),
          );
          const expectedTriggers = new Set<string>(EXPECTED_TRIGGER_NAMES);
          const actualTriggers = new Set(row.trigger_names);
          const missingTriggers = EXPECTED_TRIGGER_NAMES.filter(
            (trigger) => !actualTriggers.has(trigger),
          );
          const unexpectedTriggers = row.trigger_names.filter(
            (trigger) => !expectedTriggers.has(trigger),
          );
          return yield* failure(
            `Commerce Customer Context database infrastructure is unsafe; ` +
              `forcedRls=${row.forced_rls_count}/${COMMERCE_CUSTOMER_CONTEXT_TABLES.length}, ` +
              `policies=${row.policy_count}/${COMMERCE_CUSTOMER_CONTEXT_TABLES.length * 5}, ` +
              `rawRuntimePrivileges=${row.raw_runtime_privilege_count}, exclusions=${row.exclusion_count}/7, ` +
              `appendOnlyTriggers=${row.append_only_trigger_count}/10, ` +
              `triggers=${row.trigger_count}/${EXPECTED_TRIGGER_NAMES.length}, ` +
              `missingTriggers=[${missingTriggers.join(',')}], unexpectedTriggers=[${unexpectedTriggers.join(',')}], ` +
              `journal=${row.journal_count}/1, ` +
              `runtimeRoutines=${row.routine_count}/${EXPECTED_RUNTIME_ROUTINES.length}, ` +
              `missingRoutines=[${missingRoutines.join(',')}], unexpectedRoutines=[${unexpectedRoutines.join(',')}], ` +
              `unsafeRoutines=${row.unsafe_routine_count}[${row.unsafe_routines.join(',')}], runtimeUsage=${row.runtime_usage}, ` +
              `runtimeCreate=${row.runtime_create}, runtimeSuper=${row.runtime_super}, ` +
              `runtimeBypassRls=${row.runtime_bypass_rls}`,
          );
        }
        return row;
      }),
    () =>
      Effect.tryPromise({
        catch: (cause) => failure('Unable to close the PostgreSQL verifier connection', cause),
        // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary; an async wrapper is rejected by Effect diagnostics.
        try: () => client.end(),
      }),
  );
});

await Effect.runPromise(verify);
process.stdout.write(
  `Verified ${COMMERCE_CUSTOMER_CONTEXT_TABLES.length} governed tables in ${COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME}\n`,
);
