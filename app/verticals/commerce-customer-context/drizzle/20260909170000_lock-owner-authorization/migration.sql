CREATE FUNCTION "commerce_customer_context"."lock_access_grant_authority"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid
)
RETURNS TABLE (
  counterparty_resource_id text,
  grant_id uuid,
  granted_at timestamptz,
  granted_by uuid,
  operation_outcome text,
  permission_code text,
  principal_id uuid,
  reason text,
  revision integer,
  revoked_at timestamptz,
  revoked_by uuid,
  state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT projection.*
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = grant_row.tenant_id
    AND profile.legal_entity_id = grant_row.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = grant_row.counterparty_purchasing_profile_id
  CROSS JOIN LATERAL commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, grant_row.counterparty_commerce_access_grant_id, NULL
  ) AS projection
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
    AND grant_row.principal_id = p_principal_id
  ORDER BY grant_row.recorded_at, grant_row.counterparty_commerce_access_grant_id
  FOR UPDATE OF grant_row;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."lock_access_grant_authority"(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."lock_access_grant_authority"(uuid, uuid, text, uuid) TO "ontos_runtime";
