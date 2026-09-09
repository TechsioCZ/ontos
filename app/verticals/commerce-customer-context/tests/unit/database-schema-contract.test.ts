// @effect-diagnostics nodeBuiltinImport:off -- Migration contract verifies checked-in SQL evidence; expires: 2027-03-01.
import { readdirSync, readFileSync } from 'node:fs';

import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME,
  COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY,
  COMMERCE_CUSTOMER_CONTEXT_TABLES,
  counterpartyPurchasingProfiles,
  counterpartyPurchaseLimitDefaults,
  customerCurrencyPreferences,
  customerGroupMemberships,
  customerGroupRevisions,
  customerPaymentTermEntitlements,
  customerPaymentTermPreferences,
  customerPriceGroupAssignments,
  principalPurchaseLimitOverrides,
  partyMergeProfileObservations,
  profileReconciliationCases,
  profileReconciliationOwnerOutcomes,
  retailPortalProfileBindingHistory,
  retailPortalProfileBindings,
  purchaseProposalRevisions,
  approvalHierarchies,
  approvalRoutes,
  purchaseApprovalRequests,
  approvalDecisions,
  approvalRevalidations,
} from '../../src/database/schema.ts';

const migrationRoot = new URL('../../drizzle/', import.meta.url);

const profileCompletionMigrationFolder =
  '20260909134514_add-profile-observation-owner-outcome-and-invitation-proof-evidence';

const migrationFile = (folder: string): string =>
  readFileSync(new URL(`${folder}/migration.sql`, migrationRoot), 'utf-8');

const migrationSql = (): string =>
  EffectArray.sort(readdirSync(migrationRoot), Order.String).map(migrationFile).join('\n');

const profileRoutineNames = [
  'ensure_counterparty_profile',
  'ensure_retail_profile',
  'finalize_retail_portal_binding_authorization',
  'finalize_retail_portal_profile_binding_permission_mutation',
  'mutate_retail_portal_binding',
  'observe_party_merge_reconciliation',
  'open_profile_reconciliation',
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
  'resolve_profile_reconciliation',
  'resolve_retail_principal',
  'stage_retail_portal_profile_binding_permission_mutations',
  'transition_profile',
  'verify_address_book_reconciliation',
  'verify_currency_preference_reconciliation_owner',
  'verify_payment_terms_reconciliation_owner',
] as const;

it('owns an exact private Commerce Customer Context table catalog', () => {
  const actual = EffectArray.sort(
    COMMERCE_CUSTOMER_CONTEXT_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );
  const expected = EffectArray.sort(
    COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY.map(
      (name) => `${COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME}.${name}`,
    ),
    Order.String,
  );

  expect(COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME).toBe('commerce_customer_context');
  expect(COMMERCE_CUSTOMER_CONTEXT_TABLES).toHaveLength(39);
  expect(actual).toEqual(expected);
});

it('requires tenant and Selling Legal Entity scope with complete forced-RLS policy shape', () => {
  for (const table of COMMERCE_CUSTOMER_CONTEXT_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
    expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(
      true,
    );
    expect(config.policies.map((policy) => policy.for)).toEqual([
      'select',
      'insert',
      'update',
      'delete',
      'all',
    ]);
    for (const policy of config.policies.slice(0, 4)) {
      expect(policy.to).toBe('ontos_runtime');
    }
    expect(config.policies[4]?.to).toBe('public');
    expect(
      [...config.uniqueConstraints, ...config.indexes].some((candidate) => {
        const columns = 'columns' in candidate ? candidate.columns : candidate.config.columns;
        const names = new Set(columns.flatMap((column) => ('name' in column ? [column.name] : [])));
        return names.has('tenant_id') && names.has('legal_entity_id');
      }),
      `${config.name} needs a tenant/legal-entity-qualified identity`,
    ).toBe(true);
  }
});

it('stores purchasing limits as exact decimals and keeps unlimited distinct from zero', () => {
  for (const table of [counterpartyPurchaseLimitDefaults, principalPurchaseLimitOverrides]) {
    const config = getTableConfig(table);
    expect(config.columns.find(({ name }) => name === 'amount')?.getSQLType()).toBe(
      'numeric(38, 9)',
    );
    expect(config.checks.some(({ name }) => name.endsWith('_value_ck'))).toBe(true);
    expect(
      config.indexes.some(({ config: index }) => (index.name ?? '').endsWith('_current_uk')),
    ).toBe(true);
  }
});

