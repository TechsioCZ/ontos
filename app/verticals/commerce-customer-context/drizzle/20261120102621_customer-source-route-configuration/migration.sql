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
-- Whether a route state this owner once stored bound the principal to exactly the presented route. Only
-- the read-only recovery of an already committed effect consults it; new effects need the active route.
CREATE FUNCTION commerce_customer_context.customer_source_route_recoverable(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_route jsonb)
RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT coalesce(p_principal_id IS NOT NULL AND jsonb_strip_nulls(p_route)=p_route AND EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_source_route_history h
    CROSS JOIN LATERAL (VALUES (h.previous_route),(h.current_route)) AS state(route)
    WHERE h.tenant_id=p_tenant_id AND h.legal_entity_id=p_legal_entity_id
      AND h.route_kind=p_route->>'_tag' AND h.route_id=p_route->'route'->>'id'
      AND state.route @> p_route
      AND (state.route->>'principalId'=p_principal_id::text
        OR coalesce(state.route->'sourceReaderPrincipalIds' ? p_principal_id::text,false))),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_source_route_recoverable(uuid,uuid,uuid,jsonb) FROM PUBLIC,ontos_runtime;
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
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF v_id IS NULL OR v_kind IS NULL OR v_kind NOT IN ('PROFILE','GROUP_DEFINITION','MEMBERSHIP','SAVED_ADDRESS')
    OR jsonb_typeof(p_input->'principalsEligible') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'one exact Commerce source route is required' USING ERRCODE = '22023';
  END IF;
  -- Serializes configuration of one route, including its first insert.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('ccc.source-route',p_tenant_id,p_legal_entity_id,v_kind,v_id)::text,0));
  IF v_kind='PROFILE' THEN
    SELECT jsonb_build_object('_tag','PROFILE','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'recordType',r.record_type,
        'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision),
        'sourceReaderPrincipalIds',to_jsonb(r.source_reader_principal_ids::text[])),r.generation
      INTO v_current,v_generation FROM commerce_customer_context.customer_profile_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id FOR UPDATE;
  ELSIF v_kind='GROUP_DEFINITION' THEN
    SELECT jsonb_build_object('_tag','GROUP_DEFINITION','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision)),
        r.generation
      INTO v_current,v_generation FROM commerce_customer_context.customer_group_definition_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id FOR UPDATE;
  ELSIF v_kind='MEMBERSHIP' THEN
    SELECT jsonb_build_object('_tag','MEMBERSHIP','active',r.active,'allowComplete',r.allow_complete,
        'completenessContract',CASE WHEN r.completeness_contract_ref IS NULL AND r.completeness_contract_revision IS NULL
            AND r.completeness_contract_coverage IS NULL THEN 'null'::jsonb
          ELSE jsonb_build_object('coverage',r.completeness_contract_coverage,'ref',r.completeness_contract_ref,
            'revision',r.completeness_contract_revision) END,
        'issuer',r.issuer,'principalId',r.principal_id::text,'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision),
        'sourceNamespace',r.source_namespace),r.generation
      INTO v_current,v_generation FROM commerce_customer_context.customer_group_membership_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id FOR UPDATE;
  ELSE
    SELECT jsonb_build_object('_tag','SAVED_ADDRESS','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'recordType',r.record_type,
        'route',jsonb_build_object('id',r.route_ref,'revision',r.route_revision)),r.generation
      INTO v_current,v_generation FROM commerce_customer_context.saved_address_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_ref=v_id FOR UPDATE;
  END IF;
  v_current:=commerce_customer_context.customer_source_route_document(v_current);
  -- A route grants nothing to a principal Core does not currently enroll for it, but a stored route can always be paused.
  IF NOT (p_input->>'principalsEligible')::boolean AND v_route IS DISTINCT FROM v_current||'{"active":false}'::jsonb THEN
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
CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_group_definition_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid, p_input jsonb
) RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE
  v_binding commerce_customer_context.customer_group_definition_source_bindings%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_definition_source_receipts%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_routes r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active
      AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision'
      AND r.principal_id=p_actor_principal_id AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace'
      AND r.mapping_revision=p_input->>'mappingRevision')
    -- A committed effect stays recoverable, read-only, under the paused or superseded route state it was written with.
    AND NOT (p_input->>'mode'='RECEIPT' AND commerce_customer_context.customer_source_route_recoverable(
      p_tenant_id,p_legal_entity_id,p_actor_principal_id,jsonb_build_object('_tag','GROUP_DEFINITION','issuer',p_input->>'issuer',
        'mappingRevision',p_input->>'mappingRevision','namespace',p_input->>'namespace','route',p_input->'route')))
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
        AND r.namespace=p_input->>'namespace' AND r.effect_id=p_input->>'effectId';
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
DECLARE v_route record;v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_receipt commerce_customer_context.customer_profile_source_receipts%ROWTYPE;v_item jsonb;v_items jsonb:='[]'::jsonb;v_count integer:=0;v_limit integer;v_cursor text:=NULL;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_route FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND (r.principal_id=p_principal_id OR p_principal_id=ANY(r.source_reader_principal_ids)) AND r.active FOR SHARE;
  -- A committed effect stays recoverable, read-only, under the paused or superseded route state it was written with.
  IF NOT FOUND AND NOT (p_input->>'mode'='RECEIPT' AND commerce_customer_context.customer_source_route_recoverable(p_tenant_id,p_legal_entity_id,p_principal_id,jsonb_build_object('_tag','PROFILE','issuer',p_input->>'issuer','mappingRevision',p_input->>'mappingRevision','namespace',p_input->>'namespace','recordType',p_input->>'recordType','route',p_input->'route'))) THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  IF p_input->>'mode'='RECEIPT' THEN
    SELECT * INTO v_receipt FROM commerce_customer_context.customer_profile_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND r.effect_id=p_input->>'effectId';
    IF NOT FOUND OR (v_receipt.profile_kind='RETAIL' AND v_receipt.legal_entity_id<>p_legal_entity_id) THEN RETURN QUERY SELECT 'NOT_FOUND',NULL::jsonb;RETURN;END IF;
    IF v_receipt.owner_evidence IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    SELECT * INTO v_binding FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=v_receipt.issuer AND b.namespace=v_receipt.namespace AND b.record_type=v_receipt.record_type AND b.record_id=v_receipt.record_id AND b.customer_profile_id=v_receipt.customer_profile_id;
    IF NOT FOUND THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','RECEIPT','current',v_item,'receipt',jsonb_build_object('profileKind',v_receipt.profile_kind,'intent',v_receipt.intent,'result',v_receipt.result,'actionInvocationId',v_receipt.action_invocation_id::text,'actorPrincipalId',v_receipt.actor_principal_id::text,'recordedAt',to_char(v_receipt.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));RETURN;
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
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_query #>> '{manager,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_query #>> '{manager,factFamily}' IS DISTINCT FROM 'CUSTOMER_GROUP_MEMBERSHIP'
    OR p_query #>> '{profile,profileRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
      WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
        AND route.route_id = p_query #>> '{route,id}' AND route.route_revision = p_query #>> '{route,revision}'
        AND route.issuer = p_query #>> '{manager,issuer}'
        AND route.source_namespace = p_query #>> '{manager,sourceNamespace}'
        AND route.principal_id = p_actor_principal_id AND route.active
    )
    -- A committed effect stays recoverable, read-only, under the paused or superseded route state it was written with.
    AND NOT commerce_customer_context.customer_source_route_recoverable(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id,
      jsonb_build_object('_tag', 'MEMBERSHIP', 'issuer', p_query #>> '{manager,issuer}', 'route', p_query->'route',
        'sourceNamespace', p_query #>> '{manager,sourceNamespace}')
    )
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
    AND receipt.effect_id = p_query->>'effectId';
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
   -- A committed effect stays recoverable, read-only, under the paused or superseded route state it was written with.
   AND NOT (p_input->>'mode'='RECEIPT' AND commerce_customer_context.customer_source_route_recoverable(p_tenant_id,p_legal_entity_id,p_original_actor_id,jsonb_build_object('_tag','SAVED_ADDRESS','issuer',v_source->'identity'->>'issuer','mappingRevision',v_source->>'mappingRevision','namespace',v_source->'identity'->>'namespace','recordType',v_source->'identity'->>'recordType','route',jsonb_build_object('id',v_source->'identity'->>'routeRef','revision',v_source->>'routeRevision'))))
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
