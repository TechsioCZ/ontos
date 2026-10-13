-- Owner-local routines for the billing Outbox Worker. The worker never receives a database executor;
-- Core invokes these through the verified, lifetime-bound Legal Entity scope.
CREATE FUNCTION "siampark_billing_finance"."read_finance_state_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid
) RETURNS TABLE(revision integer, state jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT finance.revision, finance.state
  FROM "siampark_billing_finance"."finance_states" AS finance
  WHERE p_tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND p_legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
    AND finance.tenant_id = p_tenant_id
    AND finance.legal_entity_id = p_legal_entity_id;
$$;
--> statement-breakpoint
CREATE FUNCTION "siampark_billing_finance"."save_finance_state_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_expected_revision integer,
  p_state jsonb
) RETURNS TABLE(revision integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Finance worker scope mismatch';
  END IF;

  RETURN QUERY
  UPDATE "siampark_billing_finance"."finance_states" AS finance
  SET revision = p_expected_revision + 1,
    state = p_state,
    updated_at = pg_catalog.clock_timestamp()
  WHERE finance.tenant_id = p_tenant_id
    AND finance.legal_entity_id = p_legal_entity_id
    AND finance.revision = p_expected_revision
  RETURNING finance.revision;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "siampark_billing_finance"."read_finance_state_for_worker"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "siampark_billing_finance"."save_finance_state_for_worker"(uuid, uuid, integer, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "siampark_billing_finance"."read_finance_state_for_worker"(uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "siampark_billing_finance"."save_finance_state_for_worker"(uuid, uuid, integer, jsonb) TO "ontos_runtime";
