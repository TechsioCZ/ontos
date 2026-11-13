-- Custom SQL migration file, put your code below! --
-- C17 phase 2 (#1157, plan D-P4): the workload-only provider binding route Read resolves a route key inside the
-- caller's Tenant. That Read has no Legal Entity scope (legalEntityScope 'forbidden': the Legal Entity is its
-- answer), while binding rows are Legal Entity scoped under RLS, so the route's binding identity (pab_ ref) and
-- status are read here, for exactly the Tenant the transaction is scoped to and only without a Legal Entity scope.
CREATE FUNCTION payment.psp_resolve_binding_route(p_tenant_id uuid, p_route_key text)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR nullif(current_setting('ontos.legal_entity_id', true), '') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Payment binding route resolution requires exactly a Tenant scope';
  END IF;
  RETURN QUERY
  SELECT jsonb_build_object(
    'bindingId', route.binding_id,
    'bindingRef', binding.provider_account_ref,
    'bindingStatus', binding.status,
    'environment', route.environment,
    'legalEntityId', route.legal_entity_id,
    'providerFamily', route.provider_family,
    'routeRevision', route.route_revision,
    'tenantId', route.tenant_id
  )
  FROM payment.psp_binding_routes AS route
  JOIN payment.psp_provider_account_bindings AS binding
    ON binding.tenant_id = route.tenant_id AND binding.legal_entity_id = route.legal_entity_id
    AND binding.binding_id = route.binding_id AND binding.provider_family = route.provider_family
    AND binding.environment = route.environment
  WHERE route.tenant_id = p_tenant_id AND route.route_key = p_route_key;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payment.psp_resolve_binding_route(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payment.psp_resolve_binding_route(uuid, text) TO ontos_runtime;