it('models independently revised, half-open temporal customer facts', () => {
  for (const table of [
    customerGroupMemberships,
    customerPriceGroupAssignments,
    customerCurrencyPreferences,
    customerPaymentTermEntitlements,
    customerPaymentTermPreferences,
  ]) {
    const config = getTableConfig(table);
    for (const column of ['effective_from', 'effective_to', 'revision', 'recorded_at']) {
      expect(
        config.columns.some(({ name }) => name === column),
        `${config.name}.${column}`,
      ).toBe(true);
    }
    expect(config.checks.some(({ name }) => name.endsWith('_period_ck'))).toBe(true);
  }
});

it('persists each required mutable Customer Group description on its immutable revision', () => {
  const config = getTableConfig(customerGroupRevisions);
  expect(config.columns.some(({ name, notNull }) => name === 'description' && notNull)).toBe(true);
  expect(config.checks.some(({ name }) => name === 'ccc_group_revisions_description_ck')).toBe(
    true,
  );
});

it('keeps the Counterparty profile business key global within its tenant', () => {
  const config = getTableConfig(counterpartyPurchasingProfiles);
  const businessKey = config.uniqueConstraints.find(
    ({ name }) => name === 'ccc_counterparty_profiles_business_key_uk',
  );
  const businessKeyColumns = businessKey?.columns.map(({ name }) => name);

  expect(businessKeyColumns).toEqual(['tenant_id', 'counterparty_resource_id']);
  expect(businessKeyColumns).not.toContain('legal_entity_id');

  const completionSql = migrationFile(profileCompletionMigrationFolder);
  expect(completionSql).toContain(
    'CONSTRAINT "ccc_counterparty_profiles_business_key_uk" UNIQUE("tenant_id","counterparty_resource_id")',
  );
  expect(completionSql).not.toContain(
    'CONSTRAINT "ccc_counterparty_profiles_business_key_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_resource_id")',
  );
});

it('keeps only one current retail binding per exact profile-principal pair', () => {
  const config = getTableConfig(retailPortalProfileBindings);
  const currentIndexes = config.indexes.filter(({ config: index }) =>
    (index.name ?? '').startsWith('ccc_portal_bindings_current_'),
  );

  expect(currentIndexes).toHaveLength(1);
  expect(currentIndexes[0]?.config.name).toBe('ccc_portal_bindings_current_profile_principal_uk');
  expect(currentIndexes[0]?.config.unique).toBe(true);
  expect(
    currentIndexes[0]?.config.columns.flatMap((column) => ('name' in column ? [column.name] : [])),
  ).toEqual(['tenant_id', 'legal_entity_id', 'retail_customer_profile_id', 'principal_id']);
  expect(currentIndexes[0]?.config.where).toBeDefined();
  expect(config.indexes.map(({ config: index }) => index.name)).not.toContain(
    'ccc_portal_bindings_current_profile_uk',
  );
  expect(config.indexes.map(({ config: index }) => index.name)).not.toContain(
    'ccc_portal_bindings_current_auth_uk',
  );

  expect(migrationSql()).toContain(
    'CREATE UNIQUE INDEX "ccc_portal_bindings_current_profile_principal_uk" ON "commerce_customer_context"."retail_portal_profile_bindings" ("tenant_id","legal_entity_id","retail_customer_profile_id","principal_id") WHERE "lifecycle" = \'ACTIVE\';',
  );
});

it('keeps portal binding transitions as uniquely revised history and a bigint event watermark', () => {
  const history = getTableConfig(retailPortalProfileBindingHistory);
  const revisionIdentity = history.uniqueConstraints.find(
    ({ name }) => name === 'ccc_portal_binding_history_revision_uk',
  );
  expect(revisionIdentity?.columns.map(({ name }) => name)).toEqual([
    'tenant_id',
    'legal_entity_id',
    'retail_portal_profile_binding_id',
    'revision',
  ]);
  for (const column of [
    'from_lifecycle',
    'to_lifecycle',
    'effective_at',
    'enrollment_evidence_ref',
    'action_invocation_id',
    'actor_principal_id',
    'recorded_at',
  ]) {
    expect(
      history.columns.some(({ name }) => name === column),
      column,
    ).toBe(true);
  }

  const reconciliation = getTableConfig(profileReconciliationCases);
  expect(
    reconciliation.columns
      .find(({ name }) => name === 'last_processed_event_version')
      ?.getSQLType(),
  ).toBe('bigint');
});

