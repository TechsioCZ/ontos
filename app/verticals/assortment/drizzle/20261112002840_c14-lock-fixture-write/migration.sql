REVOKE ALL ON TABLE "assortment"."c14_rule_fixture_permits" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
ALTER FUNCTION "assortment"."import_c14_rule_fixture"(uuid,uuid,uuid,uuid,uuid,uuid,jsonb)
  RENAME TO "write_c14_rule_fixture";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "assortment"."write_c14_rule_fixture"(uuid,uuid,uuid,uuid,uuid,uuid,jsonb)
  FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "assortment"."import_c14_rule_fixture"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid,
  p_source_admission_id uuid,
  p_source_principal_id uuid,
  p_permit uuid,
  p_fixture jsonb
)
RETURNS TABLE(binding_id uuid, revision_id uuid, rule_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $$
BEGIN
  IF p_tenant_id::text IS DISTINCT FROM pg_catalog.current_setting('ontos.tenant_id', true)
      OR p_legal_entity_id::text IS DISTINCT FROM pg_catalog.current_setting('ontos.legal_entity_id', true)
      OR trust.lock_source_execution_fence(p_tenant_id, p_source_admission_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Assortment fixture operation scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
        SELECT FROM "assortment"."c14_rule_fixture_permits" AS permit
        WHERE permit.tenant_id = p_tenant_id
          AND permit.legal_entity_id = p_legal_entity_id
          AND permit.principal_id = p_actor_principal_id
          AND permit.source_principal_id = p_source_principal_id
          AND permit.permit_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_permit::text, 'UTF8')), 'hex')
          AND permit.command_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_fixture::text, 'UTF8')), 'hex')
        FOR SHARE
      ) THEN
    RAISE EXCEPTION 'Assortment fixture operation scope mismatch' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT written.binding_id, written.revision_id, written.rule_id
    FROM "assortment"."write_c14_rule_fixture"(
      p_tenant_id, p_legal_entity_id, p_action_invocation_id, p_actor_principal_id,
      p_source_admission_id, p_source_principal_id, p_fixture
    ) AS written;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "assortment"."import_c14_rule_fixture"(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "assortment"."import_c14_rule_fixture"(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb)
  TO "ontos_runtime";
