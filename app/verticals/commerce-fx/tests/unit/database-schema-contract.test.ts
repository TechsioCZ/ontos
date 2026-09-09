// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in generated SQL; expires: 2027-03-31.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  COMMERCE_FX_SCHEMA_NAME,
  COMMERCE_FX_TABLE_INVENTORY,
  COMMERCE_FX_TABLES,
  manualRatePolicyHeads,
  manualRatePolicyRevisions,
} from '../../src/database/schema.ts';

const migrationRoot = new URL('../../drizzle/', import.meta.url);
const migrationSql = (): string =>
  readdirSync(migrationRoot)
    .map((folder) => readFileSync(new URL(`${folder}/migration.sql`, migrationRoot), 'utf-8'))
    .join('\n');

it('owns exactly three legal-entity-scoped Commerce FX policy tables', () => {
  const actual = COMMERCE_FX_TABLES.map((table) => {
    const config = getTableConfig(table);
    return `${config.schema}.${config.name}`;
  });
  expect(COMMERCE_FX_SCHEMA_NAME).toBe('commerce_fx');
  expect(new Set(actual)).toEqual(
    new Set(COMMERCE_FX_TABLE_INVENTORY.map((name) => `commerce_fx.${name}`)),
  );
});

it('requires tenant and Selling Legal Entity scope with enabled policy shape', () => {
  for (const table of COMMERCE_FX_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(true);
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
  }
});

it('stores exact decimal text, immutable source revision, and complete context identity', () => {
  const heads = getTableConfig(manualRatePolicyHeads);
  const revisions = getTableConfig(manualRatePolicyRevisions);
  expect(heads.uniqueConstraints.map(({ name }) => name)).toContain(
    'commerce_fx_manual_heads_context_uk',
  );
  expect(revisions.columns.find(({ name }) => name === 'rate')?.getSQLType()).toBe('text');
  expect(revisions.columns.find(({ name }) => name === 'arithmetic_version')?.getSQLType()).toBe(
    'text',
  );
  expect(revisions.columns.find(({ name }) => name === 'rounding_increment')?.getSQLType()).toBe(
    'text',
  );
  expect(
    revisions.columns.find(({ name }) => name === 'rounding_rule_revision')?.getSQLType(),
  ).toBe('text');
  expect(revisions.uniqueConstraints.map(({ name }) => name)).toContain(
    'commerce_fx_manual_revisions_source_uk',
  );
  expect(revisions.checks.map(({ name }) => name)).toContain(
    'commerce_fx_manual_revisions_set_shape_ck',
  );
});

it('checks in forced RLS, append-only evidence, CAS locking, and exact routine grants', () => {
  const sql = migrationSql();
  for (const table of COMMERCE_FX_TABLE_INVENTORY) {
    expect(sql).toContain(`ALTER TABLE "commerce_fx"."${table}" FORCE ROW LEVEL SECURITY`);
  }
  expect(sql).toContain('commerce_fx_manual_revisions_append_only');
  expect(sql).toContain('commerce_fx_manual_journal_append_only');
  expect(sql).toContain('commerce_fx_manual_head_identity_immutable');
  expect(sql).toContain('FOR UPDATE');
  expect(sql).toContain('ON CONFLICT ON CONSTRAINT commerce_fx_manual_heads_context_uk DO NOTHING');
  expect(sql).toContain('v_head.current_revision <> v_expected_revision');
  expect(sql).toContain("revision.source_revision = v_change->>'sourceRevision'");
  expect(sql).toContain('ORDER BY revision.effective_from DESC, revision.revision DESC');
  expect(sql).toContain('Expiry never');
  expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_fx"');
  for (const routine of [
    'change_manual_rate_policy',
    'resolve_manual_rate_policy',
    'read_manual_rate_policy_revision',
  ]) {
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION "commerce_fx"."${routine}"`);
  }
  expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON\s+(?:TABLE\s+)?/iu);
});
