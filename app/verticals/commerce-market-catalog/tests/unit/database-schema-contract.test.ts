import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import {
  COMMERCE_MARKET_CATALOG_SCHEMA_NAME,
  COMMERCE_MARKET_CATALOG_TABLE_INVENTORY,
  COMMERCE_MARKET_CATALOG_TABLES,
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
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

  it('enables Tenant-scoped RLS on every owner table so eligible sellers remain discoverable before seller selection', () => {
    for (const table of COMMERCE_MARKET_CATALOG_TABLES) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
      expect(config.policies.every((policy) => policy.to === 'ontos_runtime')).toBe(true);
    }
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

  it('generates forced-RLS least-privilege routines, append-only guards, CAS locks, and completeness advancement', () => {
    const migration = readFileSync(
      new URL('../../drizzle/20260921152048_governed-market-administration/migration.sql', import.meta.url),
      'utf-8',
    );
    for (const routine of [
      'create_market',
      'revise_market_definition',
      'transition_market_lifecycle',
      'associate_storefront',
      'revise_storefront_association',
      'remove_storefront_association',
    ]) {
      expect(migration).toContain(`commerce_market_catalog.${routine}`);
      expect(migration).toContain(`grant execute on function commerce_market_catalog.${routine}(uuid, uuid, jsonb)`);
    }
    expect(migration.match(/force row level security/gu)).toHaveLength(6);
    expect(migration).toContain('market catalog history is append-only');
    expect(migration).toContain('market identity is immutable');
    expect(migration).toContain('for update');
    expect(migration).toContain("tstzrange(r.effective_from, r.effective_to, '[)')");
    expect(migration).toContain('advance_completeness_generation');
    expect(migration).toContain('revoke all on all tables in schema commerce_market_catalog from ontos_runtime');
  });

  it('exposes one exact-predicate Market eligibility snapshot routine without table access', () => {
    const migration = readFileSync(
      new URL('../../drizzle/20260921174502_market_resolution_read/migration.sql', import.meta.url),
      'utf-8',
    );
    expect(migration).toContain(
      'commerce_market_catalog.read_market_eligibility_snapshot(\n  p_tenant_id uuid,\n  p_payload jsonb',
    );
    expect(migration).toContain('security definer\nset search_path = pg_catalog, pg_temp');
    expect(migration).toContain(
      "p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid",
    );
    expect(migration).toContain('association.storefront_app_id = v_storefront_app_id');
    expect(migration).toContain('association.channel = v_channel');
    expect(migration).toContain('where definition.channels ? association.channel');
    expect(migration).toContain('boundary > greatest(v_effective_at, v_observed_at)');
    expect(migration).toContain("'predicateRevision', md5(");
    expect(migration).toContain("'observedAt', v_observed_at");
    expect(migration).toContain("'nextApplicabilityBoundary'");
    expect(migration).toContain("'facts', coalesce(");
    expect(migration).toContain(
      'revoke all on function commerce_market_catalog.read_market_eligibility_snapshot(uuid, jsonb) from public',
    );
    expect(migration).toContain(
      'grant execute on function commerce_market_catalog.read_market_eligibility_snapshot(uuid, jsonb) to ontos_runtime',
    );
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete)\s+on/iu);
  });

  it('requires the server-issued reservation token, version, and digest before persisting retirement', () => {
    const migration = readFileSync(
      new URL('../../drizzle/20260922160411_market_retirement_reservation_evidence/migration.sql', import.meta.url),
      'utf-8',
    );
    expect(migration).toContain("v_retirement_impact->>'assessmentDigest'");
    expect(migration).toContain("v_retirement_impact#>>'{reservation,token}'");
    expect(migration).toContain("v_retirement_impact#>'{reservation,version}'");
    expect(migration).toContain('then v_retirement_impact else null end');
    expect(migration).not.toContain("v_retirement_impact->>'reservationToken'");
  });
});
