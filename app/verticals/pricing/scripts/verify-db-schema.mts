// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- Operator-only database verification adapts the PostgreSQL driver at the infrastructure edge; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import {
  PRICING_RUNTIME_ROUTINE_SIGNATURES,
  PRICING_RUNTIME_TABLE_GRANTS,
} from '../../../scripts/postgres/runtime-role-grants.mts';
import { PRICING_SCHEMA_NAME, PRICING_TABLE_INVENTORY } from '../src/database/schema.ts';

class PricingSchemaVerificationError extends Schema.TaggedError<PricingSchemaVerificationError>()(
  'PricingSchemaVerificationError',
  { reason: Schema.String },
) {}

interface InfrastructureRow {
  readonly acknowledgement_issuer_column_count: number;
  readonly acknowledgement_principal_binding_count: number;
  readonly action_receipt_principal_column_count: number;
  readonly action_receipt_principal_constraint_count: number;
  readonly append_only_policy_count: number;
  readonly canonical_support_exclusion_count: number;
  readonly canonical_support_legal_entity_column_count: number;
  readonly canonical_support_policy_count: number;
  readonly canonical_support_routine_count: number;
  readonly canonical_support_table_count: number;
  readonly compatibility_policy_count: number;
  readonly compatibility_role_count: number;
  readonly compatibility_role_privilege_count: number;
  readonly compatibility_role_table_grant_count: number;
  readonly compatibility_trigger_count: number;
  readonly confirmation_constraint_count: number;
  readonly confirmation_policy_count: number;
  readonly confirmation_routine_count: number;
  readonly confirmation_routine_public_execute_count: number;
  readonly currency_support_proof_facts_column_count: number;
  readonly currency_support_proof_facts_constraint_count: number;
  readonly fee_exclusion_count: number;
  readonly fee_lineage_fk_count: number;
  readonly fee_policy_count: number;
  readonly fee_routine_count: number;
  readonly fee_routine_public_execute_count: number;
  readonly fee_table_count: number;
  readonly forced_rls_count: number;
  readonly gateway_expiry_index_count: number;
  readonly gateway_identity_unique_count: number;
  readonly gateway_public_privilege_count: number;
  readonly gateway_rls_enabled_count: number;
  readonly gateway_runtime_privilege_count: number;
  readonly gateway_scope_column_count: number;
  readonly journal_count: number;
  readonly legacy_runtime_privilege_count: number;
  readonly policy_count: number;
  readonly price_exclusion_count: number;
  readonly price_function_count: number;
  readonly price_function_public_execute_count: number;
  readonly price_invocation_receipt_policy_count: number;
  readonly price_provenance_lineage_fk_count: number;
  readonly price_provenance_policy_count: number;
  readonly price_provenance_revision_binding_count: number;
  readonly price_provenance_routine_count: number;
  readonly protected_helper_count: number;
  readonly quantity_tier_exclusion_count: number;
  readonly quantity_tier_lineage_fk_count: number;
  readonly quantity_tier_policy_count: number;
  readonly quantity_tier_price_basis_fk_count: number;
  readonly quantity_tier_routine_count: number;
  readonly quantity_tier_routine_public_execute_count: number;
  readonly quantity_tier_table_count: number;
  readonly routine_count: number;
  readonly routine_public_execute_count: number;
  readonly runtime_compatibility_membership_count: number;
  readonly runtime_delete_count: number;
  readonly runtime_exact_table_privilege_count: number;
  readonly runtime_governed_zero_mutation_count: number;
  readonly runtime_insert_count: number;
  readonly runtime_price_helper_count: number;
  readonly runtime_role_rls_safety_count: number;
  readonly runtime_routine_count: number;
  readonly runtime_schema_create: boolean;
  readonly runtime_schema_usage: boolean;
  readonly runtime_select_count: number;
  readonly runtime_support_helper_count: number;
  readonly runtime_unplanned_routine_count: number;
  readonly runtime_update_count: number;
  readonly unsafe_runtime_table_privilege_count: number;
}

const pricingTableInventoryMatches = (actualTables: readonly string[], expectedTables: readonly string[]) =>
  actualTables.length === expectedTables.length &&
  actualTables.every((table, index) => table === expectedTables[index]);

const runtimeDeleteTables = PRICING_RUNTIME_TABLE_GRANTS.filter(({ privileges }) =>
  privileges.some((privilege) => privilege === 'delete'),
).map(({ table }) => table);
const runtimeInsertTables = PRICING_RUNTIME_TABLE_GRANTS.filter(({ privileges }) =>
  privileges.some((privilege) => privilege === 'insert'),
).map(({ table }) => table);
const runtimeSelectTables = PRICING_RUNTIME_TABLE_GRANTS.filter(({ privileges }) =>
  privileges.some((privilege) => privilege === 'select'),
).map(({ table }) => table);
const runtimeUpdateTables = PRICING_RUNTIME_TABLE_GRANTS.filter(({ privileges }) =>
  privileges.some((privilege) => privilege === 'update'),
).map(({ table }) => table);
const governedRuntimeTables = PRICING_RUNTIME_TABLE_GRANTS.filter(({ privileges }) =>
  privileges.every((privilege) => privilege === 'select'),
).map(({ table }) => table);

