CREATE FUNCTION commerce_customer_context.assign_organization_price_group(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_price_group_module_id text,
  p_price_group_resource_type text,
  p_price_group_resource_id text,
  p_catalog_revision integer,
  p_compatibility_contract_id text,
  p_compatibility_contract_revision integer,
  p_definition_revision integer,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_expected_profile_revision integer,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  changed boolean,
  replaced_assignment_id text,
  profile_state text,
  assignment_id text,
  price_group_module_id text,
  price_group_resource_type text,
  price_group_resource_id text,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  effective_from timestamptz,
  effective_to timestamptz,
  lifecycle text,
  revision integer,
  reason text,
  recorded_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
BEGIN
  IF p_profile_kind IS DISTINCT FROM 'COUNTERPARTY' OR p_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Only the explicit nonpersonal Counterparty assignment is accepted'
      USING ERRCODE = '23514';
  END IF;
  RETURN QUERY SELECT
    assigned.outcome,
    assigned.changed,
    assigned.replaced_assignment_id,
    assigned.profile_state,
    assigned.assignment_id,
    assigned.price_group_module_id,
    assigned.price_group_resource_type,
    assigned.price_group_resource_id,
    assigned.catalog_revision,
    assigned.compatibility_contract_id,
    assigned.compatibility_contract_revision,
    assigned.definition_revision,
    assigned.effective_from,
    assigned.effective_to,
    assigned.lifecycle,
    assigned.revision,
    NULL::text AS reason,
    assigned.recorded_at
  FROM commerce_customer_context.assign_price_group(
    p_tenant_id, p_legal_entity_id, p_profile_id, p_profile_kind, p_counterparty_resource_id, p_price_group_module_id, p_price_group_resource_type, p_price_group_resource_id, p_catalog_revision, p_compatibility_contract_id, p_compatibility_contract_revision, p_definition_revision, p_effective_from, p_effective_to, p_expected_profile_revision, p_reason, p_recorded_at, p_actor_principal_id, p_action_invocation_id
  ) AS assigned;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.assign_organization_price_group(uuid,uuid,text,text,text,text,text,text,integer,text,integer,integer,timestamptz,timestamptz,integer,text,timestamptz,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.assign_organization_price_group(uuid,uuid,text,text,text,text,text,text,integer,text,integer,integer,timestamptz,timestamptz,integer,text,timestamptz,uuid,uuid) TO ontos_runtime;
