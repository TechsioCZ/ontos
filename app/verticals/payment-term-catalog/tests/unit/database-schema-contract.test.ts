import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import {
  PAYMENT_TERM_CATALOG_SCHEMA_NAME,
  PAYMENT_TERM_CATALOG_TABLE_INVENTORY,
  PAYMENT_TERM_CATALOG_TABLES,
  paymentTermAliases,
  paymentTermLifecycleEvents,
  paymentTermRevisions,
  paymentTerms,
} from '../../src/database/schema.ts';

it('owns the exact Payment Term Catalog in one legal-entity-scoped schema', () => {
  const qualifiedNames = EffectArray.sort(
    PAYMENT_TERM_CATALOG_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );

  expect(PAYMENT_TERM_CATALOG_SCHEMA_NAME).toBe('payment_term_catalog');
  expect(PAYMENT_TERM_CATALOG_TABLE_INVENTORY).toEqual([
    'payment_term_aliases',
    'payment_term_lifecycle_events',
    'payment_term_revisions',
    'payment_terms',
  ]);
  expect(qualifiedNames).toEqual(
    PAYMENT_TERM_CATALOG_TABLE_INVENTORY.map((tableName) => `payment_term_catalog.${tableName}`),
  );
});

it('forces every governed table through tenant and legal-entity policy dimensions', () => {
  for (const table of PAYMENT_TERM_CATALOG_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    expect(config.columns.some((column) => column.name === 'legal_entity_id' && column.notNull)).toBe(true);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
  }
});

it('stores only the approved typed semantic kinds and immutable revision identity', () => {
  const revisions = getTableConfig(paymentTermRevisions);
  expect(
    EffectArray.sort(
      revisions.checks.map((constraint) => constraint.name),
      Order.String,
    ),
  ).toEqual([
    'payment_term_catalog_revisions_calculation_version_ck',
    'payment_term_catalog_revisions_change_kind_ck',
    'payment_term_catalog_revisions_compatibility_ck',
    'payment_term_catalog_revisions_display_ck',
    'payment_term_catalog_revisions_fingerprint_ck',
    'payment_term_catalog_revisions_number_ck',
    'payment_term_catalog_revisions_reason_ck',
    'payment_term_catalog_revisions_semantic_kind_ck',
    'payment_term_catalog_revisions_semantics_ck',
  ]);
  expect(
    revisions.uniqueConstraints.some((constraint) => constraint.name === 'payment_term_catalog_revisions_number_uk'),
  ).toBe(true);
  expect(revisions.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'payment_term_catalog_revisions_term_fk',
  );
  expect(revisions.indexes.map((index) => index.config.name)).toContain('payment_term_catalog_revisions_semantics_idx');
  expect(revisions.columns.find(({ name }) => name === 'net_days')?.getSQLType()).toBe('bigint');
  expect(revisions.columns.some((column) => column.name === 'semantic_revision_id' && column.notNull)).toBe(true);
});

it('preserves stable identity, lifecycle evidence, and reconciliation aliases', () => {
  const terms = getTableConfig(paymentTerms);
  const lifecycle = getTableConfig(paymentTermLifecycleEvents);
  const aliases = getTableConfig(paymentTermAliases);
  expect(terms.uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'payment_term_catalog_terms_scope_code_uk',
  );
  expect(lifecycle.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual([
    'payment_term_catalog_lifecycle_term_fk',
  ]);
  expect(
    EffectArray.sort(
      aliases.foreignKeys.map((foreignKey) => foreignKey.getName()),
      Order.String,
    ),
  ).toEqual(['payment_term_catalog_aliases_alias_fk', 'payment_term_catalog_aliases_canonical_fk']);
});
