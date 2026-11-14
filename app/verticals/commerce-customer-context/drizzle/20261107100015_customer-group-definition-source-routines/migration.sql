ALTER TABLE commerce_customer_context.customer_group_definition_source_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commerce_customer_context.customer_group_definition_source_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commerce_customer_context.customer_group_definition_source_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE commerce_customer_context.customer_group_definition_source_routes,
  commerce_customer_context.customer_group_definition_source_bindings,
  commerce_customer_context.customer_group_definition_source_receipts FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.update_customer_group(uuid,uuid,uuid,integer,text,text,text,text,text,timestamptz,uuid,uuid) RENAME TO update_customer_group_source_guarded;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.update_customer_group_source_guarded(uuid,uuid,uuid,integer,text,text,text,text,text,timestamptz,uuid,uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.update_customer_group(
  p_tenant_id uuid, p_legal_entity_id uuid, p_customer_group_id uuid, p_expected_revision integer,
  p_description text, p_membership_criteria text, p_display_name text, p_purpose text,
  p_reason text, p_recorded_at timestamptz, p_actor_principal_id uuid, p_action_invocation_id uuid
) RETURNS TABLE (outcome text, actual_revision integer, changed boolean, group_json jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text,0));
  IF EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_bindings b
    WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_group_id=p_customer_group_id)
  THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,0,false,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT * FROM commerce_customer_context.update_customer_group_source_guarded(
    p_tenant_id,p_legal_entity_id,p_customer_group_id,p_expected_revision,p_description,p_membership_criteria,
    p_display_name,p_purpose,p_reason,p_recorded_at,p_actor_principal_id,p_action_invocation_id);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.update_customer_group(uuid,uuid,uuid,integer,text,text,text,text,text,timestamptz,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.update_customer_group(uuid,uuid,uuid,integer,text,text,text,text,text,timestamptz,uuid,uuid) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.apply_customer_group_definition_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_operation text, p_input jsonb,
  p_recorded_at timestamptz, p_actor_principal_id uuid, p_action_invocation_id uuid
) RETURNS TABLE (outcome text, actual_revision integer, changed boolean, group_json jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE
  v_source jsonb := p_input->'source';
  v_binding commerce_customer_context.customer_group_definition_source_bindings%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_definition_source_receipts%ROWTYPE;
  v_result record;
  v_group_id uuid;
  v_intent jsonb := jsonb_build_object('operation',p_operation,'payload',p_input);
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  IF p_operation NOT IN ('CREATE','UPDATE') OR v_source IS NULL
    OR p_actor_principal_id IS NULL OR p_action_invocation_id IS NULL OR p_recorded_at IS NULL
  THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN; END IF;
  -- The same lock as native create also serializes manual update and source identity admission.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text,0));
  PERFORM 1 FROM commerce_customer_context.customer_group_definition_source_routes r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active
      AND r.route_id=v_source->'route'->>'id' AND r.route_revision=v_source->'route'->>'revision'
      AND r.principal_id=p_actor_principal_id AND r.issuer=v_source->>'issuer' AND r.namespace=v_source->>'namespace'
    FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,0,false,NULL::jsonb; RETURN; END IF;
  SELECT * INTO v_receipt FROM commerce_customer_context.customer_group_definition_source_receipts r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id
      AND r.issuer=v_source->>'issuer' AND r.namespace=v_source->>'namespace' AND r.effect_id=v_source->>'effectId';
  IF FOUND THEN
    IF v_receipt.intent IS DISTINCT FROM v_intent THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT CASE WHEN p_operation='CREATE' THEN 'REUSED' ELSE 'UPDATED' END,
      (v_receipt.result->>'actualRevision')::integer,false,v_receipt.result->'group'; RETURN;
  END IF;
  SELECT * INTO v_binding FROM commerce_customer_context.customer_group_definition_source_bindings b
    WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.issuer=v_source->>'issuer'
      AND b.namespace=v_source->>'namespace' AND b.record_id=v_source->>'recordId';
  IF FOUND THEN
    IF (v_source->>'order')::integer < v_binding.source_order THEN
      RETURN QUERY SELECT 'SOURCE_STALE'::text,0,false,NULL::jsonb; RETURN;
    END IF;
    IF (v_source->>'order')::integer = v_binding.source_order OR v_source->>'revision'=v_binding.source_revision
      OR v_source->>'sourceCode' IS DISTINCT FROM v_binding.source_code
    THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN; END IF;
    v_group_id := v_binding.customer_group_id;
  ELSIF p_operation='UPDATE' THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_bindings b
    WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.issuer=v_source->>'issuer'
      AND b.namespace=v_source->>'namespace' AND b.source_code=v_source->>'sourceCode'
      AND b.record_id<>v_source->>'recordId')
  THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN; END IF;
  IF p_operation='CREATE' AND v_group_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_groups g
      WHERE g.tenant_id=p_tenant_id AND g.legal_entity_id=p_legal_entity_id AND g.customer_group_id=v_group_id
        AND g.stable_code=p_input->>'businessCode' AND g.meaning_key=p_input->>'meaningKey')
    THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN; END IF;
  END IF;
  IF p_operation='CREATE' THEN
    SELECT * INTO v_result FROM commerce_customer_context.create_customer_group(
      p_tenant_id,p_legal_entity_id,p_input->>'businessCode',p_input->>'meaningKey',p_input->>'description',
      p_input->>'membershipCriteria',p_input->>'name',p_input->>'purpose',p_input->>'reason',
      p_recorded_at,p_actor_principal_id,p_action_invocation_id);
    IF v_result.outcome NOT IN ('CREATED','REUSED') THEN
      RETURN QUERY SELECT v_result.outcome,v_result.actual_revision,v_result.changed,v_result.group_json; RETURN;
    END IF;
    -- A code/meaning match never transfers an unproved manual or other-issuer Group identity.
    IF (v_result.outcome='REUSED' AND (v_group_id IS NULL
      OR v_group_id IS DISTINCT FROM (v_result.group_json->'groupRef'->>'resourceId')::uuid))
      OR (v_group_id IS NOT NULL AND (v_result.group_json->'currentDefinition'->>'name' IS DISTINCT FROM p_input->>'name'
        OR v_result.group_json->'currentDefinition'->>'description' IS DISTINCT FROM p_input->>'description'))
    THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN; END IF;
    v_group_id := (v_result.group_json->'groupRef'->>'resourceId')::uuid;
  ELSE
    IF p_input->'groupRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
      OR v_group_id IS DISTINCT FROM (p_input->'groupRef'->>'resourceId')::uuid
    THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,0,false,NULL::jsonb; RETURN; END IF;
    SELECT * INTO v_result FROM commerce_customer_context.update_customer_group_source_guarded(
      p_tenant_id,p_legal_entity_id,v_group_id,(p_input->>'expectedRevision')::integer,p_input->>'description',
      p_input->>'membershipCriteria',p_input->>'name',p_input->>'purpose',p_input->>'reason',
      p_recorded_at,p_actor_principal_id,p_action_invocation_id);
    IF v_result.outcome<>'UPDATED' THEN
      RETURN QUERY SELECT v_result.outcome,v_result.actual_revision,v_result.changed,v_result.group_json; RETURN;
    END IF;
  END IF;
  INSERT INTO commerce_customer_context.customer_group_definition_source_bindings
    (tenant_id,legal_entity_id,issuer,namespace,record_id,source_code,customer_group_id,source_order,source_revision,source_intent)
    VALUES (p_tenant_id,p_legal_entity_id,v_source->>'issuer',v_source->>'namespace',v_source->>'recordId',
      v_source->>'sourceCode',v_group_id,(v_source->>'order')::integer,v_source->>'revision',v_intent)
    ON CONFLICT (tenant_id,legal_entity_id,issuer,namespace,record_id) DO UPDATE
      SET source_order=excluded.source_order,source_revision=excluded.source_revision,source_intent=excluded.source_intent;
  INSERT INTO commerce_customer_context.customer_group_definition_source_receipts
    (tenant_id,legal_entity_id,issuer,namespace,effect_id,intent,result,actor_principal_id,action_invocation_id,recorded_at)
    VALUES (p_tenant_id,p_legal_entity_id,v_source->>'issuer',v_source->>'namespace',v_source->>'effectId',v_intent,
      jsonb_build_object('actualRevision',v_result.actual_revision,'group',v_result.group_json),
      p_actor_principal_id,p_action_invocation_id,p_recorded_at);
  RETURN QUERY SELECT v_result.outcome,v_result.actual_revision,v_result.changed,v_result.group_json;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_customer_group_definition_source(uuid,uuid,text,jsonb,timestamptz,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.apply_customer_group_definition_source(uuid,uuid,text,jsonb,timestamptz,uuid,uuid) TO ontos_runtime;

--> statement-breakpoint
CREATE TRIGGER ccc_group_def_source_receipts_append_only
BEFORE UPDATE OR DELETE ON commerce_customer_context.customer_group_definition_source_receipts
FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.reject_append_only_mutation();
