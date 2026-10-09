// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Operator verifier is an executable boundary; expires: 2027-03-31.
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';

import { compareInventoryCatalog } from '../src/database/catalog.ts';
import { InventoryDatabase, InventoryDatabaseLive } from '../src/database/client.ts';
import { INVENTORY_SCHEMA_NAME, INVENTORY_TABLES } from '../src/database/schema.ts';

class VerificationError extends Schema.TaggedError<VerificationError>()('InventoryVerificationError', {
  reason: Schema.String,
}) {}

interface TableRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}

interface ColumnRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly table_name: string;
}

interface InfrastructureRow extends Readonly<Record<string, boolean | number>> {
  readonly commitment_protection_trigger_count: number;
  readonly effect_ledger_contract_current: boolean;
  readonly force_rls_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly private_trigger_function_executable: boolean;
  readonly required_index_count: number;
  readonly required_trigger_count: number;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_delete_count: number;
  readonly runtime_insert_count: number;
  readonly runtime_select_count: number;
  readonly runtime_update_count: number;
  readonly runtime_usage: boolean;
  readonly table_count: number;
  readonly worker_routines_executable: boolean;
  readonly wrong_owner_count: number;
}

const expectedColumns = EffectArray.sort(
  INVENTORY_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);
const effectLedgerClaimSignature = 'inventory.claim_inventory_effect_ledger(uuid,uuid,text,jsonb)';
const effectLedgerExactScopeSignature = 'inventory.enforce_effect_ledger_exact_scope()';
const reservedProtectionKind = 'ESTABLISH_COMMITMENT_PROTECTION';
const unsupportedCorrectionKind = 'STOCK_CORRECTION';

