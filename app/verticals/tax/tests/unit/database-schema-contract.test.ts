import { NodeFileSystem } from '@effect/platform-node';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';
import { Array as EffectArray, Effect, FileSystem, Order } from 'effect';
import {
  TAX_SCHEMA_NAME,
  TAX_TABLES,
  TAX_TABLE_INVENTORY,
  taxOrderTaxFinalizations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';

const migrationRoot = new URL('../../drizzle/', import.meta.url);

/** Every checked-in migration's SQL, in migration order. */
const migrations = Effect.gen(function* readTaxMigrations() {
  const fileSystem = yield* FileSystem.FileSystem;
  const folders = EffectArray.sort(yield* fileSystem.readDirectory(migrationRoot.pathname), Order.String);
  const sources = yield* Effect.forEach((folder: string) =>
    fileSystem.readFileString(new URL(`${folder}/migration.sql`, migrationRoot).pathname),
  )(folders);
  return sources.join('\n');
});

const columnNames = (table: (typeof TAX_TABLES)[number]) => getTableConfig(table).columns.map(({ name }) => name);
const uniqueColumns = (table: (typeof TAX_TABLES)[number]) =>
  getTableConfig(table).uniqueConstraints.map((constraint) => constraint.columns.map(({ name }) => name).join(','));

/** `tax_seller_vat_regime_declarations` is merchant-attributed, not Core-governance-attributed (F2-F4); it has no
 * `provenance_ref` and its `reason` is nullable (backdated effect only), so it is exempt from the generic
 * governance-attribution shape checked below. */
const GOVERNANCE_ATTRIBUTED_TABLES = TAX_TABLES.filter((table) => table !== taxSellerVatRegimeDeclarations);

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
    // Core invocation identity is unique per row.
    expect(
      uniqueColumns(table).some((columns) => columns.startsWith('tenant_id,idempotency_key')),
      `${config.name} idempotency`,
    ).toBe(true);
  }
  for (const table of GOVERNANCE_ATTRIBUTED_TABLES) {
    const config = getTableConfig(table);
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
  }
});

it.layer(NodeFileSystem.layer)('TAX migrations as checked in', (suite) => {
  suite.effect(
    'models immutable revisions, end facts and correction provenance without technical-order selectors',
    () =>
      Effect.gen(function* revisionsAndProvenance() {
        expect(uniqueColumns(taxRuleRevisions)).toContain('tenant_id,tax_rule_id,revision_number');
        expect(columnNames(taxRuleRevisions)).toEqual(
          expect.arrayContaining(['effective_from', 'effective_to', 'rate_percent', 'semantic_fingerprint']),
        );
        expect(columnNames(taxRuleRevisions)).not.toContain('created_at');
        expect(columnNames(taxRuleRevisions)).not.toContain('updated_at');
        expect(uniqueColumns(taxRuleRevisionEndFacts)).toContain('tenant_id,tax_rule_revision_id');
        expect(uniqueColumns(taxRuleCorrections)).toContain('tenant_id,wrong_revision_id,correcting_revision_id');
        const sql = yield* migrations;
        expect(sql).toContain('CREATE SCHEMA "tax"');
        expect(sql).toContain('GRANT USAGE ON SCHEMA "tax" TO "ontos_runtime"');
        expect(sql).toContain(
          '"tax_rule_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")',
        );
        for (const name of TAX_TABLE_INVENTORY) {
          expect(sql).toContain(`ALTER TABLE "tax"."${name}" FORCE ROW LEVEL SECURITY`);
          expect(sql).toContain(`CREATE TRIGGER "${name}_append_only" BEFORE UPDATE OR DELETE ON "tax"."${name}"`);
        }
      }),
  );

  suite.effect('#907 Unit 10 stores merchant-declared, append-only Seller VAT Regime revisions, never verified', () =>
    Effect.gen(function* sellerVatRegimeDeclarations() {
      expect(columnNames(taxSellerVatRegimeDeclarations)).toEqual(
        expect.arrayContaining([
          'revision',
          'regime',
          'effective_from',
          'recorded_at',
          'actor_principal_id',
          'reason',
          'provenance',
          'replaces_scheduled',
          'action_invocation_id',
          'idempotency_key',
          'intent_fingerprint',
        ]),
      );
      // Not the shared `attribution()` shape: no `provenance_ref`, and `recorded_at` has no DB default (F2, F4).
      expect(columnNames(taxSellerVatRegimeDeclarations)).not.toContain('provenance_ref');
      expect(
        getTableConfig(taxSellerVatRegimeDeclarations).columns.find((column) => column.name === 'recorded_at')
          ?.hasDefault,
      ).toBe(false);
      expect(
        getTableConfig(taxSellerVatRegimeDeclarations).columns.find((column) => column.name === 'reason')?.notNull,
      ).toBe(false);
      expect(uniqueColumns(taxSellerVatRegimeDeclarations)).toContain('tenant_id,legal_entity_id,revision');
      const sql = yield* migrations;
      expect(sql).toContain(
        '"tax_seller_vat_regime_declarations_regime_ck" CHECK ("regime" in (\'VAT_PAYER\', \'NON_PAYER\'))',
      );
      expect(sql).toContain(
        '"tax_seller_vat_regime_declarations_provenance_ck" CHECK ("provenance" in (\'MERCHANT_DECLARED\', \'MIGRATED\'))',
      );
      expect(sql).toContain('"tax_seller_vat_regime_declarations_backdating_reason_ck"');
      // The four retired authority/source-assertion tables are gone from the catalog, dropped in this migration.
      expect(sql).toContain('DROP TABLE "tax"."tax_fact_authority_contract_revisions"');
      expect(sql).toContain('DROP TABLE "tax"."tax_fact_authority_contracts"');
      expect(sql).toContain('DROP TABLE "tax"."tax_source_assertions"');
      expect(sql).toContain('DROP TABLE "tax"."tax_source_conflicts"');
    }),
  );

  suite.effect('#944 F10-F13 stores one immutable final Order Tax per submission with its T and frozen intent', () =>
    Effect.gen(function* finalOrderTaxStorage() {
      expect(uniqueColumns(taxOrderTaxFinalizations)).toContain('tenant_id,legal_entity_id,submission_ref');
      expect(columnNames(taxOrderTaxFinalizations)).toEqual(
        expect.arrayContaining([
          'order_commitment_time',
          'tax_evaluation_time',
          'intent_fingerprint',
          'decision_id',
          'outcome',
          'evidence',
          'governing_rule_revisions',
        ]),
      );
      // The customer-safe projection is recomputed, never stored as a second truth (#940 F19).
      expect(columnNames(taxOrderTaxFinalizations)).not.toContain('customer_safe');
      expect(yield* migrations).toContain(
        '"tax_order_tax_finalizations_times_ck" CHECK ("order_commitment_time" <= "tax_evaluation_time")',
      );
    }),
  );
});