it('checks in the final profile observation and owner-outcome hardening', () => {
  const folders = readdirSync(migrationRoot);
  expect(folders.filter((folder) => folder.startsWith('20260909134514_'))).toEqual([
    profileCompletionMigrationFolder,
  ]);
  expect(() =>
    readFileSync(
      new URL(`${profileCompletionMigrationFolder}/snapshot.json`, migrationRoot),
      'utf-8',
    ),
  ).not.toThrow();

  const completionSql = migrationFile(profileCompletionMigrationFolder);
  for (const table of [
    'counterparty_invitation_claim_attempts',
    'counterparty_invitation_claim_proofs',
    'party_merge_profile_observations',
    'profile_reconciliation_owner_outcomes',
  ]) {
    expect(completionSql).toContain(
      `ALTER TABLE "commerce_customer_context"."${table}" FORCE ROW LEVEL SECURITY;`,
    );
    expect(completionSql).toContain(
      `REVOKE ALL ON TABLE "commerce_customer_context"."${table}" FROM PUBLIC, "ontos_runtime";`,
    );
  }
  for (const trigger of [
    'ccc_party_merge_observations_append_only_trg',
    'ccc_reconciliation_owner_outcomes_append_only_trg',
  ]) {
    expect(completionSql).toContain(`CREATE TRIGGER "${trigger}"`);
  }
  expect(completionSql).toContain(
    'BEFORE UPDATE OR DELETE ON "commerce_customer_context"."party_merge_profile_observations"',
  );
  expect(completionSql).toContain(
    'BEFORE UPDATE OR DELETE ON "commerce_customer_context"."profile_reconciliation_owner_outcomes"',
  );

  for (const table of [partyMergeProfileObservations, profileReconciliationOwnerOutcomes]) {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toHaveLength(5);
  }
});

it('exposes exactly the scoped profile owner routines', () => {
  const profileSql = migrationSql();
  const grantedRoutineNames = EffectArray.sort(
    [
      ...new Set(
        Array.from(
          profileSql.matchAll(
            /GRANT EXECUTE ON FUNCTION "commerce_customer_context"\."(?<routineName>[^"]+)"\([^;]+\) TO "ontos_runtime";/gu,
          ),
          (match) => match.groups?.routineName ?? '',
        ).filter((routineName) => profileRoutineNames.some((expected) => expected === routineName)),
      ),
    ],
    Order.String,
  );

  expect(grantedRoutineNames).toEqual(EffectArray.sort([...profileRoutineNames], Order.String));

  const ownerOutcomeSignature =
    '"record_profile_reconciliation_owner_outcome"(uuid,uuid,uuid,uuid,text,text,text,text,integer,bigint,text,timestamptz,text,uuid,uuid)';
  const resolveSignature =
    '"resolve_profile_reconciliation"(uuid,uuid,uuid,uuid,integer,bigint,jsonb,text,timestamptz,text,uuid,uuid)';
  for (const signature of [ownerOutcomeSignature, resolveSignature]) {
    expect(profileSql).toContain(
      `REVOKE ALL ON FUNCTION "commerce_customer_context".${signature} FROM PUBLIC;`,
    );
    expect(profileSql).toContain(
      `GRANT EXECUTE ON FUNCTION "commerce_customer_context".${signature} TO "ontos_runtime";`,
    );
  }
  expect(profileSql).toContain(
    'REVOKE ALL ON FUNCTION "commerce_customer_context"."assert_profile_operation_scope"(uuid,uuid) FROM PUBLIC, "ontos_runtime";',
  );
  expect(profileSql).not.toContain(
    'GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assert_profile_operation_scope"',
  );
});

