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
  taxSourceAssertions,
  taxSourceConflicts,
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
    // Core invocation identity is unique per row; a conflict row is unique per invocation, kind and counterpart.
    expect(
      uniqueColumns(table).some((columns) => columns.startsWith('tenant_id,idempotency_key')),
      `${config.name} idempotency`,
    ).toBe(true);
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

it('#958 F1-F16 F21-F22 keeps provider, Source Record, assertion and fact identities and every time meaning distinct', () => {
  expect(columnNames(taxSourceAssertions)).toEqual(
    expect.arrayContaining([
      'source_ref',
      'source_record_ref',
      'source_assertion_key',
      'fact_family',
      'jurisdiction',
      'registration_meaning',
      'valid_from',
      'valid_to',
      'observed_at',
      'issued_at',
      'recorded_at',
      'semantic_fingerprint',
      'eligibility',
      'authority_role',
      'authority_contract_revision_id',
      'delivery_ref',
    ]),
  );
  // Canonical TAX semantics are never keyed on an adapter or route identity (#958 F22).
  expect(columnNames(taxSourceAssertions).filter((name) => /adapter|connector|route|payload/u.test(name))).toEqual([]);
  for (const name of ['valid_from', 'valid_to', 'observed_at', 'issued_at']) {
    expect(getTableConfig(taxSourceAssertions).columns.find((column) => column.name === name)?.notNull, name).toBe(
      false,
    );
  }
  expect(uniqueColumns(taxSourceAssertions)).toContain('tenant_id,legal_entity_id,source_ref,source_assertion_key');
  expect(uniqueColumns(taxSourceConflicts)).toContain('tenant_id,idempotency_key,conflict_kind,related_assertion_id');
  expect(columnNames(taxSourceAssertions)).not.toContain('updated_at');
  const sql = migrations();
  expect(sql).toContain('"tax_source_assertions_validity_ck" CHECK ("valid_from" is null or "valid_to" is null');
  expect(sql).toContain('"tax_source_conflicts_status_ck" CHECK ("status" = \'OPEN\')');
  // Only time-independent eligibility is stored; the #957 acceptance depends on the authority contracts and is
  // always evaluated, never stored (#959 F25).
  expect(sql).toContain(
    '"tax_source_assertions_eligibility_ck" CHECK ("eligibility" in (\'ELIGIBLE\', \'VALIDITY_UNKNOWN\'))',
  );
  expect(columnNames(taxSourceAssertions)).not.toContain('acceptance_outcome');
});
