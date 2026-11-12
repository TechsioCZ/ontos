CREATE INDEX "access_scope_fences_held_ix" ON "core"."access_scope_fences" ("lease_expires_at") WHERE "state" = 'Changing';--> statement-breakpoint
-- The access fence sweeper runs as ontos_runtime without a tenant until it knows which tenants need it. This is its
-- only cross-tenant read: the ids of tenants whose access fence is held by an operation whose hold has lapsed (its
-- lease expired, or, for a hold taken before leases existed, its journal idle for longer than p_pre_lease_idle),
-- never any intent. The sweeper then reconciles each of them under that tenant's own scope.
CREATE FUNCTION "core"."lapsed_access_fence_tenants"(p_limit integer, p_pre_lease_idle interval)
RETURNS TABLE (tenant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 100);
BEGIN
  IF NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'core.lapsed_access_fence_tenants must be owned by a role that bypasses row level security';
  END IF;
  IF p_pre_lease_idle IS NULL OR p_pre_lease_idle < interval '0' THEN
    RAISE EXCEPTION 'core.lapsed_access_fence_tenants needs a non-negative pre-lease idle time' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT DISTINCT f.tenant_id
      FROM core.access_scope_fences AS f
     WHERE f.state = 'Changing'
       AND coalesce(
             f.lease_expires_at,
             (SELECT j.updated_at + p_pre_lease_idle
                FROM core.access_operation_journals AS j
               WHERE j.tenant_id = f.tenant_id AND j.operation_id = f.owning_operation_id)
           ) < pg_catalog.now()
     LIMIT v_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "core"."lapsed_access_fence_tenants"(integer, interval) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontos_runtime') THEN
    GRANT EXECUTE ON FUNCTION "core"."lapsed_access_fence_tenants"(integer, interval) TO ontos_runtime;
  END IF;
END $$;
