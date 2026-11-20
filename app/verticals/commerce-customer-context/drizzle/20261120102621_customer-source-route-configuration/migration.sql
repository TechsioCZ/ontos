CREATE TABLE "commerce_customer_context"."customer_source_route_history" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"acting_principal_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"current_route" jsonb NOT NULL,
	"generation" integer,
	"previous_route" jsonb,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" text,
	"route_kind" text,
	CONSTRAINT "ccc_source_route_history_pk" PRIMARY KEY("tenant_id","legal_entity_id","route_kind","route_id","generation"),
	CONSTRAINT "ccc_source_route_history_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "ccc_source_route_history_kind_ck" CHECK ("route_kind" in ('PROFILE', 'GROUP_DEFINITION', 'MEMBERSHIP', 'SAVED_ADDRESS')),
	CONSTRAINT "ccc_source_route_history_document_ck" CHECK (jsonb_typeof("current_route") = 'object' and ("previous_route" is null or jsonb_typeof("previous_route") = 'object')),
	CONSTRAINT "ccc_source_route_history_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "ccc_source_route_history_route_ck" CHECK ("route_id" = btrim("route_id") and length("route_id") > 0),
	CONSTRAINT "ccc_source_route_history_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_source_route_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_definition_source_routes" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_routes" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_source_routes" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_address_source_routes" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_definition_source_routes" ADD CONSTRAINT "ccc_group_def_source_route_generation_ck" CHECK ("generation" > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_routes" ADD CONSTRAINT "ccc_membership_source_route_generation_ck" CHECK ("generation" > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_source_routes" ADD CONSTRAINT "ccc_profile_source_route_generation_ck" CHECK ("generation" > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_address_source_routes" ADD CONSTRAINT "ccc_saved_address_source_route_generation_ck" CHECK ("generation" > 0);--> statement-breakpoint
CREATE POLICY "ccc_source_route_history_scope_select" ON "commerce_customer_context"."customer_source_route_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_source_route_history_scope_insert" ON "commerce_customer_context"."customer_source_route_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_source_route_history_scope_update" ON "commerce_customer_context"."customer_source_route_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_source_route_history_scope_delete" ON "commerce_customer_context"."customer_source_route_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_source_route_history_scope_owner_routine" ON "commerce_customer_context"."customer_source_route_history" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_source_route_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_source_route_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
-- The four Commerce source route registries get one governed writer. Every stored route carries a
-- generation this owner advances on each change, and every change is kept in an append-only history.
ALTER TABLE commerce_customer_context.customer_source_route_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE commerce_customer_context.customer_source_route_history FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER ccc_source_route_history_append_only BEFORE UPDATE OR DELETE ON commerce_customer_context.customer_source_route_history FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.reject_append_only_mutation();
--> statement-breakpoint
-- The canonical route document: lower-case principal ids, and the reader principals as a sorted set.
CREATE FUNCTION commerce_customer_context.customer_source_route_document(p_route jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT p_route
    || jsonb_build_object('principalId',(p_route->>'principalId')::uuid::text)
    || CASE WHEN p_route->>'_tag'='PROFILE' THEN jsonb_build_object('sourceReaderPrincipalIds',(
         SELECT coalesce(jsonb_agg(r.reader::uuid::text ORDER BY r.reader::uuid),'[]'::jsonb)
         FROM jsonb_array_elements_text(p_route->'sourceReaderPrincipalIds') AS r(reader)))
       ELSE '{}'::jsonb END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_source_route_document(jsonb) FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
-- The stored route of one kind and id as its canonical document, legacy NULL facts included, with its generation.
CREATE FUNCTION commerce_customer_context.customer_source_route_state(p_tenant_id uuid,p_legal_entity_id uuid,p_route_kind text,p_route_id text)
RETURNS TABLE(route jsonb,generation integer) LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT commerce_customer_context.customer_source_route_document(stored.route),stored.generation FROM (
    SELECT jsonb_build_object('_tag','PROFILE','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'recordType',r.record_type,
        'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision),
        'sourceReaderPrincipalIds',to_jsonb(r.source_reader_principal_ids::text[])) AS route,r.generation
      FROM commerce_customer_context.customer_profile_source_routes r
      WHERE p_route_kind='PROFILE' AND r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_route_id
    UNION ALL
    SELECT jsonb_build_object('_tag','GROUP_DEFINITION','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision)),
        r.generation
      FROM commerce_customer_context.customer_group_definition_source_routes r
      WHERE p_route_kind='GROUP_DEFINITION' AND r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_route_id
    UNION ALL
    SELECT jsonb_build_object('_tag','MEMBERSHIP','active',r.active,'allowComplete',r.allow_complete,
        'completenessContract',CASE WHEN r.completeness_contract_ref IS NULL AND r.completeness_contract_revision IS NULL
            AND r.completeness_contract_coverage IS NULL THEN 'null'::jsonb
          ELSE jsonb_build_object('coverage',r.completeness_contract_coverage,'ref',r.completeness_contract_ref,
            'revision',r.completeness_contract_revision) END,
        'issuer',r.issuer,'principalId',r.principal_id::text,'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision),
        'sourceNamespace',r.source_namespace),r.generation
      FROM commerce_customer_context.customer_group_membership_source_routes r
      WHERE p_route_kind='MEMBERSHIP' AND r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_route_id
    UNION ALL
    SELECT jsonb_build_object('_tag','SAVED_ADDRESS','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'recordType',r.record_type,
        'route',jsonb_build_object('id',r.route_ref,'revision',r.route_revision)),r.generation
      FROM commerce_customer_context.saved_address_source_routes r
      WHERE p_route_kind='SAVED_ADDRESS' AND r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_ref=p_route_id
  ) AS stored;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_source_route_state(uuid,uuid,text,text) FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
-- Whether a route generation this owner recorded was active with the principal as its writer under exactly this route
-- id, route revision and source identity (each fact of p_source compared on its own). Readers never write, so they are
-- never such a writer. Only the read-only recovery of a receipt that principal wrote consults it.
CREATE FUNCTION commerce_customer_context.customer_source_route_writer_held(p_tenant_id uuid,p_legal_entity_id uuid,p_route_kind text,p_route_id text,p_route_revision text,p_principal_id uuid,p_source jsonb)
RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT coalesce(p_principal_id IS NOT NULL AND p_route_revision IS NOT NULL AND jsonb_typeof(p_source)='object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_source) AS fact(key,value) WHERE jsonb_typeof(fact.value) IS DISTINCT FROM 'string')
    AND EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_source_route_history h
      CROSS JOIN LATERAL (VALUES (h.previous_route),(h.current_route)) AS state(route)
      WHERE h.tenant_id=p_tenant_id AND h.legal_entity_id=p_legal_entity_id AND h.route_kind=p_route_kind AND h.route_id=p_route_id
        AND state.route->'active'='true'::jsonb
        AND state.route->>'principalId'=p_principal_id::text
        AND state.route->'route'->>'id'=p_route_id
        AND state.route->'route'->>'revision'=p_route_revision
        AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(p_source) AS fact(key,value)
          WHERE state.route->>fact.key IS DISTINCT FROM fact.value)),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_source_route_writer_held(uuid,uuid,text,text,text,uuid,jsonb) FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
-- Serializes every decision about one route, its first insert included, and holds its stored row against the source
-- writers that read it. The configuration Action takes it before it reads Core's enrollment in the same transaction.
CREATE FUNCTION commerce_customer_context.lock_customer_source_route(p_tenant_id uuid,p_legal_entity_id uuid,p_route_kind text,p_route_id text)
RETURNS TABLE(locked boolean) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_route_id IS NULL OR p_route_kind IS NULL OR p_route_kind NOT IN ('PROFILE','GROUP_DEFINITION','MEMBERSHIP','SAVED_ADDRESS') THEN
    RAISE EXCEPTION 'one exact Commerce source route is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('ccc.source-route',p_tenant_id,p_legal_entity_id,p_route_kind,p_route_id)::text,0));
  IF p_route_kind='PROFILE' THEN
    PERFORM 1 FROM commerce_customer_context.customer_profile_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_route_id FOR UPDATE;
  ELSIF p_route_kind='GROUP_DEFINITION' THEN
    PERFORM 1 FROM commerce_customer_context.customer_group_definition_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_route_id FOR UPDATE;
  ELSIF p_route_kind='MEMBERSHIP' THEN
    PERFORM 1 FROM commerce_customer_context.customer_group_membership_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_route_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM commerce_customer_context.saved_address_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_ref=p_route_id FOR UPDATE;
  END IF;
  RETURN QUERY SELECT true;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.lock_customer_source_route(uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.lock_customer_source_route(uuid,uuid,text,text) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.configure_customer_source_route(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,previous_generation integer,current_generation integer,stored_route jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE
  v_route jsonb:=commerce_customer_context.customer_source_route_document(p_input->'route');
  v_kind text:=p_input->'route'->>'_tag';
  v_id text:=p_input->'route'->'route'->>'id';
  v_current jsonb;
  v_generation integer;
  v_next integer;
BEGIN
  IF jsonb_typeof(p_input->'enrolledReaderPrincipalIds') IS DISTINCT FROM 'array'
    OR coalesce(jsonb_typeof(p_input->'enrolledWriterPrincipalId'),'') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'the principals Core enrolls for the route are required' USING ERRCODE = '22023';
  END IF;
  PERFORM commerce_customer_context.lock_customer_source_route(p_tenant_id,p_legal_entity_id,v_kind,v_id);
  SELECT state.route,state.generation INTO v_current,v_generation
    FROM commerce_customer_context.customer_source_route_state(p_tenant_id,p_legal_entity_id,v_kind,v_id) AS state;
  -- A route grants nothing to a principal Core does not enroll for it. The Action read Core's enrollment under this
  -- route's lock: the writer must be the system principal Core enrolls for source writes, each Profile reader one it binds.
  IF v_route->>'principalId' IS DISTINCT FROM (p_input->>'enrolledWriterPrincipalId')::uuid::text
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_route->'sourceReaderPrincipalIds') AS requested(reader)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_input->'enrolledReaderPrincipalIds') AS enrolled(reader)
        WHERE enrolled.reader::uuid=requested.reader::uuid)) THEN
    RETURN QUERY SELECT 'PRINCIPAL_INELIGIBLE'::text,v_generation,v_generation,v_current; RETURN;
  END IF;
  IF v_current=v_route THEN
    RETURN QUERY SELECT 'UNCHANGED'::text,v_generation,v_generation,v_current; RETURN;
  END IF;
  -- The administrator decided against the generation they last read; a later decision is never overwritten.
  IF v_generation IS DISTINCT FROM (p_input->>'expectedGeneration')::integer THEN
    RETURN QUERY SELECT 'EXPECTATION_MISMATCH'::text,v_generation,v_generation,v_current; RETURN;
  END IF;
  -- A route keeps the source it was configured for; another source needs its own route.
  IF v_current IS NOT NULL AND (v_current->>'issuer',v_current->>'namespace',v_current->>'sourceNamespace',v_current->>'recordType')
     IS DISTINCT FROM (v_route->>'issuer',v_route->>'namespace',v_route->>'sourceNamespace',v_route->>'recordType') THEN
    RETURN QUERY SELECT 'SOURCE_IDENTITY_IMMUTABLE'::text,v_generation,v_generation,v_current; RETURN;
  END IF;
  v_next:=coalesce(v_generation,0)+1;
  IF v_kind='PROFILE' THEN
    INSERT INTO commerce_customer_context.customer_profile_source_routes(tenant_id,legal_entity_id,route_id,route_revision,
        mapping_revision,issuer,namespace,record_type,principal_id,active,source_reader_principal_ids,generation)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'mappingRevision',v_route->>'issuer',
        v_route->>'namespace',v_route->>'recordType',(v_route->>'principalId')::uuid,(v_route->>'active')::boolean,
        ARRAY(SELECT r.reader::uuid FROM jsonb_array_elements_text(v_route->'sourceReaderPrincipalIds') WITH ORDINALITY AS r(reader,ordinal) ORDER BY r.ordinal),
        v_next)
      ON CONFLICT (tenant_id,legal_entity_id,route_id) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        mapping_revision=EXCLUDED.mapping_revision,principal_id=EXCLUDED.principal_id,active=EXCLUDED.active,
        source_reader_principal_ids=EXCLUDED.source_reader_principal_ids,generation=EXCLUDED.generation;
  ELSIF v_kind='GROUP_DEFINITION' THEN
    INSERT INTO commerce_customer_context.customer_group_definition_source_routes(tenant_id,legal_entity_id,route_id,route_revision,
        mapping_revision,issuer,namespace,principal_id,active,generation)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'mappingRevision',v_route->>'issuer',
        v_route->>'namespace',(v_route->>'principalId')::uuid,(v_route->>'active')::boolean,v_next)
      ON CONFLICT (tenant_id,legal_entity_id,route_id) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        mapping_revision=EXCLUDED.mapping_revision,principal_id=EXCLUDED.principal_id,active=EXCLUDED.active,
        generation=EXCLUDED.generation;
  ELSIF v_kind='MEMBERSHIP' THEN
    INSERT INTO commerce_customer_context.customer_group_membership_source_routes(tenant_id,legal_entity_id,route_id,route_revision,
        issuer,source_namespace,principal_id,active,allow_complete,completeness_contract_coverage,completeness_contract_ref,
        completeness_contract_revision,generation)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'issuer',v_route->>'sourceNamespace',
        (v_route->>'principalId')::uuid,(v_route->>'active')::boolean,(v_route->>'allowComplete')::boolean,
        v_route->'completenessContract'->>'coverage',v_route->'completenessContract'->>'ref',v_route->'completenessContract'->>'revision',
        v_next)
      ON CONFLICT (tenant_id,legal_entity_id,route_id) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        principal_id=EXCLUDED.principal_id,active=EXCLUDED.active,allow_complete=EXCLUDED.allow_complete,
        completeness_contract_coverage=EXCLUDED.completeness_contract_coverage,
        completeness_contract_ref=EXCLUDED.completeness_contract_ref,
        completeness_contract_revision=EXCLUDED.completeness_contract_revision,generation=EXCLUDED.generation;
  ELSE
    INSERT INTO commerce_customer_context.saved_address_source_routes(tenant_id,legal_entity_id,route_ref,route_revision,
        mapping_revision,issuer,namespace,record_type,principal_id,active,generation)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'mappingRevision',v_route->>'issuer',
        v_route->>'namespace',v_route->>'recordType',(v_route->>'principalId')::uuid,(v_route->>'active')::boolean,v_next)
      ON CONFLICT (tenant_id,legal_entity_id,route_ref) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        mapping_revision=EXCLUDED.mapping_revision,principal_id=EXCLUDED.principal_id,active=EXCLUDED.active,
        generation=EXCLUDED.generation;
  END IF;
  INSERT INTO commerce_customer_context.customer_source_route_history(tenant_id,legal_entity_id,route_kind,route_id,generation,
      previous_route,current_route,acting_principal_id,action_invocation_id,reason)
    VALUES(p_tenant_id,p_legal_entity_id,v_kind,v_id,v_next,v_current,v_route,(p_input->>'actingPrincipalId')::uuid,
      (p_input->>'actionInvocationId')::uuid,p_input->>'reason');
  RETURN QUERY SELECT 'CONFIGURED'::text,v_generation,v_next,v_route;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.configure_customer_source_route(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.configure_customer_source_route(uuid,uuid,jsonb) TO ontos_runtime;
--> statement-breakpoint
-- Pausing changes nothing but the stored active flag. It needs no Core enrollment and restates no route fact, so every
-- stored route, one stored before this Action existed included, can always be paused.
CREATE FUNCTION commerce_customer_context.pause_customer_source_route(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,previous_generation integer,current_generation integer) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE
  v_kind text:=p_input->>'routeKind';
  v_id text:=p_input->>'routeId';
  v_current jsonb;
  v_generation integer;
BEGIN
  IF jsonb_typeof(p_input->'expectedGeneration') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'the expected Commerce source route generation is required' USING ERRCODE = '22023';
  END IF;
  PERFORM commerce_customer_context.lock_customer_source_route(p_tenant_id,p_legal_entity_id,v_kind,v_id);
  SELECT state.route,state.generation INTO v_current,v_generation
    FROM commerce_customer_context.customer_source_route_state(p_tenant_id,p_legal_entity_id,v_kind,v_id) AS state;
  IF v_generation IS DISTINCT FROM (p_input->>'expectedGeneration')::integer THEN
    RETURN QUERY SELECT 'EXPECTATION_MISMATCH'::text,v_generation,v_generation; RETURN;
  END IF;
  IF v_current->'active'='false'::jsonb THEN
    RETURN QUERY SELECT 'UNCHANGED'::text,v_generation,v_generation; RETURN;
  END IF;
  IF v_kind='PROFILE' THEN
    UPDATE commerce_customer_context.customer_profile_source_routes r SET active=false,generation=v_generation+1
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id;
  ELSIF v_kind='GROUP_DEFINITION' THEN
    UPDATE commerce_customer_context.customer_group_definition_source_routes r SET active=false,generation=v_generation+1
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id;
  ELSIF v_kind='MEMBERSHIP' THEN
    UPDATE commerce_customer_context.customer_group_membership_source_routes r SET active=false,generation=v_generation+1
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id;
  ELSE
    UPDATE commerce_customer_context.saved_address_source_routes r SET active=false,generation=v_generation+1
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_ref=v_id;
  END IF;
  INSERT INTO commerce_customer_context.customer_source_route_history(tenant_id,legal_entity_id,route_kind,route_id,generation,
      previous_route,current_route,acting_principal_id,action_invocation_id,reason)
    VALUES(p_tenant_id,p_legal_entity_id,v_kind,v_id,v_generation+1,v_current,v_current||'{"active":false}'::jsonb,
      (p_input->>'actingPrincipalId')::uuid,(p_input->>'actionInvocationId')::uuid,p_input->>'reason');
  RETURN QUERY SELECT 'PAUSED'::text,v_generation,v_generation+1;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.pause_customer_source_route(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.pause_customer_source_route(uuid,uuid,jsonb) TO ontos_runtime;
--> statement-breakpoint
-- One stored route as its owner holds it, legacy NULL facts included, with one page of its history, newest first.
CREATE FUNCTION commerce_customer_context.read_customer_source_route(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(result jsonb) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE
  v_kind text:=p_input->>'routeKind';
  v_id text:=p_input->>'routeId';
  v_limit integer:=(p_input->>'limit')::integer;
  v_route jsonb;
  v_generation integer;
  v_history jsonb;
  v_cursor integer;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  IF v_id IS NULL OR v_kind IS NULL OR v_kind NOT IN ('PROFILE','GROUP_DEFINITION','MEMBERSHIP','SAVED_ADDRESS') OR v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 100
    OR coalesce(jsonb_typeof(p_input->'cursor'),'') NOT IN ('number','null') THEN
    RAISE EXCEPTION 'one exact Commerce source route page is required' USING ERRCODE = '22023';
  END IF;
  SELECT state.route,state.generation INTO v_route,v_generation
    FROM commerce_customer_context.customer_source_route_state(p_tenant_id,p_legal_entity_id,v_kind,v_id) AS state;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag','ABSENT'); RETURN; END IF;
  WITH page AS (
    SELECT h.generation,h.acting_principal_id,h.action_invocation_id,h.reason,h.recorded_at,
        row_number() OVER (ORDER BY h.generation DESC) AS position
      FROM commerce_customer_context.customer_source_route_history h
      WHERE h.tenant_id=p_tenant_id AND h.legal_entity_id=p_legal_entity_id AND h.route_kind=v_kind AND h.route_id=v_id
        AND (p_input->'cursor'='null'::jsonb OR h.generation<(p_input->>'cursor')::integer)
      ORDER BY h.generation DESC LIMIT v_limit+1)
  SELECT coalesce(jsonb_agg(jsonb_build_object('actingPrincipalId',page.acting_principal_id::text,
        'actionInvocationId',page.action_invocation_id::text,'generation',page.generation,'reason',page.reason,
        'recordedAt',to_char(page.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY page.generation DESC) FILTER (WHERE page.position<=v_limit),'[]'::jsonb),
      CASE WHEN count(*)>v_limit THEN min(page.generation) FILTER (WHERE page.position<=v_limit) END
    INTO v_history,v_cursor FROM page;
  RETURN QUERY SELECT jsonb_build_object('_tag','STORED','generation',v_generation,'history',v_history,'nextCursor',v_cursor,
    'route',v_route);
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_source_route(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_source_route(uuid,uuid,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_group_definition_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid, p_input jsonb
) RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE
  v_binding commerce_customer_context.customer_group_definition_source_bindings%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_definition_source_receipts%ROWTYPE;
  v_current_authority boolean;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  v_current_authority:=EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_routes r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active
      AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision'
      AND r.principal_id=p_actor_principal_id AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace'
      AND r.mapping_revision=p_input->>'mappingRevision');
  -- Without current route authority only a receipt is recoverable, by a principal that was the active writer of exactly
  -- this route id, revision and source; such a recovery returns that principal's own receipt and nothing live.
  IF NOT v_current_authority AND NOT (p_input->>'mode'='RECEIPT'
    AND commerce_customer_context.customer_source_route_writer_held(p_tenant_id,p_legal_entity_id,'GROUP_DEFINITION',
      p_input->'route'->>'id',p_input->'route'->>'revision',p_actor_principal_id,jsonb_build_object('issuer',p_input->>'issuer',
        'mappingRevision',p_input->>'mappingRevision','namespace',p_input->>'namespace')))
  THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN; END IF;
  IF p_input->>'mode'='CURRENT' THEN
    SELECT * INTO v_binding FROM commerce_customer_context.customer_group_definition_source_bindings b
      WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.issuer=p_input->>'issuer'
        AND b.namespace=p_input->>'namespace' AND b.record_id=p_input->>'recordId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','ABSENT'); RETURN; END IF;
    RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','CURRENT',
      'group',commerce_customer_context.customer_group_document(p_tenant_id,p_legal_entity_id,v_binding.customer_group_id),
      'source',v_binding.source_intent->'payload'->'source'); RETURN;
  ELSIF p_input->>'mode'='RECEIPT' THEN
    SELECT * INTO v_receipt FROM commerce_customer_context.customer_group_definition_source_receipts r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.issuer=p_input->>'issuer'
        AND r.namespace=p_input->>'namespace' AND r.effect_id=p_input->>'effectId'
        AND (v_current_authority OR (r.actor_principal_id=p_actor_principal_id
          AND r.intent->'payload'->'source'->'route'->>'id'=p_input->'route'->>'id'
          AND r.intent->'payload'->'source'->'route'->>'revision'=p_input->'route'->>'revision'
          AND r.intent->'payload'->'source'->>'mappingRevision'=p_input->>'mappingRevision'));
    IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb; RETURN; END IF;
    IF v_receipt.intent->>'operation' IS DISTINCT FROM p_input->>'expectedOperation'
      OR v_receipt.intent->'payload' IS DISTINCT FROM p_input->'expectedIntent'
    THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,NULL::jsonb; RETURN; END IF;
    RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','RECEIPT','group',v_receipt.result->'group',
      'operation',v_receipt.intent->>'operation','source',v_receipt.intent->'payload'->'source',
      'originalIntent',v_receipt.intent->'payload') || CASE WHEN v_receipt.intent->>'operation'='CREATE'
        THEN jsonb_build_object('created',v_receipt.result->'created') ELSE jsonb_build_object('changed',v_receipt.result->'changed') END; RETURN;
  END IF;
  RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_profile_source(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_route record;v_current_authority boolean;v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_receipt commerce_customer_context.customer_profile_source_receipts%ROWTYPE;v_receipt_document jsonb;v_item jsonb;v_items jsonb:='[]'::jsonb;v_count integer:=0;v_limit integer;v_cursor text:=NULL;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_route FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND (r.principal_id=p_principal_id OR p_principal_id=ANY(r.source_reader_principal_ids)) AND r.active FOR SHARE;
  v_current_authority:=FOUND;
  -- Without current route authority only a receipt is recoverable, by a principal that was the active writer of exactly
  -- this route id, revision and source; such a recovery returns that principal's own receipt and nothing live.
  IF NOT v_current_authority AND NOT (p_input->>'mode'='RECEIPT' AND commerce_customer_context.customer_source_route_writer_held(p_tenant_id,p_legal_entity_id,'PROFILE',p_input->'route'->>'id',p_input->'route'->>'revision',p_principal_id,jsonb_build_object('issuer',p_input->>'issuer','mappingRevision',p_input->>'mappingRevision','namespace',p_input->>'namespace','recordType',p_input->>'recordType'))) THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  IF p_input->>'mode'='RECEIPT' THEN
    SELECT * INTO v_receipt FROM commerce_customer_context.customer_profile_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND r.effect_id=p_input->>'effectId'
      AND (v_current_authority OR (r.actor_principal_id=p_principal_id AND r.legal_entity_id=p_legal_entity_id AND r.intent->'source'->'route'->>'id'=p_input->'route'->>'id' AND r.intent->'source'->'route'->>'revision'=p_input->'route'->>'revision' AND r.intent->'source'->>'mappingRevision'=p_input->>'mappingRevision'));
    IF NOT FOUND OR (v_receipt.profile_kind='RETAIL' AND v_receipt.legal_entity_id<>p_legal_entity_id) THEN RETURN QUERY SELECT 'NOT_FOUND',NULL::jsonb;RETURN;END IF;
    IF v_receipt.owner_evidence IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_receipt_document:=jsonb_build_object('profileKind',v_receipt.profile_kind,'intent',v_receipt.intent,'result',v_receipt.result,'actionInvocationId',v_receipt.action_invocation_id::text,'actorPrincipalId',v_receipt.actor_principal_id::text,'recordedAt',to_char(v_receipt.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    -- Only current route authority discloses the live Profile beside the receipt.
    IF NOT v_current_authority THEN RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','RECEIPT','receipt',v_receipt_document);RETURN;END IF;
    SELECT * INTO v_binding FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=v_receipt.issuer AND b.namespace=v_receipt.namespace AND b.record_type=v_receipt.record_type AND b.record_id=v_receipt.record_id AND b.customer_profile_id=v_receipt.customer_profile_id;
    IF NOT FOUND THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','RECEIPT','current',v_item,'receipt',v_receipt_document);RETURN;
  END IF;
  IF p_input->>'mode'='CURRENT' THEN
    SELECT * INTO v_binding FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND b.record_id=p_input->>'recordId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','ABSENT');RETURN;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','CURRENT','item',v_item);RETURN;
  END IF;
  v_limit:=(p_input->>'limit')::integer;
  IF p_input->>'mode'<>'LIST' OR v_limit NOT BETWEEN 1 AND 100 THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
  FOR v_binding IN SELECT * FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id) AND (p_input->>'cursor' IS NULL OR b.record_id COLLATE "C">(p_input->>'cursor') COLLATE "C") ORDER BY b.record_id COLLATE "C" LIMIT v_limit+1 LOOP
    IF v_count=v_limit THEN v_cursor:=v_items->-1->'source'->>'recordId';EXIT;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_items:=v_items||jsonb_build_array(v_item);v_count:=v_count+1;
  END LOOP;
  RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','PAGE','items',v_items,'nextCursor',v_cursor);
END;$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_membership_source_receipt_classified_internal(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_actor_principal_id uuid,
  p_query jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_result jsonb;
  v_current_authority boolean;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  v_current_authority := EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
    WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
      AND route.route_id = p_query #>> '{route,id}' AND route.route_revision = p_query #>> '{route,revision}'
      AND route.issuer = p_query #>> '{manager,issuer}'
      AND route.source_namespace = p_query #>> '{manager,sourceNamespace}'
      AND route.principal_id = p_actor_principal_id AND route.active
  );
  IF p_query #>> '{manager,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_query #>> '{manager,factFamily}' IS DISTINCT FROM 'CUSTOMER_GROUP_MEMBERSHIP'
    OR p_query #>> '{profile,profileRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    -- Without current route authority only a principal that was the active writer of exactly this route id, revision
    -- and source recovers a receipt, and only one it wrote itself.
    OR (NOT v_current_authority AND NOT commerce_customer_context.customer_source_route_writer_held(
      p_tenant_id, p_legal_entity_id, 'MEMBERSHIP', p_query #>> '{route,id}', p_query #>> '{route,revision}', p_actor_principal_id,
      jsonb_build_object('issuer', p_query #>> '{manager,issuer}', 'sourceNamespace', p_query #>> '{manager,sourceNamespace}')
    ))
  THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;
  SELECT receipt.result INTO v_result
  FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
  JOIN commerce_customer_context.customer_profiles AS profile
    ON profile.tenant_id = receipt.tenant_id AND profile.legal_entity_id = receipt.legal_entity_id
    AND profile.customer_profile_id = receipt.customer_profile_id
  WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
    AND receipt.customer_profile_id = (p_query #>> '{profile,profileRef,resourceId}')::uuid
    AND profile.profile_kind = p_query #>> '{profile,profileKind}'
    AND receipt.issuer = p_query #>> '{manager,issuer}'
    AND receipt.source_namespace = p_query #>> '{manager,sourceNamespace}'
    AND receipt.effect_id = p_query->>'effectId'
    AND (v_current_authority OR receipt.actor_principal_id = p_actor_principal_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'FOUND'::text, v_result;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_saved_address_source_receipt(
 p_tenant_id uuid,p_legal_entity_id uuid,p_actor_id uuid,p_original_actor_id uuid,p_expected_auth_context_ref text,p_input jsonb
) RETURNS TABLE(outcome text,result jsonb,recorded_principal_id uuid,recorded_action_key text,recorded_auth_context_ref text) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,commerce_customer_context,pg_temp SET row_security=on AS $$
DECLARE v_source jsonb:=p_input->'source'; v_receipt commerce_customer_context.saved_address_source_receipts%ROWTYPE; v_binding commerce_customer_context.saved_address_source_bindings%ROWTYPE; v_address commerce_customer_context.saved_addresses%ROWTYPE; v_profile jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_customer_context.saved_address_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active AND r.principal_id=(CASE WHEN p_input->>'mode'='RECEIPT' THEN p_original_actor_id ELSE p_actor_id END) AND r.route_ref=v_source->'identity'->>'routeRef' AND r.route_revision=v_source->>'routeRevision' AND r.mapping_revision=v_source->>'mappingRevision' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.record_type=v_source->'identity'->>'recordType')
   -- Without current route authority only the original writer, while it was the active writer of exactly this route ref,
   -- revision and source, recovers a receipt; the receipt read below is its own, written with exactly this source.
   AND NOT (p_input->>'mode'='RECEIPT' AND commerce_customer_context.customer_source_route_writer_held(p_tenant_id,p_legal_entity_id,'SAVED_ADDRESS',v_source->'identity'->>'routeRef',v_source->>'routeRevision',p_original_actor_id,jsonb_build_object('issuer',v_source->'identity'->>'issuer','mappingRevision',v_source->>'mappingRevision','namespace',v_source->'identity'->>'namespace','recordType',v_source->'identity'->>'recordType')))
 THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 IF p_input->'profile'->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 IF p_input->>'mode'='CURRENT' THEN
  SELECT CASE profile.profile_kind
    WHEN 'RETAIL' THEN jsonb_build_object(
      'kind','RETAIL','profileRef',jsonb_build_object(
        'moduleId','commerce.customer-context','resourceType','commerce.customer-context.retail-customer-profile',
        'resourceId',profile.customer_profile_id,'tenantId',p_tenant_id))
    WHEN 'COUNTERPARTY' THEN jsonb_build_object(
      'kind','COUNTERPARTY','profileRef',jsonb_build_object(
        'moduleId','commerce.customer-context','resourceType','commerce.customer-context.counterparty-purchasing-profile',
        'resourceId',profile.customer_profile_id,'tenantId',p_tenant_id),
      'counterpartyRef',jsonb_build_object(
        'moduleId','party.registry','resourceType','party.registry.counterparty',
        'resourceId',counterparty.counterparty_resource_id,'tenantId',p_tenant_id))
    END INTO v_profile
  FROM commerce_customer_context.customer_profiles profile
  LEFT JOIN commerce_customer_context.retail_customer_profiles retail
    ON retail.tenant_id=profile.tenant_id AND retail.legal_entity_id=profile.legal_entity_id
      AND retail.retail_customer_profile_id=profile.customer_profile_id
  LEFT JOIN commerce_customer_context.counterparty_purchasing_profiles counterparty
    ON counterparty.tenant_id=profile.tenant_id AND counterparty.legal_entity_id=profile.legal_entity_id
      AND counterparty.counterparty_purchasing_profile_id=profile.customer_profile_id
  WHERE profile.tenant_id=p_tenant_id AND profile.legal_entity_id=p_legal_entity_id
    AND profile.customer_profile_id=(p_input->'profile'->'profileRef'->>'resourceId')::uuid
    AND ((profile.profile_kind='RETAIL' AND retail.retail_customer_profile_id IS NOT NULL)
      OR (profile.profile_kind='COUNTERPARTY' AND counterparty.counterparty_purchasing_profile_id IS NOT NULL));
  IF NOT FOUND OR v_profile IS DISTINCT FROM p_input->'profile' THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN;
  END IF;
  SELECT * INTO v_binding FROM commerce_customer_context.saved_address_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_profile_id=(p_input->'profile'->'profileRef'->>'resourceId')::uuid AND b.issuer=v_source->'identity'->>'issuer' AND b.namespace=v_source->'identity'->>'namespace' AND b.record_type=v_source->'identity'->>'recordType' AND b.record_id=v_source->'identity'->>'recordId';
  IF NOT FOUND THEN RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','ABSENT'),NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  SELECT * INTO v_address FROM commerce_customer_context.saved_addresses a WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id AND a.saved_address_id=v_binding.saved_address_id AND a.customer_profile_id=v_binding.customer_profile_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','CURRENT','profile',v_profile,'savedAddressRef',jsonb_build_object('moduleId','commerce.customer-context','resourceType','commerce.customer-context.saved-address','resourceId',v_address.saved_address_id,'tenantId',p_tenant_id),'revision',v_address.revision,'lifecycle',v_address.lifecycle,'purposes',v_address.purposes),NULL::uuid,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO v_receipt FROM commerce_customer_context.saved_address_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.action_invocation_id=(p_input->>'actionInvocationId')::uuid AND r.actor_principal_id=p_original_actor_id AND r.action_key=p_input->>'actionKey' AND r.request_hash=p_input->>'requestHash' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.effect_id=v_source->>'effectId' AND r.source=v_source AND r.result->'profile'=p_input->'profile' AND (p_expected_auth_context_ref IS NULL OR r.recorded_auth_context_ref=p_expected_auth_context_ref);
 IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','RECEIPT','receipt',v_receipt.result),v_receipt.actor_principal_id,v_receipt.action_key,v_receipt.recorded_auth_context_ref;
END; $$;
