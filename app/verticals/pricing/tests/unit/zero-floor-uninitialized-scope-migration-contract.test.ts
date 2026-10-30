// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'effect-rstest';

const readMigration = (directory: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${directory}/migration.sql`, import.meta.url)), 'utf-8');

const uninitializedScopeMigration = readMigration('20261024100000_pricing_zero_floor_uninitialized_scope_empty');
const nativePredicateBootstrapMigration = readMigration('20261019131009_zero_floor_native_predicate_bootstrap');
const proofResolutionMigration = readMigration('20260928110015_pricing_material_proof_resolution_v1');
const discountZeroFloorRuntimeMigration = readMigration('20260928110007_pricing_discount_zero_floor_runtime_v1');

const receiptedRead = 'pricing.read_current_zero_floor_authorization_set_v1';
const ensureHelper = 'pricing.ensure_zero_floor_set_v1';
const unreceiptedRead = 'pricing.read_current_zero_floor_authorization_set_unreceipted_v1';

const routineBody = (sql: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${receiptedRead}(`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start);
};

describe('ZERO_FLOOR uninitialized-scope Current-set migration contract', () => {
  it('replaces the receipted read in place with a fixed-search-path SECURITY DEFINER routine', () => {
    const routine = routineBody(uninitializedScopeMigration);

    expect(routine).toMatch(
      /CREATE OR REPLACE FUNCTION pricing\.read_current_zero_floor_authorization_set_v1\(\s*p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb\s*\)/u,
    );
    expect(routine).toMatch(/RETURNS TABLE\(payload jsonb\) LANGUAGE plpgsql VOLATILE SECURITY DEFINER/u);
    expect(routine).toMatch(/SET search_path = pg_catalog, pg_temp AS \$function\$/u);
    // A replace (not drop and create) keeps the owner and the reviewed ACL of the earlier migration.
    expect(uninitializedScopeMigration).not.toMatch(/DROP FUNCTION/iu);
    expect(uninitializedScopeMigration).not.toMatch(/\bCREATE FUNCTION\b/u);
  });

  it('keeps EXECUTE on the receipted read for ontos_runtime only, inherited from the reviewed ACL', () => {
    expect(proofResolutionMigration).toContain(
      `REVOKE ALL ON FUNCTION ${receiptedRead}(uuid, uuid, jsonb) FROM PUBLIC;`,
    );
    expect(proofResolutionMigration).toContain(
      `GRANT EXECUTE ON FUNCTION ${receiptedRead}(uuid, uuid, jsonb) TO ontos_runtime;`,
    );
    // The new migration must neither widen nor re-grant the runtime-facing ACL.
    expect(uninitializedScopeMigration).not.toMatch(/\bTO\s+PUBLIC\b/iu);
    expect(uninitializedScopeMigration).not.toMatch(/\bontos_runtime\b/u);
    expect(uninitializedScopeMigration).not.toMatch(/\bREVOKE\b/iu);
  });

  it('grants the otherwise runtime-revoked initializer only to the receipted read owner, never to the runtime role', () => {
    expect(discountZeroFloorRuntimeMigration).toContain(
      `REVOKE ALL ON FUNCTION ${ensureHelper}(uuid,uuid,text) FROM ontos_runtime;`,
    );
    const grants = uninitializedScopeMigration.match(/GRANT[^;]*;/gu) ?? [];

    expect(grants).toEqual([`GRANT EXECUTE ON FUNCTION ${ensureHelper}(uuid,uuid,text) TO %I', current_user);`]);
    expect(uninitializedScopeMigration).toContain(
      `EXECUTE format('GRANT EXECUTE ON FUNCTION ${ensureHelper}(uuid,uuid,text) TO %I', current_user);`,
    );
  });

  it('rejects a foreign tenant or legal entity before initializing or reading anything', () => {
    const routine = routineBody(uninitializedScopeMigration);
    const scopeGuard = routine.indexOf(
      "p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid",
    );
    const legalEntityGuard = routine.indexOf(
      "p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid",
    );
    const raise = routine.indexOf("RAISE EXCEPTION 'Zero Floor proof scope mismatch' USING ERRCODE = '42501'");
    const initialize = routine.indexOf(`PERFORM ${ensureHelper}(`);
    const read = routine.indexOf(unreceiptedRead);

    expect(scopeGuard).toBeGreaterThan(-1);
    expect(legalEntityGuard).toBeGreaterThan(scopeGuard);
    expect(raise).toBeGreaterThan(legalEntityGuard);
    expect(initialize).toBeGreaterThan(raise);
    expect(read).toBeGreaterThan(initialize);
  });

  it('initializes an uninitialized scope with the idempotent empty set through the owner routine', () => {
    const routine = routineBody(uninitializedScopeMigration);

    expect(routine).toMatch(
      /PERFORM pricing\.ensure_zero_floor_set_v1\(\s*p_tenant_id, p_legal_entity_id, 'internal:zero-floor-read-initialize:' \|\| gen_random_uuid\(\)::text\);/u,
    );
    // The ensure routine is the idempotent initializer used by every mutation; the read does not insert set rows itself.
    expect(routine).not.toMatch(/INSERT INTO pricing\.zero_floor_set_(?:roots|heads|revisions)/u);
    expect(routine).toMatch(
      /FROM pricing\.read_current_zero_floor_authorization_set_unreceipted_v1\(\s*p_tenant_id, p_legal_entity_id, p_input\) AS prior/u,
    );
    // A non-current outcome is returned verbatim and never receipted.
    const nonCurrent = routine.indexOf("IF v_payload ->> 'outcome' <> 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT' THEN");
    const receiptInsert = routine.indexOf('INSERT INTO pricing.material_evidence_proof_receipts');
    expect(nonCurrent).toBeGreaterThan(-1);
    expect(receiptInsert).toBeGreaterThan(nonCurrent);
    expect(routine.slice(nonCurrent, receiptInsert)).toContain('RETURN QUERY SELECT v_payload;');
  });

  it('still binds the receipt to the tenant-scoped owner observation and rejects a conflicting receipt', () => {
    const routine = routineBody(uninitializedScopeMigration);

    expect(routine).toContain(
      'ON CONFLICT (tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at) DO NOTHING',
    );
    expect(routine).toContain('receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id');
    expect(routine).toContain("receipt.family = 'ZERO_FLOOR'");
    expect(routine).toContain(
      "RAISE EXCEPTION 'Zero Floor proof receipt conflicts with owner read' USING ERRCODE = '23514'",
    );
    expect(routine).toContain("RAISE EXCEPTION 'Zero Floor owner observation is invalid' USING ERRCODE = '22023'");
  });
});

