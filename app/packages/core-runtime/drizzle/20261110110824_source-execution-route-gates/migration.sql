CREATE TABLE "core"."source_execution_gate_actions" (
	"action_key" text PRIMARY KEY,
	"owner_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."source_execution_gate_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."source_execution_gates" (
	"tenant_id" uuid,
	"gate_id" uuid,
	"owner_key" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"revision" text NOT NULL,
	"mapping_version" text NOT NULL,
	"epoch" uuid NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "source_execution_gates_pk" PRIMARY KEY("tenant_id","gate_id")
);
--> statement-breakpoint
ALTER TABLE "core"."source_execution_gates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."source_execution_fences" ADD COLUMN "gate_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."source_execution_fences" ADD COLUMN "gate_epoch" uuid;--> statement-breakpoint
ALTER TABLE "core"."source_execution_fences" ADD CONSTRAINT "source_execution_fences_gate_fk" FOREIGN KEY ("tenant_id","gate_id") REFERENCES "core"."source_execution_gates"("tenant_id","gate_id");--> statement-breakpoint
ALTER TABLE "core"."source_execution_fences" ADD CONSTRAINT "source_execution_fences_gate_pair_ck" CHECK (("gate_id" is null) = ("gate_epoch" is null));
--> statement-breakpoint
-- Only the owning migration may declare a gated Action. The association is immutable.
CREATE FUNCTION trust.register_source_execution_gated_action(p_action_key text, p_owner_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO core.source_execution_gate_actions(action_key,owner_key) VALUES(p_action_key,p_owner_key)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM core.source_execution_gate_actions a WHERE a.action_key=p_action_key AND a.owner_key=p_owner_key
  ) THEN
    RAISE EXCEPTION 'source execution gated Action is already owned by a different publisher';
  END IF;
END $$;
--> statement-breakpoint
-- Admin-only publication. Retired gates are tombstones and cannot retarget older admissions.
CREATE FUNCTION trust.publish_source_execution_gate(
  p_tenant_id uuid, p_gate_id uuid, p_owner_key text, p_principal_id uuid, p_legal_entity_id uuid,
  p_revision text, p_mapping_version text, p_active boolean, p_replace_enrollment boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO core.source_execution_gates AS existing
    (tenant_id,gate_id,owner_key,principal_id,legal_entity_id,revision,mapping_version,epoch,active)
  VALUES (p_tenant_id,p_gate_id,p_owner_key,p_principal_id,p_legal_entity_id,p_revision,p_mapping_version,
    pg_catalog.gen_random_uuid(),p_active)
  ON CONFLICT (tenant_id,gate_id) DO UPDATE SET
    principal_id=excluded.principal_id,
    legal_entity_id=excluded.legal_entity_id,
    revision=excluded.revision,
    mapping_version=excluded.mapping_version,
    epoch=CASE
      WHEN p_replace_enrollment OR
        (existing.principal_id,existing.legal_entity_id,existing.revision,existing.mapping_version)
          IS DISTINCT FROM
        (excluded.principal_id,excluded.legal_entity_id,excluded.revision,excluded.mapping_version)
      THEN excluded.epoch ELSE existing.epoch END,
    active=excluded.active
  WHERE existing.owner_key=excluded.owner_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source execution gate is already owned by a different publisher';
  END IF;
END $$;
--> statement-breakpoint
-- The receiver first takes the admission lock, then the enrolled gate lock. Both last through commit.
CREATE OR REPLACE FUNCTION trust.lock_source_execution_fence(p_tenant_id uuid, p_admission_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid; v_state text; v_gate_id uuid; v_epoch uuid; v_active boolean; v_owner_key text;
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
  SELECT f.state,f.gate_id,f.gate_epoch,a.owner_key INTO v_state,v_gate_id,v_epoch,v_owner_key
    FROM core.source_execution_fences f
    LEFT JOIN core.action_invocations i ON i.tenant_id=f.tenant_id AND i.action_invocation_id=f.admission_invocation_id
    LEFT JOIN core.source_execution_gate_actions a ON a.action_key=i.action_key
    WHERE f.tenant_id=p_tenant_id AND f.admission_invocation_id=p_admission_id FOR SHARE OF f;
  IF v_state IS DISTINCT FROM 'open' THEN RETURN false; END IF;
  IF v_gate_id IS NULL THEN RETURN v_owner_key IS NULL; END IF;
  SELECT g.active AND g.epoch=v_epoch INTO v_active FROM core.source_execution_gates g
    WHERE g.tenant_id=p_tenant_id AND g.gate_id=v_gate_id AND g.owner_key=v_owner_key FOR SHARE;
  RETURN coalesce(v_active,false);
END $$;
--> statement-breakpoint
CREATE FUNCTION trust.open_source_execution_fence(
  p_tenant_id uuid, p_admission_id uuid, p_gate_id uuid, p_revision text, p_mapping_version text
) RETURNS TABLE(allowed boolean) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid; v_owner_key text; v_principal_id uuid; v_company_id uuid; v_epoch uuid;
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
  SELECT i.principal_id,i.legal_entity_id,a.owner_key INTO v_principal_id,v_company_id,v_owner_key
    FROM core.action_invocations i
    LEFT JOIN core.source_execution_gate_actions a ON a.action_key=i.action_key
    WHERE i.tenant_id=p_tenant_id AND i.action_invocation_id=p_admission_id AND i.status='running';
  IF NOT FOUND OR (v_owner_key IS NULL) IS DISTINCT FROM (p_gate_id IS NULL) THEN
    RETURN QUERY SELECT false; RETURN;
  END IF;
  IF p_gate_id IS NOT NULL THEN
    -- Read the epoch before inserting. The existing receiving routine locks and rechecks it after the admission row.
    SELECT g.epoch INTO v_epoch FROM core.source_execution_gates g
      WHERE g.tenant_id=p_tenant_id AND g.gate_id=p_gate_id AND g.owner_key=v_owner_key
        AND g.principal_id=v_principal_id AND g.legal_entity_id IS NOT DISTINCT FROM v_company_id
        AND g.revision=p_revision AND g.mapping_version=p_mapping_version AND g.active;
    IF NOT FOUND THEN RETURN QUERY SELECT false; RETURN; END IF;
  END IF;
  INSERT INTO core.source_execution_fences(tenant_id,admission_invocation_id,state,gate_id,gate_epoch)
    VALUES(p_tenant_id,p_admission_id,'open',p_gate_id,v_epoch) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT EXISTS (
    SELECT 1 FROM core.source_execution_fences f
      WHERE f.tenant_id=p_tenant_id AND f.admission_invocation_id=p_admission_id
        AND f.gate_id IS NOT DISTINCT FROM p_gate_id AND f.gate_epoch IS NOT DISTINCT FROM v_epoch
  ) AND trust.lock_source_execution_fence(p_tenant_id,p_admission_id);
END $$;
--> statement-breakpoint
-- Old application processes cannot open an ungated fence once the owner has declared this Action.
CREATE OR REPLACE FUNCTION trust.open_source_execution_fence(p_tenant_id uuid, p_admission_id uuid)
RETURNS TABLE(allowed boolean) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM trust.open_source_execution_fence(p_tenant_id,p_admission_id,NULL::uuid,NULL::text,NULL::text);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trust.register_source_execution_gated_action(text,text),
  trust.publish_source_execution_gate(uuid,uuid,text,uuid,uuid,text,text,boolean,boolean),
  trust.open_source_execution_fence(uuid,uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trust.open_source_execution_fence(uuid,uuid,uuid,text,text) TO ontos_runtime;
