import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

const readMigration = (folder: string) =>
  readFileSync(new URL(`../../drizzle/${folder}/migration.sql`, import.meta.url), 'utf-8');

it('adds optional canonical evidence without fabricating values for legacy assignments', () => {
  const migration = readMigration('20260923112451_store-canonical-price-group-compatibility-evidence');
  for (const column of [
    'definition_revision_id',
    'meaning_fingerprint',
    'definition_effective_from',
    'definition_effective_to',
    'compatibility_trusted_at',
    'compatibility_verified_at',
  ]) {
    expect(migration).toContain(`ADD COLUMN "${column}"`);
  }
  expect(migration).toContain('ccc_price_assignments_canonical_evidence_ck');
  expect(migration).not.toMatch(/UPDATE "commerce_customer_context"\."customer_price_group_assignments"/u);
  expect(migration).not.toMatch(/gen_random_uuid|digest\(/u);
});

it('binds exact evidence through governed owner routines without replacing closed assignment routines', () => {
  const migration = readMigration('20260923112506_refresh-price-group-canonical-evidence-routines');
  for (const routine of [
    'read_price_group_assignment_compatibility_evidence',
    'bind_price_group_assignment_compatibility_evidence',
  ]) {
    expect(migration).toContain(`CREATE FUNCTION "commerce_customer_context"."${routine}"`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION "commerce_customer_context"."${routine}"`);
  }
  expect(migration).toMatch(/SECURITY DEFINER/gu);
  expect(migration).toMatch(/SET search_path = pg_catalog, commerce_customer_context/gu);
  expect(migration).toMatch(/current_setting\('ontos\.tenant_id'/u);
  expect(migration).toMatch(/current_setting\('ontos\.legal_entity_id'/u);
  expect(migration).toContain("THEN 'LEGACY'");
  expect(migration).toContain("THEN 'FOUND'");
  expect(migration).toContain("ELSE 'CORRUPT'");
  expect(migration).toContain('OR v_assignment.compatibility_verified_at IS DISTINCT FROM p_compatibility_verified_at');
  expect(migration).not.toContain('CREATE OR REPLACE FUNCTION "commerce_customer_context"."assign_price_group"');
  expect(migration).not.toContain(
    'CREATE OR REPLACE FUNCTION "commerce_customer_context"."migrate_price_group_assignments"',
  );
});

it('upgrades the governed binder to preserve the first verification observation on retry', () => {
  const migration = readMigration('20260923122130_make-price-group-evidence-verification-replay-idempotent');
  expect(migration).toContain(
    'CREATE OR REPLACE FUNCTION "commerce_customer_context"."bind_price_group_assignment_compatibility_evidence"',
  );
  expect(migration).not.toContain(
    'OR v_assignment.compatibility_verified_at IS DISTINCT FROM p_compatibility_verified_at',
  );
  expect(migration).toContain('v_assignment.compatibility_verified_at;');
  expect(migration).toContain(
    'GRANT EXECUTE ON FUNCTION "commerce_customer_context"."bind_price_group_assignment_compatibility_evidence"',
  );
});
