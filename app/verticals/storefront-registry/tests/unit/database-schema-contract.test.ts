// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Storefront Registry SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';
import {
  STOREFRONT_REGISTRY_SCHEMA_NAME,
  STOREFRONT_REGISTRY_TABLE_INVENTORY,
  STOREFRONT_REGISTRY_TABLES,
  storefrontApplicationRevisions,
  storefrontApplications,
} from '../../src/database/schema.ts';

describe('Storefront Registry database contract', () => {
  it('owns only the tenant application identity, immutable revisions, and owner generation', () => {
    const qualified = STOREFRONT_REGISTRY_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }).toSorted();
    expect(STOREFRONT_REGISTRY_SCHEMA_NAME).toBe('storefront_registry');
    expect(qualified).toEqual(
      STOREFRONT_REGISTRY_TABLE_INVENTORY.map((name) => `storefront_registry.${name}`).toSorted(),
    );
    for (const table of STOREFRONT_REGISTRY_TABLES) {
      const config = getTableConfig(table);
      expect(config.enableRLS).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
    }
  });

  it('enforces tenant application identity, immutable revision numbering, lifecycle, channels, and intervals', () => {
    const application = getTableConfig(storefrontApplications);
    const revision = getTableConfig(storefrontApplicationRevisions);
    expect(application.uniqueConstraints.map(({ name }) => name)).toContain(
      'storefront_registry_applications_app_id_uk',
    );
    expect(revision.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'storefront_registry_revisions_number_uk',
        'storefront_registry_revisions_invocation_uk',
      ]),
    );
    expect(revision.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'storefront_registry_revisions_channels_ck',
        'storefront_registry_revisions_lifecycle_ck',
        'storefront_registry_revisions_period_ck',
      ]),
    );
    expect(revision.foreignKeys.map((key) => key.getName())).toContain('storefront_registry_revisions_application_fk');
  });

  it('publishes one least-privilege currentness routine over append-only history', () => {
    const migration = readFileSync(
      new URL('../../drizzle/20260922090000_storefront_registry_owner/migration.sql', import.meta.url),
      'utf-8',
    );
    expect(migration.match(/force row level security/gu)).toHaveLength(3);
    expect(migration).toContain('Storefront application revision history is append-only');
    expect(migration).toContain('storefront_registry.read_current_storefront_application');
    expect(migration).toContain('storefront_registry.register_storefront_application');
    expect(migration).toContain('storefront_registry.revise_storefront_application');
    expect(migration).toContain('for update');
    expect(migration).toContain("'_tag', 'revision_conflict'");
    expect(migration).toContain("v_current.lifecycle = 'RETIRED'");
    expect(migration).toContain(
      "p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid",
    );
    expect(migration).toContain('revoke all on all tables in schema storefront_registry from ontos_runtime');
    expect(migration).toContain(
      'grant execute on function storefront_registry.read_current_storefront_application(uuid, jsonb) to ontos_runtime',
    );
    expect(migration).toContain(
      'grant execute on function storefront_registry.register_storefront_application(uuid, jsonb) to ontos_runtime',
    );
    expect(migration).toContain(
      'grant execute on function storefront_registry.revise_storefront_application(uuid, jsonb) to ontos_runtime',
    );
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete)\s+on/iu);
  });
});
