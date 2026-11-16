-- The index blocks fence writes while it is built; like the lease migration, never wait long for the table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "access_scope_fences_held_ix" ON "core"."access_scope_fences" ("lease_expires_at") WHERE "state" = 'Changing';--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;--> statement-breakpoint
-- The access fence sweeper runs as ontos_runtime without a tenant until it knows which tenants need it. This is its
-- only cross-tenant read: the ids of tenants whose access fence is held by an operation whose hold has lapsed (its
-- lease expired, or, for a hold taken before leases existed, its journal idle for longer than p_pre_lease_idle; or
-- its operation failed before it sent the engine anything: fence_refused, intent_moved, intent_unavailable. Any other
-- failure keeps its lease, since an engine write it sent may still be under way),
-- never any intent. Oldest lapse first, without the tenants the sweeper is still backing off from (p_skip), so a
-- tenant that keeps failing can never hide the others behind the page limit. The sweeper then reconciles each of
-- them under that tenant's own scope.
CREATE FUNCTION "core"."lapsed_access_fence_tenants"(p_limit integer, p_pre_lease_idle interval, p_skip uuid[])
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
    SELECT held.tenant_id
      FROM (
        SELECT f.tenant_id,
               coalesce(
                 f.lease_expires_at,
                 (SELECT j.updated_at + p_pre_lease_idle
                    FROM core.access_operation_journals AS j
                   WHERE j.tenant_id = f.tenant_id AND j.operation_id = f.owning_operation_id)
               ) AS lapsed_at,
               EXISTS (
                 SELECT 1 FROM core.access_operation_journals AS j
                  WHERE j.tenant_id = f.tenant_id AND j.operation_id = f.owning_operation_id AND j.phase = 'failed'
                    AND j.failure_code IN ('fence_refused', 'intent_moved', 'intent_unavailable')
               ) AS holder_failed
          FROM core.access_scope_fences AS f
         WHERE f.state = 'Changing'
      ) AS held
     WHERE (held.lapsed_at < pg_catalog.now() OR held.holder_failed)
       AND NOT (held.tenant_id = ANY (coalesce(p_skip, '{}'::uuid[])))
     GROUP BY held.tenant_id
     ORDER BY min(held.lapsed_at), held.tenant_id
     LIMIT v_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "core"."lapsed_access_fence_tenants"(integer, interval, uuid[]) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontos_runtime') THEN
    GRANT EXECUTE ON FUNCTION "core"."lapsed_access_fence_tenants"(integer, interval, uuid[]) TO ontos_runtime;
  END IF;
END $$;
