CREATE TABLE "core"."source_execution_fences" (
	"tenant_id" uuid,
	"admission_invocation_id" uuid,
	"state" text NOT NULL,
	CONSTRAINT "source_execution_fences_pk" PRIMARY KEY("tenant_id","admission_invocation_id"),
	CONSTRAINT "source_execution_fences_state_ck" CHECK ("state" in ('open', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "core"."source_execution_fences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime callers never receive direct table privileges. Every entry checks the established tenant.
CREATE FUNCTION trust.open_source_execution_fence(p_tenant_id uuid, p_admission_id uuid)
RETURNS TABLE(allowed boolean) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid; v_state text;
BEGIN
v_tenant_id := trust.current_tenant_id();
  IF v_tenant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM trust.gateway_audience_roles a WHERE a.role_name = SESSION_USER) THEN
      RAISE EXCEPTION 'source execution fence requires established gateway scope' USING ERRCODE = '42501';
    END IF;
    v_tenant_id := nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid;
  END IF;
  IF v_tenant_id IS NULL OR v_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'source execution fence is outside current tenant scope' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.action_invocations i WHERE i.tenant_id=p_tenant_id AND i.action_invocation_id=p_admission_id AND i.status='running') THEN
    RETURN QUERY SELECT false; RETURN;
  END IF;
  INSERT INTO core.source_execution_fences(tenant_id,admission_invocation_id,state) VALUES(p_tenant_id,p_admission_id,'open') ON CONFLICT DO NOTHING;
  SELECT f.state INTO v_state FROM core.source_execution_fences f WHERE f.tenant_id=p_tenant_id AND f.admission_invocation_id=p_admission_id FOR SHARE;
  RETURN QUERY SELECT coalesce(v_state='open',false);
END $$;
--> statement-breakpoint
CREATE FUNCTION trust.cancel_source_execution_fence(p_tenant_id uuid, p_admission_id uuid)
RETURNS TABLE(allowed boolean) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid;
BEGIN
v_tenant_id := trust.current_tenant_id();
  IF v_tenant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM trust.gateway_audience_roles a WHERE a.role_name = SESSION_USER) THEN
      RAISE EXCEPTION 'source execution fence requires established gateway scope' USING ERRCODE = '42501';
    END IF;
    v_tenant_id := nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid;
  END IF;
  IF v_tenant_id IS NULL OR v_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'source execution fence is outside current tenant scope' USING ERRCODE = '42501';
  END IF;
  INSERT INTO core.source_execution_fences(tenant_id,admission_invocation_id,state) VALUES(p_tenant_id,p_admission_id,'cancelled')
  ON CONFLICT (tenant_id,admission_invocation_id) DO UPDATE SET state='cancelled';
  RETURN QUERY SELECT true;
END $$;
--> statement-breakpoint
CREATE FUNCTION trust.lock_source_execution_fence(p_tenant_id uuid, p_admission_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid; v_state text;
BEGIN
v_tenant_id := trust.current_tenant_id();
  IF v_tenant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM trust.gateway_audience_roles a WHERE a.role_name = SESSION_USER) THEN
      RAISE EXCEPTION 'source execution fence requires established gateway scope' USING ERRCODE = '42501';
    END IF;
    v_tenant_id := nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid;
  END IF;
  IF v_tenant_id IS NULL OR v_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'source execution fence is outside current tenant scope' USING ERRCODE = '42501';
  END IF;
  SELECT f.state INTO v_state FROM core.source_execution_fences f WHERE f.tenant_id=p_tenant_id AND f.admission_invocation_id=p_admission_id FOR SHARE;
  RETURN coalesce(v_state='open',false);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trust.open_source_execution_fence(uuid,uuid), trust.cancel_source_execution_fence(uuid,uuid), trust.lock_source_execution_fence(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trust.open_source_execution_fence(uuid,uuid), trust.cancel_source_execution_fence(uuid,uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trust.lock_source_execution_fence(uuid,uuid) TO ontos_runtime, party_registry_runtime;
