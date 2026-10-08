// @effect-diagnostics nodeBuiltinImport:off -- Contract test reads checked-in generated SQL; expires: 2027-03-31.
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';
import { Array as EffectArray, Order } from 'effect';
import { readdirSync, readFileSync } from 'node:fs';
import {
  TAX_SCHEMA_NAME,
  TAX_TABLES,
  TAX_TABLE_INVENTORY,
  taxFactAuthorityContractRevisions,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
} from '../../src/database/schema.ts';

const migrationRoot = new URL('../../drizzle/', import.meta.url);
const migrations = () =>
  EffectArray.sort(readdirSync(migrationRoot), Order.String)
    .map((folder) => readFileSync(new URL(`${folder}/migration.sql`, migrationRoot), 'utf-8'))
    .join('\n');

const columnNames = (table: (typeof TAX_TABLES)[number]) => getTableConfig(table).columns.map(({ name }) => name);
const uniqueColumns = (table: (typeof TAX_TABLES)[number]) =>
  getTableConfig(table).uniqueConstraints.map((constraint) => constraint.columns.map(({ name }) => name).join(','));

it('owns only the private, tenant and Selling Legal Entity scoped TAX governance catalog', () => {
  const names = EffectArray.sort(
    TAX_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );
  expect(TAX_SCHEMA_NAME).toBe('tax');
  expect(names).toEqual(
    EffectArray.sort(
      TAX_TABLE_INVENTORY.map((name) => `tax.${name}`),
      Order.String,
    ),
  );
  for (const table of TAX_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} enables RLS`).toBe(true);
    expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
    expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(true);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    for (const column of [
      'action_invocation_id',
      'actor_principal_id',
      'idempotency_key',
      'provenance_ref',
      'reason',
    ]) {
      expect(
        config.columns.some(({ name, notNull }) => name === column && notNull),
        `${config.name}.${column}`,
      ).toBe(true);
    }
    expect(uniqueColumns(table)).toContain('tenant_id,idempotency_key');
  }
});

it('models immutable revisions, end facts and correction provenance without technical-order selectors', () => {
  expect(uniqueColumns(taxRuleRevisions)).toContain('tenant_id,tax_rule_id,revision_number');
  expect(columnNames(taxRuleRevisions)).toEqual(
    expect.arrayContaining(['effective_from', 'effective_to', 'rate_percent', 'semantic_fingerprint']),
  );
  expect(columnNames(taxRuleRevisions)).not.toContain('created_at');
  expect(columnNames(taxRuleRevisions)).not.toContain('updated_at');
  expect(uniqueColumns(taxRuleRevisionEndFacts)).toContain('tenant_id,tax_rule_revision_id');
  expect(uniqueColumns(taxRuleCorrections)).toContain('tenant_id,wrong_revision_id,correcting_revision_id');
  expect(columnNames(taxFactAuthorityContractRevisions)).toEqual(
    expect.arrayContaining(['system_of_record_ref', 'evidence_source_refs', 'authority_from', 'authority_to']),
  );
  const sql = migrations();
  expect(sql).toContain('CREATE SCHEMA "tax"');
  expect(sql).toContain('GRANT USAGE ON SCHEMA "tax" TO "ontos_runtime"');
  expect(sql).toContain(
    '"tax_rule_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")',
  );
  for (const name of TAX_TABLE_INVENTORY) {
    expect(sql).toContain(`ALTER TABLE "tax"."${name}" FORCE ROW LEVEL SECURITY`);
    expect(sql).toContain(`CREATE TRIGGER "${name}_append_only" BEFORE UPDATE OR DELETE ON "tax"."${name}"`);
  }
});
