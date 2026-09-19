import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Array as EffectArray, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../../../packages/core-runtime/src/db/client.ts';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME,
  COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY,
  commerceCustomerContextRelations,
} from '../../src/database/schema.ts';

const runtimeRole = 'ontos_runtime';

/** Routines the owner boundary keeps private: reachable only from another routine's definer context. */
const privateRoutines = [
  'access_grant_row',
  'assert_customer_payment_terms_scope',
  'assert_profile_operation_scope',
  'ccc_portal_enrollment_attempts_identity_guard',
  'ccc_portal_enrollment_owner_operations_identity_guard',
  'customer_group_document',
  'customer_group_membership_document',
  'customer_payment_terms_state_json',
  'guard_payment_term_retirement_reservation',
  'invalidate_invitation_claim_proofs',
  'invitation_grant_progress',
  'portal_enrollment_attempt_projection',
  'record_claim_reset_marker',
  'reject_address_book_reconciliation_receipt_mutation',
  'reject_append_only_mutation',
] as const;

/** Routines the runtime role must be able to execute; every owner surface reaches the database through one. */
const grantedRoutines = [
  'add_saved_address',
  'archive_customer_group',
  'assess_payment_term_entitlement_use',
  'assign_customer_group_membership',
  'assign_price_group',
  'authorize_portal_enrollment_account_creation',
  'begin_access_grant',
  'begin_access_revoke',
  'change_address_default',
  'change_purchase_limit_policy',
  'claim_portal_enrollment_transition',
  'consume_invitation_claim_proof',
  'consume_purchase_approval',
  'create_access_invitation',
  'create_approval_hierarchy',
  'create_customer_group',
  'create_portal_enrollment_attempt',
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
  'read_portal_enrollment_attempt',
  'read_portal_enrollment_owner_operation',
  'read_price_group_assignments',
  'read_profile_reconciliation',
  'read_profile_trading_gate',
  'read_purchase_limit_policies',
  'read_retail_portal_binding',
  'read_retail_portal_binding_authorization',
  'read_retail_portal_profile_binding_permission_mutation',
  'read_saved_address',
  'reconcile_portal_enrollment_outcome',
  'reconcile_profile_reconciliation_owner',
  'record_address_book_reconciliation_receipt',
  'record_guest_attribution',
  'record_portal_enrollment_outcome',
  'record_profile_reconciliation_owner_outcome',
  'redeem_invitation_claim_secret',
  'register_invitation_claim_proof',
  'remove_customer_group_membership',
  'remove_price_group_assignment',
  'remove_saved_address',
  'reroute_purchase_approval_request',
  'reserve_payment_term_retirement',
  'resolve_price_group_assignments',
  'resolve_profile_reconciliation',
  'resolve_retail_principal',
  'revalidate_purchase_approval',
  'stage_access_invitation_claim_grants',
  'stage_invitation_claim_proof_delivery',
  'stage_retail_portal_profile_binding_permission_mutations',
  'submit_purchase_approval_request',
  'terminate_portal_enrollment',
  'transition_access_grant',
  'transition_profile',
  'update_customer_group',
  'update_saved_address',
  'verify_address_book_reconciliation',
  'verify_invitation_claim_authority',
  'verify_payment_terms_reconciliation_owner',
] as const;

const appendOnlyTriggers = [
  ['access_mutation_journal', 'ccc_access_journal_append_only'],
  ['address_book_reconciliation_receipts', 'ccc_address_reconciliation_receipts_append_only_trg'],
  ['counterparty_access_invitations', 'ccc_invitation_claim_proofs_lifecycle_trg'],
  ['customer_group_revisions', 'ccc_group_revisions_append_only'],
  ['customer_profile_aliases', 'ccc_profile_aliases_append_only'],
  ['customer_profile_lifecycle_history', 'ccc_profile_history_append_only'],
  ['guest_retail_attributions', 'ccc_guest_attributions_append_only'],
  ['party_merge_profile_observations', 'ccc_party_merge_observations_append_only_trg'],
  ['portal_enrollment_attempts', 'ccc_portal_enrollment_attempts_identity_guard'],
  ['portal_enrollment_owner_operations', 'ccc_portal_enrollment_owner_operations_identity_guard'],
  ['profile_reconciliation_case_members', 'ccc_reconciliation_members_append_only'],
  ['profile_reconciliation_owner_outcomes', 'ccc_reconciliation_owner_outcomes_append_only_trg'],
  ['retail_portal_profile_binding_history', 'ccc_portal_binding_history_append_only'],
] as const;

const temporalExclusionConstraints = [
  'ccc_address_defaults_no_overlap_excl',
  'ccc_group_lifecycle_no_overlap_excl',
  'ccc_memberships_no_overlap_excl',
  'ccc_payment_entitlements_no_overlap_excl',
  'ccc_payment_preferences_no_overlap_excl',
  'ccc_price_assignments_no_overlap_excl',
] as const;

const requiredUniqueIndexes = [
  'ccc_approval_requests_active_proposal_uk',
  'ccc_counterparty_profiles_business_key_uk',
  'ccc_invitation_claim_proofs_current_uk',
  'ccc_limit_defaults_current_uk',
  'ccc_limit_overrides_current_uk',
  'ccc_portal_binding_history_revision_uk',
  'ccc_portal_bindings_current_profile_principal_uk',
] as const;

/** Superseded by the profile-principal pair; a reappearance would silently re-broaden binding uniqueness. */
const retiredUniqueIndexes = ['ccc_portal_bindings_current_auth_uk', 'ccc_portal_bindings_current_profile_uk'] as const;

const names = (rows: readonly { readonly name: string }[]): readonly string[] =>
  EffectArray.sort(
    rows.map(({ name }) => name),
    Order.String,
  );

