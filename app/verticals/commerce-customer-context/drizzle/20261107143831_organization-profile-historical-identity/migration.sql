CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_profile_organization_business_facts(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $routine$
DECLARE
  v_counterparty_resource_id text;
  v_profile_revision integer;
  v_profile_state text;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  SELECT cp.counterparty_resource_id, p.revision, p.lifecycle
    INTO v_counterparty_resource_id, v_profile_revision, v_profile_state
    FROM commerce_customer_context.customer_profiles p
    JOIN commerce_customer_context.counterparty_purchasing_profiles cp
      ON cp.tenant_id = p.tenant_id
     AND cp.counterparty_purchasing_profile_id = p.customer_profile_id
   WHERE p.tenant_id = p_tenant_id
     AND p.customer_profile_id = p_profile_id
     AND p.legal_entity_id = p_legal_entity_id
     AND cp.legal_entity_id = p_legal_entity_id
     AND p.profile_kind = 'COUNTERPARTY'
     AND p.lifecycle IN ('ACTIVE','SUSPENDED','ARCHIVED')
     AND NOT EXISTS (
       SELECT 1 FROM commerce_customer_context.profile_reconciliation_case_members m
       JOIN commerce_customer_context.profile_reconciliation_cases c
         USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
       WHERE m.tenant_id = p_tenant_id
         AND m.customer_profile_id = p_profile_id
         AND c.lifecycle <> 'COMPLETED'
     )
;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_ADMISSIBLE', NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'CURRENT_HISTORICAL_IDENTITY', jsonb_build_object(
    'counterpartyResourceId', v_counterparty_resource_id,
    'profileRevision', v_profile_revision,
    'profileState', v_profile_state
  );
END;
$routine$;
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_profile_organization_business_facts(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_profile_organization_business_facts(uuid,uuid,uuid) TO ontos_runtime;