// oxlint-disable-next-line complexity -- One operator report exact-matches the complete owner catalog and its security posture; expires: 2027-03-31.
const verification = Effect.gen(function* verifyDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* InventoryDatabase;
  for (const table of INVENTORY_TABLES) {
    yield* database.executor
      .select()
      .from(table)
      .limit(0)
      .pipe(Effect.mapError(() => new VerificationError({ reason: 'Typed Inventory table verification failed' })));
  }

  const catalog = yield* database.executor.execute<TableRow>(
    sql`select relation.relname as table_name from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${INVENTORY_SCHEMA_NAME} and relation.relkind in (${'r'}, ${'p'})
      order by relation.relname`,
    'objects',
  );
  const difference = compareInventoryCatalog(catalog.map(({ table_name }) => `${INVENTORY_SCHEMA_NAME}.${table_name}`));
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new VerificationError({
      reason: `Inventory mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* database.executor.execute<ColumnRow>(
    sql`select table_name, column_name from information_schema.columns
      where table_schema = ${INVENTORY_SCHEMA_NAME} order by table_name, column_name`,
    'objects',
  );
  const actualColumns = EffectArray.sort(
    columns.map(({ column_name, table_name }) => `${table_name}.${column_name}`),
    Order.String,
  );
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    return yield* new VerificationError({ reason: 'Inventory column inventory mismatch' });
  }

  const [infrastructure] = yield* database.executor.execute<InfrastructureRow>(
    sql`select
      count(distinct relation.oid)::integer as table_count,
      count(distinct relation.oid) filter (where relation.relrowsecurity and relation.relforcerowsecurity)::integer as force_rls_count,
      count(distinct relation.oid) filter (where pg_catalog.pg_get_userbyid(relation.relowner) <> ${connections.admin.user})::integer as wrong_owner_count,
      coalesce((select pg_catalog.pg_get_constraintdef(constraint_record.oid) like ${`%${reservedProtectionKind}%`} and pg_catalog.pg_get_constraintdef(constraint_record.oid) not like ${`%${unsupportedCorrectionKind}%`} from pg_catalog.pg_constraint constraint_record join pg_catalog.pg_class governed on governed.oid = constraint_record.conrelid join pg_catalog.pg_namespace ns on ns.oid = governed.relnamespace where ns.nspname = ${INVENTORY_SCHEMA_NAME} and governed.relname = ${'effect_ledger'} and constraint_record.conname = ${'inventory_effect_ledger_kind_ck'}), false)
        and pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(${effectLedgerExactScopeSignature})) like ${`%${reservedProtectionKind}%`}
        and pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(${effectLedgerExactScopeSignature})) not like ${`%${unsupportedCorrectionKind}%`}
        and pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(${effectLedgerClaimSignature})) like ${`%${reservedProtectionKind}%`}
        and pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(${effectLedgerClaimSignature})) not like ${`%${unsupportedCorrectionKind}%`} as effect_ledger_contract_current,
      (select count(*)::integer from pg_catalog.pg_policy policy join pg_catalog.pg_class governed on governed.oid = policy.polrelid join pg_catalog.pg_namespace ns on ns.oid = governed.relnamespace where ns.nspname = ${INVENTORY_SCHEMA_NAME}) as policy_count,
      (select count(*)::integer
        from pg_catalog.pg_index index_record
        join pg_catalog.pg_class index_relation on index_relation.oid = index_record.indexrelid
        join pg_catalog.pg_namespace index_namespace on index_namespace.oid = index_relation.relnamespace
        where index_namespace.nspname = ${INVENTORY_SCHEMA_NAME}
          and index_relation.relname = ${'inventory_obligations_runtime_accepted_order_uk'}
          and index_record.indisunique
          and pg_catalog.pg_get_indexdef(index_record.indexrelid) like ${'%(tenant_id, accepted_order_id)%'}
          and pg_catalog.pg_get_indexdef(index_record.indexrelid) like ${"%WHERE ((origin_kind = 'ORDER_COMMITMENT_ATTEMPT'::text) AND (lifecycle_meaning = 'COMMITTED_OBLIGATION'::text))%"}) as required_index_count,
      (select count(*)::integer from pg_catalog.pg_trigger trigger_record join pg_catalog.pg_class triggered on triggered.oid = trigger_record.tgrelid join pg_catalog.pg_namespace ns on ns.oid = triggered.relnamespace where ns.nspname = ${INVENTORY_SCHEMA_NAME} and trigger_record.tgname in (${'inventory_backend_configurations_explicit_cutover_trg'}, ${'inventory_catalog_to_stock_binding_history_no_delete_trg'}, ${'inventory_catalog_to_stock_binding_history_no_update_trg'}, ${'inventory_catalog_to_stock_bindings_compatibility_trg'}, ${'inventory_effect_ledger_exact_scope_trg'}, ${'inventory_effect_ledger_history_no_delete_trg'}, ${'inventory_effect_ledger_history_no_update_trg'}, ${'inventory_effect_ledger_history_scope_trg'}, ${'inventory_effect_ledger_transition_trg'}, ${'inventory_external_stock_correlations_immutable_identity_trg'}, ${'inventory_external_stock_correlations_no_delete_trg'}, ${'inventory_external_stock_correlations_nonoverlap_trg'}, ${'inventory_obligation_allocations_append_only_trg'}, ${'inventory_obligation_allocations_exact_coverage_trg'}, ${'inventory_obligation_allocations_exact_scope_trg'}, ${'inventory_obligation_requirements_append_only_trg'}, ${'inventory_obligation_requirements_exact_coverage_trg'}, ${'inventory_obligation_requirements_exact_scope_trg'}, ${'inventory_obligations_exact_authority_trg'}, ${'inventory_obligations_immutable_origin_trg'}, ${'inventory_physical_stock_effects_exact_scope_trg'}, ${'inventory_physical_stock_effects_immutable_identity_trg'}, ${'inventory_reservation_confirmation_history_no_delete_trg'}, ${'inventory_reservation_confirmation_history_no_update_trg'}, ${'inventory_reservation_confirmation_history_scope_trg'}, ${'inventory_reservation_confirmations_lifecycle_trg'}, ${'inventory_reservation_confirmations_scope_trg'}, ${'inventory_reservation_create_effects_transition_trg'}, ${'inventory_reservation_release_effect_history_no_delete_trg'}, ${'inventory_reservation_release_effect_history_no_update_trg'}, ${'inventory_reservation_release_effect_history_scope_trg'}, ${'inventory_reservation_release_effects_scope_trg'}, ${'inventory_reservation_release_effects_transition_trg'}, ${'inventory_reservation_shortage_impact_decisions_decision_set_trg'}, ${'inventory_reservation_shortage_impact_decisions_exact_scope_trg'}, ${'inventory_reservation_shortage_impact_decisions_no_mutation_trg'}, ${'inventory_reservation_shortage_impacts_decision_set_trg'}, ${'inventory_reservation_shortage_impacts_source_trg'}, ${'inventory_reservation_shortage_impacts_no_mutation_trg'}, ${'inventory_source_assertion_coverage_complete_trg'}, ${'inventory_source_assertion_coverage_exact_scope_trg'}, ${'inventory_source_assertion_coverage_immutable_trg'}, ${'inventory_source_assertions_exact_scope_trg'}, ${'inventory_source_assertions_immutable_trg'}, ${'inventory_source_conflict_revisions_exact_scope_trg'}, ${'inventory_source_conflict_revisions_immutable_trg'}, ${'inventory_source_conflict_revisions_sequence_trg'}, ${'inventory_source_import_ledger_exact_scope_trg'}, ${'inventory_source_import_ledger_immutable_trg'}, ${'inventory_stock_correction_open_transition_trg'}, ${'inventory_stock_correction_source_evidence_coverage_complete_trg'}, ${'inventory_stock_correction_source_evidence_coverage_exact_scope_trg'}, ${'inventory_stock_correction_source_evidence_coverage_immutable_trg'}, ${'inventory_stock_correction_source_evidence_current_transition_trg'}, ${'inventory_stock_correction_source_evidence_exact_scope_trg'}, ${'inventory_stock_correction_source_evidence_immutable_trg'}, ${'inventory_stock_corrections_exact_scope_trg'}, ${'inventory_stock_corrections_immutable_trg'}, ${'inventory_stock_items_current_binding_target_trg'}, ${'inventory_stock_items_immutable_meaning_trg'}, ${'inventory_stock_locations_immutable_identity_trg'}, ${'inventory_stock_location_revisions_append_only_trg'}, ${'inventory_stock_positions_exact_item_unit_trg'}, ${'inventory_stock_positions_immutable_scope_trg'}, ${'inventory_stock_positions_owner_configuration_trg'}, ${'inventory_stock_sharing_eligibilities_immutable_identity_trg'}, ${'inventory_stock_sharing_eligibilities_scope_trg'}, ${'inventory_stock_sharing_eligibility_history_no_delete_trg'}, ${'inventory_stock_sharing_eligibility_history_no_update_trg'}) and not trigger_record.tgisinternal) as required_trigger_count,
      (select count(*)::integer from pg_catalog.pg_trigger trigger_record join pg_catalog.pg_class triggered on triggered.oid = trigger_record.tgrelid join pg_catalog.pg_namespace ns on ns.oid = triggered.relnamespace where ns.nspname = ${INVENTORY_SCHEMA_NAME} and trigger_record.tgname in (${'inventory_commitment_protection_history_no_delete_trg'}, ${'inventory_commitment_protection_history_no_update_trg'}, ${'inventory_commitment_protection_history_scope_trg'}, ${'inventory_commitment_protections_lifecycle_trg'}, ${'inventory_commitment_protections_scope_trg'}) and not trigger_record.tgisinternal) as commitment_protection_trigger_count,
      (select count(*)::integer from pg_catalog.pg_class journal join pg_catalog.pg_namespace ns on ns.oid = journal.relnamespace where ns.nspname = ${'drizzle'} and journal.relname = ${'__drizzle_migrations_inventory'}) as journal_count,
      has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_backend_configuration_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_catalog_to_stock_binding_compatibility()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_catalog_to_stock_binding_history_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_commitment_protection_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_commitment_protection_lifecycle()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_commitment_protection_history_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_commitment_protection_history_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_effect_ledger_exact_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_effect_ledger_history_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_effect_ledger_transition()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_effect_ledger_history_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_external_stock_correlation_nonoverlap()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_external_stock_correlation_identity_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_obligation_allocation_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_obligation_authority()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_obligation_requirement_coverage()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_obligation_requirement_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_obligation_allocation_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_obligation_origin_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_obligation_requirement_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_physical_stock_effect_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_physical_stock_effect_identity_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_create_effect_transition()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_confirmation_history_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_confirmation_lifecycle()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_confirmation_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_reservation_confirmation_history_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_release_effect_history_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_release_effect_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_release_effect_transition()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_reservation_release_effect_history_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_reservation_shortage_impact_source()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.verify_reservation_shortage_impact_decisions()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_reservation_shortage_impact_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_source_assertion_exact_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_source_assertion_coverage_complete()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_source_assertion_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_source_conflict_exact_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_source_conflict_revision()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_source_import_ledger_exact_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_source_import_ledger_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_correction_exact_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_correction_open_transition()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_correction_source_evidence_coverage_complete()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_correction_source_evidence_current_transition()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_correction_source_evidence_exact_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_correction_source_evidence_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_correction_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_position_stock_item_unit()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_position_owner_configuration()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.protect_current_catalog_to_stock_binding_target()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_item_meaning_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_location_identity_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_location_revision_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_position_scope_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.enforce_stock_sharing_eligibility_scope()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_sharing_eligibility_identity_mutation()'}, ${'EXECUTE'})
        or has_function_privilege(${'ontos_runtime'}, ${'inventory.reject_stock_sharing_eligibility_history_mutation()'}, ${'EXECUTE'}) as private_trigger_function_executable,
      has_function_privilege(${'ontos_runtime'}, ${'inventory.read_physical_stock_effect_for_worker(uuid,uuid,uuid)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.finalize_physical_stock_effect_for_worker(uuid,uuid,uuid,jsonb)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.read_reservation_create_effect_for_worker(uuid,uuid,text)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.finalize_reservation_create_effect_for_worker(uuid,uuid,text,jsonb)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.find_reservation_shortage_impact_for_worker(uuid,uuid,text,uuid)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.read_reservation_shortage_impact_context_for_worker(uuid,uuid,text,uuid,uuid,timestamptz)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.apply_reservation_shortage_impact_for_worker(uuid,uuid,text,uuid,uuid,timestamptz,jsonb)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.read_reservation_release_effect_for_worker(uuid,uuid,text)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.finalize_reservation_release_effect_for_worker(uuid,uuid,text,integer,jsonb)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.claim_inventory_effect_ledger(uuid,uuid,text,jsonb)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.read_inventory_effect_ledger_for_worker(uuid,uuid,text)'}, ${'EXECUTE'})
        and has_function_privilege(${'ontos_runtime'}, ${'inventory.transition_inventory_effect_ledger_for_worker(uuid,uuid,text,integer,text,jsonb)'}, ${'EXECUTE'}) as worker_routines_executable,
      has_schema_privilege(${'ontos_runtime'}, ${INVENTORY_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
      has_schema_privilege(${'ontos_runtime'}, ${INVENTORY_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
      count(distinct relation.oid) filter (where has_table_privilege(${'ontos_runtime'}, relation.oid, ${'SELECT'}))::integer as runtime_select_count,
      count(distinct relation.oid) filter (where has_table_privilege(${'ontos_runtime'}, relation.oid, ${'INSERT'}))::integer as runtime_insert_count,
      count(distinct relation.oid) filter (where has_table_privilege(${'ontos_runtime'}, relation.oid, ${'UPDATE'}))::integer as runtime_update_count,
      count(distinct relation.oid) filter (where has_table_privilege(${'ontos_runtime'}, relation.oid, ${'DELETE'}))::integer as runtime_delete_count,
      runtime_role.rolsuper as role_super,
      runtime_role.rolbypassrls as role_bypass_rls
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join pg_catalog.pg_roles runtime_role
      where namespace.nspname = ${INVENTORY_SCHEMA_NAME}
        and relation.relkind in (${'r'}, ${'p'})
        and runtime_role.rolname = ${'ontos_runtime'}
      group by runtime_role.rolsuper, runtime_role.rolbypassrls`,
    'objects',
  );
  if (
    infrastructure === undefined ||
    !infrastructure.effect_ledger_contract_current ||
    infrastructure.table_count !== INVENTORY_TABLES.length ||
    infrastructure.force_rls_count !== INVENTORY_TABLES.length ||
    infrastructure.wrong_owner_count !== 0 ||
    infrastructure.policy_count !== INVENTORY_TABLES.length * 4 ||
    infrastructure.required_index_count !== 1 ||
    infrastructure.required_trigger_count !== 69 ||
    infrastructure.commitment_protection_trigger_count !== 5 ||
    infrastructure.journal_count !== 1 ||
    infrastructure.private_trigger_function_executable ||
    !infrastructure.worker_routines_executable ||
    infrastructure.runtime_create ||
    !infrastructure.runtime_usage ||
    infrastructure.runtime_select_count !== INVENTORY_TABLES.length ||
    infrastructure.runtime_insert_count !== INVENTORY_TABLES.length ||
    infrastructure.runtime_update_count !== INVENTORY_TABLES.length ||
    infrastructure.runtime_delete_count !== INVENTORY_TABLES.length ||
    infrastructure.role_super ||
    infrastructure.role_bypass_rls
  ) {
    return yield* new VerificationError({
      reason: 'Inventory ownership, RLS, trigger, journal, or runtime-role verification failed',
    });
  }
  return { typedTableCount: INVENTORY_TABLES.length };
});

const runtime = InventoryDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConnectionPair().pipe(Effect.map(({ admin }) => admin)))),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));
console.log(`Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${INVENTORY_SCHEMA_NAME}`);
