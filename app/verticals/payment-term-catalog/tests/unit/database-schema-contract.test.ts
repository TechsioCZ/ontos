// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in generated SQL; expires: 2026-12-31.
import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { readdirSync, readFileSync } from 'node:fs';
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
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(
      true,
    );
    expect(
      config.columns.some((column) => column.name === 'legal_entity_id' && column.notNull),
    ).toBe(true);
    expect(config.policies.map((policy) => policy.for)).toEqual([
      'select',
      'insert',
      'update',
      'delete',
    ]);
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
    revisions.uniqueConstraints.some(
      (constraint) => constraint.name === 'payment_term_catalog_revisions_number_uk',
    ),
  ).toBe(true);
  expect(revisions.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'payment_term_catalog_revisions_term_fk',
  );
  expect(revisions.indexes.map((index) => index.config.name)).toContain(
    'payment_term_catalog_revisions_semantics_idx',
  );
  expect(revisions.columns.find(({ name }) => name === 'net_days')?.getSQLType()).toBe('bigint');
  expect(
    revisions.columns.some((column) => column.name === 'semantic_revision_id' && column.notNull),
  ).toBe(true);
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

it('checks in generated migration history plus explicit force-RLS and append-only guards', () => {
  const migrationRoot = new URL('../../drizzle/', import.meta.url);
  const folders = EffectArray.sort(readdirSync(migrationRoot), Order.String);
  expect(folders.length).toBeGreaterThanOrEqual(2);
  const sqlFiles = folders.map((folder) =>
    readFileSync(new URL(`${folder}/migration.sql`, migrationRoot), 'utf-8'),
  );
  const combined = sqlFiles.join('\n');
  for (const table of PAYMENT_TERM_CATALOG_TABLE_INVENTORY) {
    expect(combined).toContain(
      `ALTER TABLE "payment_term_catalog"."${table}" FORCE ROW LEVEL SECURITY`,
    );
  }
  expect(combined).toContain('payment_term_revisions_append_only');
  expect(combined).toContain('payment_term_lifecycle_events_append_only');
  expect(combined).toContain('payment_term_aliases_append_only');
  expect(combined).toContain('payment_terms_identity_immutable');
  expect(combined).toContain('CREATE UNIQUE INDEX "payment_term_catalog_revisions_semantics_uk"');
  expect(combined).toContain(
    'DROP INDEX "payment_term_catalog"."payment_term_catalog_revisions_semantics_uk"',
  );
  expect(combined).toContain('CREATE INDEX "payment_term_catalog_revisions_semantics_idx"');
  expect(
    sqlFiles.some(
      (migration) =>
        migration.includes('DROP CONSTRAINT "payment_term_catalog_revisions_semantics_ck"') &&
        migration.includes('"net_days" between 0 and 9007199254740991'),
    ),
  ).toBe(true);
  expect(combined).toContain(
    '"net_days" is not null and "net_days" between 0 and 9007199254740991',
  );
  expect(combined).toContain(
    '"retirement_reason" is not null and "retirement_reason" = btrim("retirement_reason")',
  );
  expect(combined).toContain(
    "v_net_days bigint := CASE WHEN p_input->'semantics'->>'kind' = 'NET_DAYS'",
  );
});

it('hardens governed routines against concurrent conflicts, alias corruption, and page loss', () => {
  const migrationRoot = new URL('../../drizzle/', import.meta.url);
  const hardeningFolder = readdirSync(migrationRoot).find((folder) =>
    folder.endsWith('_harden-governed-payment-term-routines'),
  );
  expect(hardeningFolder).toBeDefined();
  const hardening = readFileSync(
    new URL(`${hardeningFolder}/migration.sql`, migrationRoot),
    'utf-8',
  );

  expect(hardening).toContain("'payment-term-code|'");
  expect(hardening).toContain("'payment-term-semantics|'");
  expect(hardening).toContain("'payment-term-alias-graph|'");
  expect(hardening).toContain('canonical_payment_term_id = v_alias_id');
  expect(hardening).toContain('v_next_id = ANY(v_visited)');
  expect(hardening).toContain("'reason', 'cycle'");
  expect(hardening).toContain("'reason', 'depth_exceeded'");

  const activeFilter = hardening.indexOf('term.active_from <= p_at');
  const retirementFilter = hardening.indexOf('p_at < term.retired_effective_at');
  const pageLimit = hardening.indexOf('LIMIT greatest(1, least(p_limit, 200)) + 1');
  expect(activeFilter).toBeGreaterThan(-1);
  expect(retirementFilter).toBeGreaterThan(activeFilter);
  expect(pageLimit).toBeGreaterThan(retirementFilter);
});

it('bounds reconciliation fan-in and requires lifecycle-equivalent reference identities', () => {
  const migrationRoot = new URL('../../drizzle/', import.meta.url);
  const boundaryFolder = readdirSync(migrationRoot).find((folder) =>
    folder.endsWith('_bound-reconciliation-reference-safety'),
  );
  expect(boundaryFolder).toBeDefined();
  const boundary = readFileSync(new URL(`${boundaryFolder}/migration.sql`, migrationRoot), 'utf-8');

  expect(boundary).toContain('v_alias_term.active_from IS DISTINCT FROM');
  expect(boundary).toContain(
    'v_alias_term.retired_effective_at IS DISTINCT FROM v_canonical_term.retired_effective_at',
  );
  expect(boundary).toContain('canonical_payment_term_id = v_canonical_id');
  expect(boundary).toContain('v_inbound_alias_count >= 199');
  expect(boundary.indexOf('v_inbound_alias_count >= 199')).toBeLessThan(
    boundary.indexOf('INSERT INTO "payment_term_catalog"."payment_term_aliases"'),
  );
});

it('exposes only audited scope-bound SECURITY DEFINER routines to the runtime role', () => {
  const migrationRoot = new URL('../../drizzle/', import.meta.url);
  const combined = EffectArray.sort(readdirSync(migrationRoot), Order.String)
    .map((folder) => readFileSync(new URL(`${folder}/migration.sql`, migrationRoot), 'utf-8'))
    .join('\n');
  expect(combined).toContain(
    'REVOKE ALL ON ALL TABLES IN SCHEMA "payment_term_catalog" FROM "ontos_runtime"',
  );
  expect(combined).toContain(
    'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "payment_term_catalog" FROM "ontos_runtime"',
  );
  expect(combined).toContain('CREATE FUNCTION "payment_term_catalog"."assert_operation_scope"');
  expect(combined).toContain('SECURITY DEFINER');
  expect(combined).toContain("current_setting('ontos.tenant_id', true)");
  expect(combined).toContain("current_setting('ontos.legal_entity_id', true)");
  for (const routine of [
    'correct_term',
    'create_term',
    'get_current',
    'get_history',
    'list_current',
    'reconcile_term',
    'resolve_reference',
    'retire_term',
  ]) {
    expect(combined).toContain(`GRANT EXECUTE ON FUNCTION "payment_term_catalog"."${routine}"`);
  }
  expect(combined).not.toContain(
    'GRANT EXECUTE ON FUNCTION "payment_term_catalog"."definition_json"',
  );

  const verifier = readFileSync(
    new URL('../../scripts/verify-db-schema.mts', import.meta.url),
    'utf-8',
  );
  expect(verifier).toContain('bool_or(has_table_privilege');
  expect(verifier).toContain('routine.oid::regprocedure::text in');
  expect(verifier).toContain('routine.prosecdef');
  expect(verifier).toContain('routine.proconfig @>');
  expect(verifier).toContain('unexpected_runtime_routine_count === 0');
});