const infrastructureMatchesExpectedContract = (row: InfrastructureRow | undefined) => {
  if (row === undefined) {
    return false;
  }
  return [
    row.action_receipt_principal_column_count === 2,
    row.action_receipt_principal_constraint_count === 2,
    row.acknowledgement_issuer_column_count === 1,
    row.acknowledgement_principal_binding_count === 1,
    row.append_only_policy_count === 58,
    row.canonical_support_exclusion_count === 1,
    row.canonical_support_legal_entity_column_count === 0,
    row.canonical_support_policy_count === 20,
    row.canonical_support_routine_count === 2,
    row.canonical_support_table_count === 5,
    row.compatibility_policy_count === 4,
    row.compatibility_role_count === 1,
    row.compatibility_role_privilege_count === 1,
    row.compatibility_role_table_grant_count === 7,
    row.compatibility_trigger_count === 1,
    row.confirmation_constraint_count === 6,
    row.confirmation_policy_count === 4,
    row.confirmation_routine_count === 2,
    row.confirmation_routine_public_execute_count === 0,
    row.currency_support_proof_facts_column_count === 1,
    row.currency_support_proof_facts_constraint_count === 1,
    row.forced_rls_count === PRICING_TABLE_INVENTORY.length - 1,
    row.fee_exclusion_count === 1,
    row.fee_lineage_fk_count === 2,
    row.fee_policy_count === 24,
    row.fee_routine_count === 6,
    row.fee_routine_public_execute_count === 0,
    row.fee_table_count === 10,
    row.gateway_expiry_index_count === 1,
    row.gateway_identity_unique_count === 1,
    row.gateway_public_privilege_count === 0,
    row.gateway_rls_enabled_count === 0,
    row.gateway_runtime_privilege_count === 3,
    row.gateway_scope_column_count === 0,
    row.journal_count === 1,
    row.legacy_runtime_privilege_count === 0,
    row.policy_count === 262,
    row.price_exclusion_count === 1,
    row.price_function_count === 5,
    row.price_function_public_execute_count === 0,
    row.price_invocation_receipt_policy_count === 4,
    row.price_provenance_lineage_fk_count === 2,
    row.price_provenance_policy_count === 8,
    row.price_provenance_revision_binding_count === 0,
    row.price_provenance_routine_count === 3,
    row.protected_helper_count === 15,
    row.quantity_tier_exclusion_count === 1,
    row.quantity_tier_lineage_fk_count === 2,
    row.quantity_tier_policy_count === 22,
    row.quantity_tier_price_basis_fk_count === 1,
    row.quantity_tier_routine_count === 5,
    row.quantity_tier_routine_public_execute_count === 0,
    row.quantity_tier_table_count === 9,
    row.routine_count === 133,
    row.runtime_compatibility_membership_count === 0,
    row.runtime_support_helper_count === 2,
    row.routine_public_execute_count === 0,
    row.runtime_delete_count === runtimeDeleteTables.length,
    row.runtime_exact_table_privilege_count === PRICING_TABLE_INVENTORY.length,
    row.runtime_governed_zero_mutation_count === governedRuntimeTables.length,
    row.runtime_insert_count === runtimeInsertTables.length,
    row.runtime_routine_count === PRICING_RUNTIME_ROUTINE_SIGNATURES.length,
    row.runtime_unplanned_routine_count === 0,
    row.runtime_price_helper_count === 4,
    row.runtime_role_rls_safety_count === 1,
    row.runtime_schema_usage,
    !row.runtime_schema_create,
    row.runtime_select_count === runtimeSelectTables.length,
    row.runtime_update_count === runtimeUpdateTables.length,
    row.unsafe_runtime_table_privilege_count === 0,
  ].every(Boolean);
};

