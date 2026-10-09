// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import { pricingCommitmentConfirmations, PRICING_TABLE_INVENTORY } from '../../src/database/schema.ts';

const migration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928103000_pricing_commitment_confirmations_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);

describe('Pricing Commitment Confirmation database contract (#788)', () => {
  it('owns one append-only Tenant and legal-entity scoped immutable proof table', () => {
    const config = getTableConfig(pricingCommitmentConfirmations);

    expect(PRICING_TABLE_INVENTORY).toContain('pricing_commitment_confirmations');
    expect(getTableName(pricingCommitmentConfirmations)).toBe('pricing_commitment_confirmations');
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map(({ name }) => name)).toEqual([
      'confirmation_id',
      'tenant_id',
      'legal_entity_id',
      'confirmation_ref',
      'attempt_ref',
      'decision_bundle_ref',
      'decision_bundle_hash',
      'decision_bundle_version',
      'source_kind',
      'quotation_ref',
      'issued_at',
      'expires_at',
      'confirmation',
      'payload_digest',
      'proof_ref',
      'recorded_at',
    ]);
    expect(config.uniqueConstraints.map(({ name }) => name)).toEqual([
      'pricing_commitment_confirmations_scope_ref_uk',
      'pricing_commitment_confirmations_scope_proof_uk',
    ]);
    expect(config.policies.map(({ name }) => name)).toEqual([
      'pricing_commitment_confirmations_scope_select',
      'pricing_commitment_confirmations_scope_insert',
      'pricing_commitment_confirmations_scope_update',
      'pricing_commitment_confirmations_scope_delete',
    ]);
  });

  it('binds exact Attempt, Bundle, source path, interval, digest, and proof reference', () => {
    expect(migration).toContain('"attempt_ref" text NOT NULL');
    expect(migration).toContain('"decision_bundle_hash" text NOT NULL');
    expect(migration).toContain('"decision_bundle_version" text NOT NULL');
    expect(migration).toContain('"source_kind" text NOT NULL');
    expect(migration).toContain('"payload_digest" text NOT NULL');
    expect(migration).toContain('"proof_ref" text NOT NULL');
    expect(migration).toContain("'CURRENT_BACKED', 'QUOTATION_BACKED'");
    expect(migration).toContain("interval '30 seconds'");
    expect(migration).toContain("p_input #>> '{binding,purchase,tenantId}'");
    expect(migration).toContain("p_input #>> '{binding,purchase,commercialScope,sellingLegalEntityId}'");
    expect(migration).toContain("p_input #>> '{source,quotationRevalidation,quotation,quotationRef}'");
  });

  it('forbids mutation and grants only insert, recovery, and two scoped routines', () => {
    expect(migration).toContain('ALTER TABLE "pricing"."pricing_commitment_confirmations" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain(
      'GRANT INSERT, SELECT ON TABLE "pricing"."pricing_commitment_confirmations" TO "ontos_runtime"',
    );
    expect(migration).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*pricing_commitment_confirmations/iu);
    expect(migration).toContain('pricing_commitment_confirmations_scope_update');
    expect(migration).toContain('USING (false) WITH CHECK (false)');
    expect(migration).toContain('pricing_commitment_confirmations_scope_delete');
    expect(migration).toContain('USING (false)');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION pricing.persist_pricing_commitment_confirmation_v1(uuid, uuid, jsonb) TO ontos_runtime',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION pricing.read_pricing_commitment_confirmation_v1(uuid, uuid, text) TO ontos_runtime',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION pricing.persist_pricing_commitment_confirmation_v1(uuid, uuid, jsonb) FROM PUBLIC',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION pricing.read_pricing_commitment_confirmation_v1(uuid, uuid, text) FROM PUBLIC',
    );
  });

  it('persists retries idempotently but never extends or replaces an issued row', () => {
    expect(migration).toContain('ON CONFLICT DO NOTHING');
    expect(migration).toContain("'outcome', 'REUSED'");
    expect(migration).toContain("'outcome', 'IDENTITY_CONFLICT'");
    expect(migration).not.toMatch(/UPDATE\s+pricing\.pricing_commitment_confirmations/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+pricing\.pricing_commitment_confirmations/iu);
    expect(migration).not.toMatch(/SET\s+expires_at/iu);
  });
});