describe('ZERO_FLOOR for-query bootstrap entrypoint contract', () => {
  const forQuery = 'pricing.read_current_zero_floor_authorization_set_for_query_v1';

  it('is a fixed-search-path SECURITY INVOKER wrapper so tenant scope is enforced by the receipted read', () => {
    expect(nativePredicateBootstrapMigration).toMatch(
      /CREATE FUNCTION pricing\.read_current_zero_floor_authorization_set_for_query_v1\(\s*p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb\s*\)/u,
    );
    expect(nativePredicateBootstrapMigration).toMatch(/LANGUAGE plpgsql VOLATILE SECURITY INVOKER/u);
    expect(nativePredicateBootstrapMigration).not.toMatch(/SECURITY DEFINER/u);
    expect(nativePredicateBootstrapMigration).toMatch(/SET search_path = pg_catalog, pg_temp AS \$function\$/u);
    // It only delegates into the receipted SECURITY DEFINER read, passing the caller-supplied scope through unchanged.
    expect(nativePredicateBootstrapMigration).toMatch(
      /FROM pricing\.read_current_zero_floor_authorization_set_v1\(\s*p_tenant_id, p_legal_entity_id, jsonb_build_object\('query', v_query\)\)/u,
    );
  });

  it('grants EXECUTE to ontos_runtime only and revokes it from PUBLIC', () => {
    expect(nativePredicateBootstrapMigration.replaceAll(/\s+/gu, ' ')).toContain(
      `REVOKE ALL ON FUNCTION ${forQuery}(uuid,uuid,jsonb) FROM PUBLIC;`,
    );
    const grants = nativePredicateBootstrapMigration.match(/GRANT[^;]*;/gu) ?? [];

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/TO ontos_runtime;$/u);
    expect(nativePredicateBootstrapMigration).not.toMatch(/\bTO\s+PUBLIC\b/iu);
  });

  it('derives the exact predicate itself and refuses a supplied predicate or incomplete query', () => {
    expect(nativePredicateBootstrapMigration).toContain(
      "'exactPredicateRef', pricing.zero_floor_predicate_ref_v1(v_query)",
    );
    expect(nativePredicateBootstrapMigration).toContain("OR p_input - 'query' <> '{}'::jsonb");
    expect(nativePredicateBootstrapMigration).toContain("OR v_query - v_keys <> '{}'::jsonb");
    expect(nativePredicateBootstrapMigration).not.toContain("'exactPredicateRef',\n    'audienceRefs'");
    expect(nativePredicateBootstrapMigration).toContain(
      "RAISE EXCEPTION 'ZERO_FLOOR bootstrap requires one complete query without a supplied predicate'",
    );
  });
});
