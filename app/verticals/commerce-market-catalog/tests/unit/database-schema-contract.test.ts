import { describe, expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import {
  COMMERCE_MARKET_CATALOG_SCHEMA_NAME,
  COMMERCE_MARKET_CATALOG_TABLE_INVENTORY,
  COMMERCE_MARKET_CATALOG_TABLES,
  gatewayAssertionRedemptions,
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  marketRetirementAdmissions,
  markets,
  storefrontAssociationRevisions,
  storefrontAssociations,
} from '../../src/database/schema.ts';

describe('Commerce Market Catalog database contract', () => {
  it('owns exactly the canonical Market administration tables', () => {
    const qualifiedNames = EffectArray.sort(
      COMMERCE_MARKET_CATALOG_TABLES.map((table) => {
        const config = getTableConfig(table);
        return `${config.schema}.${config.name}`;
      }),
      Order.String,
    );
    expect(COMMERCE_MARKET_CATALOG_SCHEMA_NAME).toBe('commerce_market_catalog');
    expect(qualifiedNames).toEqual(
      COMMERCE_MARKET_CATALOG_TABLE_INVENTORY.map((name) => `commerce_market_catalog.${name}`),
    );
  });

  it('preserves Tenant-scoped RLS on all six business tables so eligible sellers remain discoverable before seller selection', () => {
    const businessTables = [
      marketCatalogCompletenessGenerations,
      marketDefinitionRevisions,
      marketLifecyclePeriods,
      markets,
      storefrontAssociationRevisions,
      storefrontAssociations,
    ];
    expect(businessTables.map((table) => getTableConfig(table).name)).toEqual([
      'market_catalog_completeness_generations',
      'market_definition_revisions',
      'market_lifecycle_periods',
      'markets',
      'storefront_association_revisions',
      'storefront_associations',
    ]);
    expect(COMMERCE_MARKET_CATALOG_TABLES.filter((table) => table !== marketRetirementAdmissions)).toEqual([
      gatewayAssertionRedemptions,
      ...businessTables,
    ]);
    for (const table of businessTables) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
      expect(config.policies.every((policy) => policy.to === 'ontos_runtime')).toBe(true);
    }
  });

  it('keeps pre-authentication assertion replay identities global and separate from business RLS', () => {
    const config = getTableConfig(gatewayAssertionRedemptions);
    expect(config.schema).toBe(COMMERCE_MARKET_CATALOG_SCHEMA_NAME);
    expect(config.name).toBe('gateway_assertion_redemptions');
    expect(config.enableRLS).toBe(false);
    expect(config.policies).toEqual([]);
    expect(config.columns.map(({ name, notNull }) => ({ name, notNull }))).toEqual([
      { name: 'audience', notNull: true },
      { name: 'expires_at', notNull: true },
      { name: 'issuer', notNull: true },
      { name: 'jti', notNull: true },
      { name: 'redeemed_at', notNull: true },
    ]);
    expect(
      config.uniqueConstraints.map(({ columns, name }) => ({ columns: columns.map((column) => column.name), name })),
    ).toEqual([{ columns: ['issuer', 'audience', 'jti'], name: 'market_catalog_gateway_redemptions_identity_uk' }]);
  });

  it('declares Tenant-wide business-code uniqueness and immutable revision/history keys', () => {
    const marketConfig = getTableConfig(markets);
    const definitionConfig = getTableConfig(marketDefinitionRevisions);
    const lifecycleConfig = getTableConfig(marketLifecyclePeriods);
    const associationConfig = getTableConfig(storefrontAssociations);
    const associationRevisionConfig = getTableConfig(storefrontAssociationRevisions);

    expect(marketConfig.uniqueConstraints.map(({ name }) => name)).toContain('commerce_market_catalog_markets_code_uk');
    expect(definitionConfig.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'commerce_market_catalog_definition_revisions_number_uk',
        'commerce_market_catalog_definition_revisions_invocation_uk',
      ]),
    );
    expect(lifecycleConfig.uniqueConstraints.map(({ name }) => name)).toContain(
      'commerce_market_catalog_lifecycle_revision_uk',
    );
    expect(associationConfig.uniqueConstraints.map(({ name }) => name)).toContain(
      'commerce_market_catalog_associations_scope_id_uk',
    );
    expect(associationRevisionConfig.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'commerce_market_catalog_association_revisions_number_uk',
        'commerce_market_catalog_association_revisions_invocation_uk',
      ]),
    );
    expect(getTableConfig(marketCatalogCompletenessGenerations).checks.map(({ name }) => name)).toContain(
      'commerce_market_catalog_completeness_generation_ck',
    );
  });

  it('keeps half-open periods and cross-Tenant references constrained', () => {
    const lifecycle = getTableConfig(marketLifecyclePeriods);
    const associations = getTableConfig(storefrontAssociationRevisions);
    expect(lifecycle.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'commerce_market_catalog_lifecycle_period_ck',
        'commerce_market_catalog_lifecycle_state_ck',
      ]),
    );
    expect(associations.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'commerce_market_catalog_association_revisions_period_ck',
        'commerce_market_catalog_association_revisions_removal_ck',
      ]),
    );
    expect(associations.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'commerce_market_catalog_association_revisions_association_fk',
        'commerce_market_catalog_association_revisions_definition_fk',
        'commerce_market_catalog_association_revisions_market_fk',
      ]),
    );
  });
});
