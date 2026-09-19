import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME,
  COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY,
  COMMERCE_CUSTOMER_CONTEXT_TABLES,
  counterpartyPurchasingProfiles,
  counterpartyPurchaseLimitDefaults,
  customerGroupMemberships,
  customerGroupRevisions,
  customerPaymentTermEntitlements,
  customerPaymentTermPreferences,
  customerPriceGroupAssignments,
  principalPurchaseLimitOverrides,
  profileReconciliationCases,
  retailPortalProfileBindingHistory,
  retailPortalProfileBindings,
  purchaseProposalRevisions,
  approvalHierarchies,
  approvalRoutes,
  purchaseApprovalRequests,
  approvalDecisions,
  approvalRevalidations,
} from '../../src/database/schema.ts';

it('owns an exact private Commerce Customer Context table catalog', () => {
  const actual = EffectArray.sort(
    COMMERCE_CUSTOMER_CONTEXT_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );
  const expected = EffectArray.sort(
    COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY.map((name) => `${COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME}.${name}`),
    Order.String,
  );

  expect(COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME).toBe('commerce_customer_context');
  expect(COMMERCE_CUSTOMER_CONTEXT_TABLES).toHaveLength(40);
  expect(actual).toEqual(expected);
});

it('requires tenant and Selling Legal Entity scope with complete forced-RLS policy shape', () => {
  const tenantOnlyTables = new Set(['portal_enrollment_attempts', 'portal_enrollment_owner_operations']);
  for (const table of COMMERCE_CUSTOMER_CONTEXT_TABLES) {
    const config = getTableConfig(table);
    const tenantOnly = tenantOnlyTables.has(config.name);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
    expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(!tenantOnly);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete', 'all']);
    for (const policy of config.policies.slice(0, 4)) {
      expect(policy.to).toBe('ontos_runtime');
    }
    expect(config.policies[4]?.to).toBe('public');
    expect(
      [...config.uniqueConstraints, ...config.indexes].some((candidate) => {
        const columns = 'columns' in candidate ? candidate.columns : candidate.config.columns;
        const names = new Set(columns.flatMap((column) => ('name' in column ? [column.name] : [])));
        return tenantOnly
          ? names.has('tenant_id') &&
              (names.has('portal_enrollment_attempt_id') || names.has('portal_enrollment_owner_operation_id'))
          : names.has('tenant_id') && names.has('legal_entity_id');
      }),
      tenantOnly
        ? `${config.name} needs a tenant-qualified identity`
        : `${config.name} needs a tenant/legal-entity-qualified identity`,
    ).toBe(true);
  }
});

it('stores purchasing limits as exact decimals and keeps unlimited distinct from zero', () => {
  for (const table of [counterpartyPurchaseLimitDefaults, principalPurchaseLimitOverrides]) {
    const config = getTableConfig(table);
    expect(config.columns.find(({ name }) => name === 'amount')?.getSQLType()).toBe('numeric(38, 9)');
    expect(config.checks.some(({ name }) => name.endsWith('_value_ck'))).toBe(true);
    expect(config.indexes.some(({ config: index }) => (index.name ?? '').endsWith('_current_uk'))).toBe(true);
  }
});

it('models independently revised, half-open temporal customer facts', () => {
  for (const table of [
    customerGroupMemberships,
    customerPriceGroupAssignments,
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
  expect(config.checks.some(({ name }) => name === 'ccc_group_revisions_description_ck')).toBe(true);
});

it('keeps the Counterparty profile business key global within its tenant', () => {
  const config = getTableConfig(counterpartyPurchasingProfiles);
  const businessKey = config.uniqueConstraints.find(({ name }) => name === 'ccc_counterparty_profiles_business_key_uk');
  const businessKeyColumns = businessKey?.columns.map(({ name }) => name);

  expect(businessKeyColumns).toEqual(['tenant_id', 'counterparty_resource_id']);
  expect(businessKeyColumns).not.toContain('legal_entity_id');
});

it('keeps only one current retail binding per exact profile-principal pair', () => {
  const config = getTableConfig(retailPortalProfileBindings);
  const currentIndexes = config.indexes.filter(({ config: index }) =>
    (index.name ?? '').startsWith('ccc_portal_bindings_current_'),
  );

  expect(currentIndexes).toHaveLength(1);
  expect(currentIndexes[0]?.config.name).toBe('ccc_portal_bindings_current_profile_principal_uk');
  expect(currentIndexes[0]?.config.unique).toBe(true);
  expect(currentIndexes[0]?.config.columns.flatMap((column) => ('name' in column ? [column.name] : []))).toEqual([
    'tenant_id',
    'legal_entity_id',
    'retail_customer_profile_id',
    'principal_id',
  ]);
  expect(currentIndexes[0]?.config.where).toBeDefined();
  expect(config.indexes.map(({ config: index }) => index.name)).not.toContain('ccc_portal_bindings_current_profile_uk');
  expect(config.indexes.map(({ config: index }) => index.name)).not.toContain('ccc_portal_bindings_current_auth_uk');
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
  expect(reconciliation.columns.find(({ name }) => name === 'last_processed_event_version')?.getSQLType()).toBe(
    'bigint',
  );
});

it('stores every Purchasing Approval aggregate as forced-RLS, idempotent, attributed storage', () => {
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