it('checks in durable Purchasing Approval owner routines and immutable aggregate storage', () => {
  const sql = migrationSql();
  const persistence = readFileSync(
    new URL('../../src/persistence/purchasing-approval-persistence.ts', import.meta.url),
    'utf-8',
  );
  const routines = [
    'create_purchase_proposal_revision',
    'read_current_purchase_proposal_revision',
    'read_current_purchase_approval_revalidation',
    'create_approval_hierarchy',
    'submit_purchase_approval_request',
    'decide_purchase_approval_request',
    'reroute_purchase_approval_request',
    'revalidate_purchase_approval',
    'consume_purchase_approval',
  ] as const;
  for (const routine of routines) {
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION "commerce_customer_context"."${routine}"`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION "commerce_customer_context"."${routine}"`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION "commerce_customer_context"."${routine}"`);
  }
  expect(sql).toContain('SET search_path = pg_catalog, commerce_customer_context');
  expect(sql).toContain('FOR UPDATE');
  expect(sql).toContain("request_revision = (p_payload->>'expectedRequestRevision')::integer");
  expect(sql).toContain(
    "v_request_row.request_snapshot->'proposal'->'proposalRevisionRef' IS DISTINCT FROM p_payload->'proposalRevisionRef'",
  );
  expect(persistence).not.toMatch(/new Map|TenantStore|storeFor/gu);

  for (const table of [
    purchaseProposalRevisions,
    approvalHierarchies,
    approvalRoutes,
    purchaseApprovalRequests,
    approvalDecisions,
    approvalRevalidations,
  ]) {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toHaveLength(5);
    expect(config.columns.some(({ name }) => name === 'idempotency_key')).toBe(true);
    expect(config.columns.some(({ name }) => name === 'action_invocation_id')).toBe(true);
    expect(config.columns.some(({ name }) => name === 'actor_principal_id')).toBe(true);
  }
});

it('checks in the non-generated database security and temporal assertions', () => {
  const sql = migrationSql();

  expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
  expect(sql).toContain('FORCE ROW LEVEL SECURITY');
  expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_customer_context"');
  expect(sql).toContain(
    'ontos_runtime must not hold raw Commerce Customer Context table privileges',
  );
  expect(sql).toContain('coalesce("storefront_resource_id", \'\')');
  expect(sql).toContain(
    "\"delivery_method\" in ('VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY')",
  );
  expect(sql.match(/SECURITY DEFINER/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(sql).toContain(
    'REVOKE ALL ON FUNCTION "commerce_customer_context"."read_currency_preference"',
  );
  expect(sql).toContain(
    '"read_currency_preference"(uuid, uuid, text, text, text) TO "ontos_runtime"',
  );
  expect(sql).toContain(
    'counterparty_profile.counterparty_resource_id = p_counterparty_resource_id',
  );
  expect(
    sql.match(/counterparty_profile\.counterparty_resource_id = p_counterparty_resource_id/gu)
      ?.length ?? 0,
  ).toBeGreaterThanOrEqual(2);
  expect(sql).toContain("v_profile_kind = 'RETAIL' AND p_counterparty_resource_id IS NOT NULL");
  expect(sql).toContain(
    'ALTER TABLE "commerce_customer_context"."customer_group_revisions" ALTER COLUMN "description" SET NOT NULL',
  );
  expect(sql).toContain('"amount" <> trunc("amount", 9)');
  expect(sql).toContain(
    'GRANT EXECUTE ON FUNCTION "commerce_customer_context"."change_currency_preference"',
  );
  const currencyOwnerVerifierSignature =
    '"verify_currency_preference_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,integer,bigint,timestamptz,uuid,uuid,text)';
  expect(sql).toContain(
    `REVOKE ALL ON FUNCTION "commerce_customer_context".${currencyOwnerVerifierSignature} FROM PUBLIC`,
  );
  expect(sql).toContain(
    `GRANT EXECUTE ON FUNCTION "commerce_customer_context".${currencyOwnerVerifierSignature} TO "ontos_runtime"`,
  );
  expect(sql).toContain("p_owner IS DISTINCT FROM 'CURRENCY_PREFERENCE'");
  expect(sql).toContain('v_conflicting_present<>0');
  expect(sql).toContain("'beforeFacts',v_member_facts");
  expect(sql).toContain("'afterFacts',v_member_facts");
  const paymentTermsOwnerVerifierSignature =
    '"verify_payment_terms_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,text,integer,bigint,timestamptz,text,uuid,uuid,text)';
  expect(sql).toContain(
    `REVOKE ALL ON FUNCTION "commerce_customer_context".${paymentTermsOwnerVerifierSignature} FROM PUBLIC`,
  );
  expect(sql).toContain(
    `GRANT EXECUTE ON FUNCTION "commerce_customer_context".${paymentTermsOwnerVerifierSignature} TO "ontos_runtime"`,
  );
  expect(sql).toContain('v_non_survivor_current_preferences > 0');
  expect(sql).toContain('futureOverlapInventory');
  for (const constraint of [
    'ccc_memberships_no_overlap_excl',
    'ccc_price_assignments_no_overlap_excl',
    'ccc_currency_preferences_no_overlap_excl',
    'ccc_payment_entitlements_no_overlap_excl',
    'ccc_payment_preferences_no_overlap_excl',
    'ccc_address_defaults_no_overlap_excl',
    'ccc_group_lifecycle_no_overlap_excl',
  ]) {
    expect(sql).toContain(constraint);
  }
  for (const trigger of [
    'ccc_access_journal_append_only',
    'ccc_address_reconciliation_receipts_append_only_trg',
    'ccc_group_revisions_append_only',
    'ccc_guest_attributions_append_only',
    'ccc_portal_binding_history_append_only',
    'ccc_profile_aliases_append_only',
    'ccc_profile_history_append_only',
    'ccc_reconciliation_members_append_only',
  ]) {
    expect(sql).toContain(trigger);
  }
  expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON\s+(?:TABLE\s+)?/iu);
});