it.live('governs the Commerce Customer Context schema through forced RLS and routine-only runtime access', () =>
  Effect.scoped(
    Effect.gen(function* databaseSecurityCatalog() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquirePoolResource(
        () => new Pool({ connectionString: connections.admin.connectionString, max: 1 }),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceCustomerContextRelations);
      const schema = COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME;

      const tables = yield* admin.execute<{
        readonly enabled: boolean;
        readonly forced: boolean;
        readonly name: string;
      }>(
        sql`select relname as name, relrowsecurity as enabled, relforcerowsecurity as forced
            from pg_class
            join pg_namespace on pg_namespace.oid = pg_class.relnamespace
            where nspname = ${schema} and relkind = 'r'`,
        'objects',
      );
      expect(names(tables)).toEqual(EffectArray.sort([...COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY], Order.String));
      expect(tables.filter(({ enabled, forced }) => !enabled || !forced)).toEqual([]);

      const tableGrants = yield* admin.execute<{ readonly name: string }>(
        sql`select format('%s.%s:%s', table_schema, table_name, privilege_type) as name
            from information_schema.role_table_grants
            where grantee = ${runtimeRole} and table_schema = ${schema}`,
        'objects',
      );
      expect(tableGrants).toEqual([]);

      const sequenceGrants = yield* admin.execute<{ readonly name: string }>(
        sql`select sequence_name as name
            from information_schema.sequences
            where sequence_schema = ${schema}
              and has_sequence_privilege(${runtimeRole}, format('%I.%I', sequence_schema, sequence_name), 'USAGE, SELECT, UPDATE')`,
        'objects',
      );
      expect(sequenceGrants).toEqual([]);

      const routines = yield* admin.execute<{
        readonly definer: boolean;
        readonly executable: boolean;
        readonly name: string;
        readonly returnsTrigger: boolean;
        readonly searchPath: string | null;
      }>(
        sql`select proname as name,
                   prosecdef as definer,
                   prorettype = 'pg_catalog.trigger'::regtype as "returnsTrigger",
                   has_function_privilege(${runtimeRole}, pg_proc.oid, 'EXECUTE') as executable,
                   (select config from unnest(coalesce(proconfig, '{}'::text[])) as config where config like 'search_path=%') as "searchPath"
            from pg_proc
            join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
            where nspname = ${schema}`,
        'objects',
      );
      const callable = routines.filter(({ returnsTrigger }) => !returnsTrigger);
      expect(callable.filter(({ definer }) => !definer)).toEqual([]);
      expect(callable.filter(({ searchPath }) => searchPath?.startsWith('search_path=pg_catalog') !== true)).toEqual(
        [],
      );
      expect(routines.filter(({ executable, returnsTrigger }) => returnsTrigger && executable)).toEqual([]);
      expect(names(routines.filter(({ executable }) => executable))).toEqual(
        EffectArray.sort([...grantedRoutines], Order.String),
      );
      const declared = new Set(routines.map(({ name }) => name));
      for (const routine of privateRoutines) {
        expect(declared.has(routine), routine).toBe(true);
      }

      const triggers = yield* admin.execute<{ readonly name: string }>(
        sql`select format('%s:%s', relname, tgname) as name
            from pg_trigger
            join pg_class on pg_class.oid = pg_trigger.tgrelid
            join pg_namespace on pg_namespace.oid = pg_class.relnamespace
            where nspname = ${schema} and not tgisinternal`,
        'objects',
      );
      const triggerNames = new Set(triggers.map(({ name }) => name));
      for (const [table, trigger] of appendOnlyTriggers) {
        expect(triggerNames.has(`${table}:${trigger}`), `${table}.${trigger}`).toBe(true);
      }

      const constraints = yield* admin.execute<{ readonly name: string }>(
        sql`select conname as name
            from pg_constraint
            join pg_namespace on pg_namespace.oid = pg_constraint.connamespace
            where nspname = ${schema} and contype = 'x'`,
        'objects',
      );
      const exclusionNames = new Set(constraints.map(({ name }) => name));
      for (const constraint of temporalExclusionConstraints) {
        expect(exclusionNames.has(constraint), constraint).toBe(true);
      }

      const businessKey = yield* admin.execute<{ readonly columns: string; readonly name: string }>(
        sql`select conname as name,
                   (select string_agg(attname, ',' order by position)
                    from unnest(conkey) with ordinality as key(attnum, position)
                    join pg_attribute on attrelid = conrelid and pg_attribute.attnum = key.attnum) as columns
            from pg_constraint
            join pg_namespace on pg_namespace.oid = pg_constraint.connamespace
            where nspname = ${schema} and conname = 'ccc_counterparty_profiles_business_key_uk'`,
        'objects',
      );
      expect(businessKey.at(0)?.columns).toBe('tenant_id,counterparty_resource_id');

      const indexes = yield* admin.execute<{ readonly name: string }>(
        sql`select indexname as name from pg_indexes where schemaname = ${schema}`,
        'objects',
      );
      const indexNames = new Set(indexes.map(({ name }) => name));
      for (const index of requiredUniqueIndexes) {
        expect(indexNames.has(index), index).toBe(true);
      }
      for (const index of retiredUniqueIndexes) {
        expect(indexNames.has(index), index).toBe(false);
      }

      const descriptionCheck = yield* admin.execute<{ readonly name: string }>(
        sql`select conname as name
            from pg_constraint
            join pg_namespace on pg_namespace.oid = pg_constraint.connamespace
            where nspname = ${schema} and conname = 'ccc_group_revisions_description_ck'`,
        'objects',
      );
      expect(names(descriptionCheck)).toEqual(['ccc_group_revisions_description_ck']);
    }),
  ),
);