const verification = Effect.gen(function* verifyPricingDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.makeClient({ url: Redacted.make(configuration.admin.connectionString) }).pipe(
    Effect.mapError(() => new PricingSchemaVerificationError({ reason: 'Unable to connect to the Pricing database' })),
  );
  const tables = yield* client
    .unsafe<{ readonly table_name: string }>(
      `select table_name
           from information_schema.tables
          where table_schema = $1 and table_type = 'BASE TABLE'
          order by table_name`,
      [PRICING_SCHEMA_NAME],
    )
    .pipe(Effect.mapError(() => new PricingSchemaVerificationError({ reason: 'Unable to inspect Pricing tables' })));
  const actualTables = EffectArray.sort(
    tables.map(({ table_name }) => table_name),
    Order.String,
  );
  const expectedTables = EffectArray.sort([...PRICING_TABLE_INVENTORY], Order.String);
  if (!pricingTableInventoryMatches(actualTables, expectedTables)) {
    return yield* new PricingSchemaVerificationError({ reason: 'Pricing table inventory mismatch' });
  }

  const canonicalSupportTables = [
    'currency_support_roots',
    'currency_support_schedule_entries',
    'currency_support_schedule_heads',
    'currency_support_schedule_revisions',
    'currency_support_value_revisions',
  ] as const;
  const runtimeRoutineSignatures = PRICING_RUNTIME_ROUTINE_SIGNATURES.map((signature) =>
    signature.replaceAll('timestamp with time zone', 'timestamptz').replaceAll(/\s+/gu, '').toLowerCase(),
  );
  const infrastructure = yield* client
    .unsafe<InfrastructureRow>(
      `select
           (select count(*)::integer
              from information_schema.columns
             where table_schema = $1 and column_name = 'acting_principal_id' and is_nullable = 'YES'
               and (
                 (table_name = 'contractual_discount_action_invocation_receipts' and data_type = 'uuid')
                 or (table_name = 'zero_floor_action_invocation_receipts' and data_type = 'text')
               )) as action_receipt_principal_column_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and constraint_record.contype = 'c'
               and not constraint_record.convalidated
               and (
                 (relation.relname = 'contractual_discount_action_invocation_receipts'
                   and constraint_record.conname = 'pricing_contractual_discount_receipts_principal_ck')
                 or (relation.relname = 'zero_floor_action_invocation_receipts'
                   and constraint_record.conname = 'pricing_zero_floor_action_receipts_principal_ck')
               )
               and pg_catalog.regexp_replace(
                 pg_catalog.lower(pg_catalog.pg_get_expr(constraint_record.conbin, constraint_record.conrelid)),
                 '[()[:space:]"]',
                 '',
                 'g'
               ) = 'acting_principal_idisnotnull') as action_receipt_principal_constraint_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relrowsecurity and relation.relforcerowsecurity) as forced_rls_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'gateway_assertion_redemptions'
               and relation.relkind = 'r' and relation.relrowsecurity) as gateway_rls_enabled_count,
           (select count(*)::integer
              from information_schema.columns
             where table_schema = $1 and table_name = 'gateway_assertion_redemptions'
               and column_name in ('tenant_id', 'legal_entity_id')) as gateway_scope_column_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'gateway_assertion_redemptions'
               and constraint_record.conname = 'pricing_gateway_assertion_redemptions_identity_uk'
               and constraint_record.contype = 'u') as gateway_identity_unique_count,
           (select count(*)::integer
              from pg_catalog.pg_indexes
             where schemaname = $1 and tablename = 'gateway_assertion_redemptions'
               and indexname = 'pricing_gateway_assertion_redemptions_expiry_idx') as gateway_expiry_index_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
              ) as privilege
             where namespace.nspname = $1 and relation.relname = 'gateway_assertion_redemptions'
               and privilege.grantee = 0) as gateway_public_privilege_count,
           (select
              (case when has_table_privilege('ontos_runtime', $1 || '.gateway_assertion_redemptions', 'SELECT') then 1 else 0 end)
              + (case when has_table_privilege('ontos_runtime', $1 || '.gateway_assertion_redemptions', 'INSERT') then 1 else 0 end)
              + (case when has_table_privilege('ontos_runtime', $1 || '.gateway_assertion_redemptions', 'UPDATE') then 1 else 0 end)
              + (case when has_table_privilege('ontos_runtime', $1 || '.gateway_assertion_redemptions', 'DELETE') then 1 else 0 end))::integer
             as gateway_runtime_privilege_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'pricing_commitment_confirmations'
               and constraint_record.conname in (
                 'pricing_commitment_confirmations_scope_ref_uk',
                 'pricing_commitment_confirmations_scope_proof_uk',
                 'pricing_commitment_confirmations_source_kind_ck',
                 'pricing_commitment_confirmations_source_reference_ck',
                 'pricing_commitment_confirmations_interval_ck',
                 'pricing_commitment_confirmations_payload_ck'
               ) and constraint_record.contype in ('u', 'c')) as confirmation_constraint_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'pricing_commitment_confirmations'
               and policy.polname in (
                 'pricing_commitment_confirmations_scope_select',
                 'pricing_commitment_confirmations_scope_insert',
                 'pricing_commitment_confirmations_scope_update',
                 'pricing_commitment_confirmations_scope_delete'
               ) and policy.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'ontos_runtime')]::oid[])
             as confirmation_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'persist_pricing_commitment_confirmation_v1',
                 'read_pricing_commitment_confirmation_v1'
               ) and not routine.prosecdef
               and routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE'))
             as confirmation_routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) as privilege
             where namespace.nspname = $1 and routine.proname like '%pricing_commitment_confirmation%'
               and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE')
             as confirmation_routine_public_execute_count,
           (select count(*)::integer
              from pg_catalog.pg_class as journal
              join pg_catalog.pg_namespace as namespace on namespace.oid = journal.relnamespace
             where namespace.nspname = 'drizzle'
               and journal.relname = '__drizzle_migrations_pricing') as journal_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1) as policy_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1
               and relation.relname in (
                 'price_invocation_receipts', 'price_revisions', 'price_schedule_acknowledgements',
                 'price_schedule_entries', 'price_schedule_revisions',
                 'price_source_assertion_deliveries', 'price_source_assertions', 'prices',
                 'external_price_source_authority_grants',
                 'price_candidate_set_roots', 'price_candidate_set_revisions'
                 , 'quantity_tier_revisions', 'quantity_tier_schedule_acknowledgements',
                 'quantity_tier_schedule_entries', 'quantity_tier_schedule_revisions', 'quantity_tiers',
                 'quantity_tier_set_roots', 'quantity_tier_set_revisions'
                 , 'fee_action_invocation_receipts', 'fee_revisions',
                 'fee_schedule_acknowledgements', 'fee_schedule_entries',
                 'fee_schedule_revisions', 'fees', 'fee_set_roots', 'fee_set_revisions',
                 'material_evidence_proof_receipts', 'currency_support_proof_receipts',
                 'currency_support_recovery_compensation_receipts'
               )
               and policy.polroles = case
                 when relation.relname in ('material_evidence_proof_receipts', 'currency_support_proof_receipts')
                   then array[0::oid]
                 when relation.relname = 'currency_support_recovery_compensation_receipts'
                   then array[
                     (select oid from pg_catalog.pg_roles where rolname = 'ontos_runtime'),
                     (select oid from pg_catalog.pg_roles where rolname = 'pricing_management_routine_writer')
                   ]::oid[]
                 else array[(select oid from pg_catalog.pg_roles where rolname = 'ontos_runtime')]::oid[]
               end
               and (
                 (policy.polcmd = 'w'
                  and policy.polname = case
                    when relation.relname = 'price_source_assertion_deliveries'
                      then 'pricing_price_source_deliveries_scope_update'
                    when relation.relname = 'material_evidence_proof_receipts'
                      then 'pricing_material_proof_receipts_scope_update'
                    when relation.relname = 'currency_support_proof_receipts'
                      then 'pricing_currency_support_proof_tenant_update'
                    when relation.relname = 'external_price_source_authority_grants'
                      then 'pricing_external_price_authority_scope_update'
                    when relation.relname = 'currency_support_recovery_compensation_receipts'
                      then 'pricing_currency_support_recovery_compensation_tenant_update'
                    else 'pricing_' || relation.relname || '_scope_update'
                  end
                  and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'false'
                  and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'false')
                 or
                 (policy.polcmd = 'd'
                  and policy.polname = case
                    when relation.relname = 'price_source_assertion_deliveries'
                      then 'pricing_price_source_deliveries_scope_delete'
                    when relation.relname = 'material_evidence_proof_receipts'
                      then 'pricing_material_proof_receipts_scope_delete'
                    when relation.relname = 'currency_support_proof_receipts'
                      then 'pricing_currency_support_proof_tenant_delete'
                    when relation.relname = 'external_price_source_authority_grants'
                      then 'pricing_external_price_authority_scope_delete'
                    when relation.relname = 'currency_support_recovery_compensation_receipts'
                      then 'pricing_currency_support_recovery_compensation_tenant_delete'
                    else 'pricing_' || relation.relname || '_scope_delete'
                  end
                  and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'false'
                  and policy.polwithcheck is null)
               )) as append_only_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'price_invocation_receipts'
               and policy.polname in (
                 'pricing_price_invocation_receipts_scope_select',
                 'pricing_price_invocation_receipts_scope_insert',
                 'pricing_price_invocation_receipts_scope_update',
                 'pricing_price_invocation_receipts_scope_delete'
               )) as price_invocation_receipt_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1
               and relation.relname in ('price_source_assertions', 'price_source_assertion_deliveries'))
             as price_provenance_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'price_source_assertions'
               and constraint_record.conname in (
                 'pricing_price_source_assertions_corrected_fk',
                 'pricing_price_source_assertions_superseded_fk'
               ) and constraint_record.contype = 'f') as price_provenance_lineage_fk_count,
           (select count(*)::integer
              from pricing.price_revisions as revision
             where not exists (
               select 1 from pricing.price_source_assertions as provenance
                where provenance.tenant_id = revision.tenant_id
                  and provenance.legal_entity_id = revision.legal_entity_id
                  and provenance.price_id = revision.price_id
                  and provenance.price_revision_id = revision.price_revision_id
             )) as price_provenance_revision_binding_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'bind_price_retirement_provenance_v1', 'bind_price_source_provenance_v1',
                 'define_price_v2', 'price_source_provenance_json_v1', 'revise_price_v2'
               ) and not routine.prosecdef
               and routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[])
             as price_provenance_routine_count,
           (select count(*)::integer
              from information_schema.columns
             where table_schema = $1 and table_name = 'price_schedule_acknowledgements'
               and column_name = 'issued_by_principal_id' and data_type = 'uuid' and is_nullable = 'NO')
             as acknowledgement_issuer_column_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1 and routine.proname = 'revise_price_v1'
               and routine.proargtypes = '2950 2950 3802'::oidvector
               and pg_catalog.strpos(pg_catalog.pg_get_functiondef(routine.oid), 'issued_by_principal_id') > 0
               and pg_catalog.strpos(pg_catalog.pg_get_functiondef(routine.oid), 'v_acting_principal_id') > 0)
             as acknowledgement_principal_binding_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relname = any($2::text[])) as canonical_support_table_count,
           (select count(*)::integer
              from information_schema.columns
             where table_schema = $1 and table_name = any($2::text[])
               and column_name = 'legal_entity_id') as canonical_support_legal_entity_column_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = any($2::text[])
               and policy.polroles @> array[(select oid from pg_catalog.pg_roles where rolname = 'ontos_runtime')]::oid[]
               and coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') not like '%legal_entity_id%'
               and coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') not like '%legal_entity_id%')
             as canonical_support_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'currency_support_schedule_entries'
               and constraint_record.conname = 'pricing_currency_support_entries_no_overlap'
               and constraint_record.contype = 'x') as canonical_support_exclusion_count,
           (select count(*)::integer
              from information_schema.columns
             where table_schema = $1 and table_name = 'currency_support_proof_receipts'
               and column_name = 'fact_proofs' and data_type = 'jsonb' and is_nullable = 'NO')
             as currency_support_proof_facts_column_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'currency_support_proof_receipts'
               and constraint_record.conname = 'pricing_currency_support_proof_facts_ck'
               and constraint_record.contype = 'c'
               and pg_catalog.regexp_replace(
                 pg_catalog.lower(pg_catalog.pg_get_expr(constraint_record.conbin, constraint_record.conrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
               ) = 'jsonb_typeoffact_proofs=''array''::textandjsonb_array_lengthfact_proofs=1')
             as currency_support_proof_facts_constraint_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'price_schedule_entries'
               and constraint_record.conname = 'pricing_price_schedule_entries_no_overlap'
               and constraint_record.contype = 'x') as price_exclusion_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relname in (
               'fees', 'fee_action_invocation_receipts', 'fee_revisions',
               'fee_schedule_revisions', 'fee_schedule_entries',
                 'fee_schedule_acknowledgements', 'fee_schedule_heads',
                 'fee_set_roots', 'fee_set_revisions', 'fee_set_heads'
               )) as fee_table_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname in (
               'fees', 'fee_action_invocation_receipts', 'fee_revisions',
               'fee_schedule_revisions', 'fee_schedule_entries',
               'fee_schedule_acknowledgements', 'fee_schedule_heads',
               'fee_set_roots', 'fee_set_revisions', 'fee_set_heads'
             ) and policy.polroles @> array[(select oid from pg_catalog.pg_roles where rolname = 'ontos_runtime')]::oid[]
               and (
                 coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') like '%ontos.tenant_id%'
                 or coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') like '%ontos.tenant_id%'
               ) and (
                 coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') like '%ontos.legal_entity_id%'
                 or coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') like '%ontos.legal_entity_id%'
               )) as fee_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'fee_schedule_entries'
               and constraint_record.conname = 'pricing_fee_schedule_entries_no_overlap'
               and constraint_record.contype = 'x') as fee_exclusion_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'fee_revisions'
               and constraint_record.conname in (
                 'pricing_fee_revisions_previous_fk',
                 'pricing_fee_revisions_corrected_fk'
               ) and constraint_record.contype = 'f') as fee_lineage_fk_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1 and routine.proname in (
               'define_commercial_fee_v1', 'fee_id_for_identity_v1', 'fee_identity_json_v1',
               'manage_commercial_fee_revision_v1',
               'read_commercial_fee_schedule_v1', 'read_current_commercial_fee_v1',
               'read_current_commercial_fee_set_v1', 'verify_commercial_fee_set_generation_v1',
               'revise_commercial_fee_v1', 'scheduled_fee_revision_json_v1'
             ) and not routine.prosecdef
               and routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE'))
             as fee_routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) as privilege
             where namespace.nspname = $1
               and (routine.proname like '%commercial_fee%' or routine.proname like '%fee_%')
               and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE')
             as fee_routine_public_execute_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relname in (
                 'quantity_tiers', 'quantity_tier_revisions',
                 'quantity_tier_schedule_revisions', 'quantity_tier_schedule_entries',
                 'quantity_tier_schedule_acknowledgements', 'quantity_tier_schedule_heads',
                 'quantity_tier_set_roots', 'quantity_tier_set_revisions', 'quantity_tier_set_heads'
               )) as quantity_tier_table_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname in (
               'quantity_tiers', 'quantity_tier_revisions',
               'quantity_tier_schedule_revisions', 'quantity_tier_schedule_entries',
               'quantity_tier_schedule_acknowledgements', 'quantity_tier_schedule_heads',
               'quantity_tier_set_roots', 'quantity_tier_set_revisions', 'quantity_tier_set_heads'
             ) and policy.polroles @> array[(select oid from pg_catalog.pg_roles where rolname = 'ontos_runtime')]::oid[]
               and (
                 coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') like '%ontos.tenant_id%'
                 or coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') like '%ontos.tenant_id%'
               ) and (
                 coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') like '%ontos.legal_entity_id%'
                 or coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') like '%ontos.legal_entity_id%'
               ))
             as quantity_tier_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'quantity_tier_schedule_entries'
               and constraint_record.conname = 'pricing_quantity_tier_schedule_entries_no_overlap'
               and constraint_record.contype = 'x') as quantity_tier_exclusion_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'quantity_tier_revisions'
               and constraint_record.conname in (
                 'pricing_quantity_tier_revisions_previous_fk',
                 'pricing_quantity_tier_revisions_corrected_fk'
               ) and constraint_record.contype = 'f') as quantity_tier_lineage_fk_count,
           (select count(*)::integer
              from pg_catalog.pg_constraint as constraint_record
              join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relname = 'quantity_tiers'
               and constraint_record.conname = 'pricing_quantity_tiers_price_basis_fk'
               and constraint_record.contype = 'f') as quantity_tier_price_basis_fk_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1 and routine.proname in (
               'define_quantity_tier_v1', 'quantity_tier_id_for_identity_v1',
               'quantity_tier_identity_json_v1', 'read_current_quantity_tier_v1',
               'read_quantity_tier_schedule_v1', 'revise_quantity_tier_v1',
               'scheduled_quantity_tier_revision_json_v1',
               'read_current_quantity_tier_set_v1', 'verify_quantity_tier_set_generation_v1'
             ) and not routine.prosecdef
               and routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE'))
             as quantity_tier_routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) as privilege
             where namespace.nspname = $1 and routine.proname like '%quantity_tier%'
               and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE')
             as quantity_tier_routine_public_execute_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1 and not routine.prosecdef
               and (
                 (routine.proname = 'read_tenant_currency_support_v1'
                  and routine.proargtypes = '2950 3802'::oidvector and routine.provolatile = 's')
                 or
                 (routine.proname = 'revalidate_tenant_currency_support_v1'
                  and routine.proargtypes = '2950'::oidvector and routine.provolatile = 's')
                 or
                 (routine.proname = 'set_tenant_currency_support_v1'
                  and routine.proargtypes = '2950 3802'::oidvector and routine.provolatile = 'v')
               )
               and routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE'))
             as canonical_support_routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'currency_support_schedule_acknowledgement_v1',
                 'currency_support_scheduled_revision_json_v1'
               )
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
               and not exists (
                 select 1
                   from pg_catalog.aclexplode(
                     coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
                   ) as privilege
                  where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
               )) as runtime_support_helper_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'define_price_v1', 'define_price_v2', 'lookup_exact_current_price_v1',
                 'lookup_exact_current_price_v2',
                 'read_current_price_definition_v1',
                 'read_price_schedule_v1', 'revise_price_v1', 'revise_price_v2',
                 'read_exact_price_candidate_set_v1', 'verify_exact_price_candidate_set_generation_v1'
               )
               and not routine.prosecdef
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as price_function_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) as privilege
             where namespace.nspname = $1
               and routine.proname in (
                 'define_price_v1', 'define_price_v2', 'lookup_exact_current_price_v1',
                 'lookup_exact_current_price_v2',
                 'read_current_price_definition_v1',
                 'read_price_schedule_v1', 'revise_price_v1', 'revise_price_v2',
                 'read_exact_price_candidate_set_v1', 'verify_exact_price_candidate_set_generation_v1'
               )
               and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE')
             as price_function_public_execute_count,
           (select count(*)::integer
              from pg_catalog.pg_roles as projection_role
             where projection_role.rolname = 'pricing_schedule_projection_writer'
               and not projection_role.rolcanlogin and not projection_role.rolsuper
               and not projection_role.rolcreatedb and not projection_role.rolcreaterole
               and not projection_role.rolinherit and not projection_role.rolbypassrls) as compatibility_role_count,
           (select count(*)::integer
              from pg_catalog.pg_roles as projection_role
             where projection_role.rolname = 'pricing_schedule_projection_writer'
               and has_schema_privilege(projection_role.rolname, $1, 'USAGE')
               and not has_schema_privilege(projection_role.rolname, $1, 'CREATE')
               and has_table_privilege(projection_role.rolname, $1 || '.price_schedule_heads', 'SELECT')
               and has_table_privilege(projection_role.rolname, $1 || '.price_schedule_entries', 'SELECT')
               and has_table_privilege(projection_role.rolname, $1 || '.price_revisions', 'SELECT')
               and has_table_privilege(projection_role.rolname, $1 || '.price_current_revisions', 'SELECT')
               and has_table_privilege(projection_role.rolname, $1 || '.price_current_revisions', 'INSERT')
               and has_table_privilege(projection_role.rolname, $1 || '.price_current_revisions', 'UPDATE')
               and has_table_privilege(projection_role.rolname, $1 || '.price_current_revisions', 'DELETE'))
             as compatibility_role_privilege_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
              ) as privilege
             where namespace.nspname = $1
               and privilege.grantee = (
                 select oid from pg_catalog.pg_roles where rolname = 'pricing_schedule_projection_writer'
               )) as compatibility_role_table_grant_count,
           (select case when pg_catalog.pg_has_role(
               'ontos_runtime', 'pricing_schedule_projection_writer', 'MEMBER'
             ) then 1 else 0 end)::integer as runtime_compatibility_membership_count,
           (select count(*)::integer
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1
               and policy.polroles = array[(
                 select oid from pg_catalog.pg_roles where rolname = 'pricing_schedule_projection_writer'
               )]::oid[]
               and policy.polname in (
                 'pricing_price_current_projection_writer',
                 'pricing_price_revisions_projection_select',
                 'pricing_price_schedule_entries_projection_select',
                 'pricing_price_schedule_heads_projection_select'
               )
               and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%ontos.tenant_id%'
               and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%ontos.legal_entity_id%'
               and (
                 (policy.polname = 'pricing_price_current_projection_writer'
                  and relation.relname = 'price_current_revisions' and policy.polcmd = '*'
                  and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) like '%ontos.tenant_id%'
                  and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) like '%ontos.legal_entity_id%')
                 or
                 (policy.polname = case relation.relname
                    when 'price_revisions' then 'pricing_price_revisions_projection_select'
                    when 'price_schedule_entries' then 'pricing_price_schedule_entries_projection_select'
                    when 'price_schedule_heads' then 'pricing_price_schedule_heads_projection_select'
                  end and policy.polcmd = 'r' and policy.polwithcheck is null)
               )) as compatibility_policy_count,
           (select count(*)::integer
              from pg_catalog.pg_trigger as trigger_record
              join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
              join pg_catalog.pg_proc as routine on routine.oid = trigger_record.tgfoid
              join pg_catalog.pg_roles as owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = $1 and relation.relname = 'price_schedule_heads'
               and trigger_record.tgname = 'pricing_price_schedule_head_refresh_current'
               and not trigger_record.tgisinternal and routine.proname = 'refresh_price_current_projection_v1'
               and routine.prosecdef and routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
               and owner_role.rolname = 'pricing_schedule_projection_writer'
               and not has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
               and not exists (
                 select 1 from pg_catalog.aclexplode(
                   coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
                 ) as privilege where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
               )) as compatibility_trigger_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1 and routine.proname in (
               'refresh_price_current_projection_v1',
               'read_exact_price_candidate_set_unobserved_v1',
               'read_current_commercial_fee_set_unobserved_v1',
                 'read_current_zero_floor_authorization_set_unreceipted_v1',
                 'read_current_quantity_tier_set_unreceipted_v1',
                 'read_current_contractual_discount_set_unproofed_v1',
                 'read_commercial_fee_schedule_revision_v1',
                 'advance_price_candidate_set_generation_v1',
                 'advance_fee_set_generation_v1',
                 'ensure_zero_floor_set_v1',
                 'advance_zero_floor_set_v1',
                 'advance_contractual_discount_set_v1',
                 'execute_price_fee_action_with_result_v1',
                 'execute_price_action_with_terminal_result_v1',
                 'bind_price_source_provenance_v1',
                 'bind_price_retirement_provenance_v1'
             )
               and not has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
               and not exists (
                 select 1 from pg_catalog.aclexplode(
                   coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
                 ) as privilege where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
               )) as protected_helper_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.proname in (
                 'bind_price_retirement_provenance_v1', 'bind_price_source_provenance_v1',
                 'price_schedule_acknowledgement_v1', 'price_source_provenance_json_v1',
                 'scheduled_price_revision_json_v1'
               )
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
               and not exists (
                 select 1 from pg_catalog.aclexplode(
                   coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
                 ) as privilege where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
               )) as runtime_price_helper_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1) as routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
              cross join lateral pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) as privilege
             where namespace.nspname = $1 and privilege.grantee = 0
               and privilege.privilege_type = 'EXECUTE') as routine_public_execute_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and routine.oid in (
                 select pg_catalog.to_regprocedure(signature)::oid
                   from unnest($3::text[]) as signature
               )
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as runtime_routine_count,
           (select count(*)::integer
              from pg_catalog.pg_proc as routine
              join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = $1
               and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')
               and routine.oid not in (
                 select pg_catalog.to_regprocedure(signature)::oid
                   from unnest($3::text[]) as signature
               )) as runtime_unplanned_routine_count,
           has_schema_privilege('ontos_runtime', $1, 'USAGE') as runtime_schema_usage,
           has_schema_privilege('ontos_runtime', $1, 'CREATE') as runtime_schema_create,
           (select count(*)::integer
              from pg_catalog.pg_roles as runtime_role
             where runtime_role.rolname = 'ontos_runtime'
               and not runtime_role.rolsuper
               and not runtime_role.rolbypassrls) as runtime_role_rls_safety_count,
           (select
              (case when has_table_privilege('ontos_runtime', $1 || '.currency_support_revisions', 'SELECT') then 1 else 0 end)
              + (case when has_table_privilege('ontos_runtime', $1 || '.currency_support_revisions', 'INSERT') then 1 else 0 end)
              + (case when has_table_privilege('ontos_runtime', $1 || '.currency_support_revisions', 'UPDATE') then 1 else 0 end)
              + (case when has_table_privilege('ontos_runtime', $1 || '.currency_support_revisions', 'DELETE') then 1 else 0 end))::integer
             as legacy_runtime_privilege_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and has_table_privilege('ontos_runtime', relation.oid, 'SELECT')) as runtime_select_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and has_table_privilege('ontos_runtime', relation.oid, 'INSERT')) as runtime_insert_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')) as runtime_update_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and has_table_privilege('ontos_runtime', relation.oid, 'DELETE')) as runtime_delete_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and has_table_privilege('ontos_runtime', relation.oid,
                 'TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, SELECT WITH GRANT OPTION, INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION'))
             as unsafe_runtime_table_privilege_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and relation.relname = any($8::text[])
               and has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
               and not has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
               and not has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')
               and not has_table_privilege('ontos_runtime', relation.oid, 'DELETE')
               and not has_table_privilege('ontos_runtime', relation.oid, 'TRUNCATE'))
             as runtime_governed_zero_mutation_count,
           (select count(*)::integer
              from pg_catalog.pg_class as relation
              join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = $1 and relation.relkind in ('r', 'p')
               and not has_table_privilege('ontos_runtime', relation.oid, 'TRUNCATE')
               and has_table_privilege('ontos_runtime', relation.oid, 'SELECT') =
                 (relation.relname = any($4::text[]))
               and has_table_privilege('ontos_runtime', relation.oid, 'INSERT') =
                 (relation.relname = any($5::text[]))
               and has_table_privilege('ontos_runtime', relation.oid, 'UPDATE') =
                 (relation.relname = any($6::text[]))
               and has_table_privilege('ontos_runtime', relation.oid, 'DELETE') =
                 (relation.relname = any($7::text[]))) as runtime_exact_table_privilege_count`,
      [
        PRICING_SCHEMA_NAME,
        canonicalSupportTables,
        runtimeRoutineSignatures,
        runtimeSelectTables,
        runtimeInsertTables,
        runtimeUpdateTables,
        runtimeDeleteTables,
        governedRuntimeTables,
      ],
    )
    .pipe(
      Effect.mapError(
        () => new PricingSchemaVerificationError({ reason: 'Unable to inspect Pricing database infrastructure' }),
      ),
    );
  const [row] = infrastructure;
  if (!infrastructureMatchesExpectedContract(row)) {
    return yield* new PricingSchemaVerificationError({
      reason: 'Pricing RLS, policy, journal, or routine inventory mismatch',
    });
  }
  return { tableCount: actualTables.length };
});

await Effect.runPromise(
  Effect.scoped(verification).pipe(
    Effect.provide(Reactivity.layer),
    Effect.tap(({ tableCount }) =>
      Console.log(`Verified ${tableCount} tables in PostgreSQL schema ${PRICING_SCHEMA_NAME}`),
    ),
  ),
);
