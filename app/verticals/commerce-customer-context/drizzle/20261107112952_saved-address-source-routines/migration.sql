ALTER TABLE commerce_customer_context.saved_address_source_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commerce_customer_context.saved_address_source_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commerce_customer_context.saved_address_source_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE commerce_customer_context.saved_address_source_routes,commerce_customer_context.saved_address_source_bindings,commerce_customer_context.saved_address_source_receipts FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.authorize_saved_address_source(
 p_tenant_id uuid,p_legal_entity_id uuid,p_actor_id uuid,p_invocation_id uuid,p_action_key text,p_request_hash text,p_input jsonb
) RETURNS TABLE(outcome text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,commerce_customer_context,pg_temp SET row_security=on AS $$
DECLARE v_source jsonb:=p_input->'source'; v_profile_id uuid:=(p_input->'profile'->'profileRef'->>'resourceId')::uuid;
 v_binding commerce_customer_context.saved_address_source_bindings%ROWTYPE;
 v_receipt commerce_customer_context.saved_address_source_receipts%ROWTYPE;
 v_address commerce_customer_context.saved_addresses%ROWTYPE;
BEGIN
 IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ccc.saved-address-source:'||p_tenant_id::text||':'||p_legal_entity_id::text||':'||v_profile_id::text||':'||(v_source->'identity'->>'issuer')||':'||(v_source->'identity'->>'namespace')||':'||(v_source->'identity'->>'recordType')||':'||(v_source->'identity'->>'recordId'),0));
 PERFORM 1 FROM commerce_customer_context.saved_address_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active AND r.principal_id=p_actor_id AND r.route_ref=v_source->'identity'->>'routeRef' AND r.route_revision=v_source->>'routeRevision' AND r.mapping_revision=v_source->>'mappingRevision' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.record_type=v_source->'identity'->>'recordType' FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text; RETURN; END IF;
 IF p_input->'profile'->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR NOT EXISTS(SELECT 1 FROM commerce_customer_context.customer_profiles p WHERE p.tenant_id=p_tenant_id AND p.legal_entity_id=p_legal_entity_id AND p.customer_profile_id=v_profile_id AND p.profile_kind=p_input->'profile'->>'kind' AND p.lifecycle='ACTIVE') THEN RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text; RETURN; END IF;
 SELECT * INTO v_receipt FROM commerce_customer_context.saved_address_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.effect_id=v_source->>'effectId';
 IF FOUND THEN
  IF v_receipt.actor_principal_id<>p_actor_id OR v_receipt.action_key<>p_action_key OR v_receipt.request_hash<>p_request_hash OR v_receipt.source<>v_source THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text; ELSE RETURN QUERY SELECT 'RECOVERY_REQUIRED'::text; END IF; RETURN;
 END IF;
 SELECT * INTO v_binding FROM commerce_customer_context.saved_address_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_profile_id=v_profile_id AND b.issuer=v_source->'identity'->>'issuer' AND b.namespace=v_source->'identity'->>'namespace' AND b.record_type=v_source->'identity'->>'recordType' AND b.record_id=v_source->'identity'->>'recordId';
 IF FOUND THEN
  IF (v_source->>'order')::integer<v_binding.source_order THEN RETURN QUERY SELECT 'SOURCE_STALE'::text; RETURN; END IF;
  IF (v_source->>'order')::integer=v_binding.source_order OR v_source->>'revision'=v_binding.source_revision THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text; RETURN; END IF;
  IF p_input->>'operation'='ADD' THEN RETURN QUERY SELECT 'TARGET_ALREADY_BOUND'::text; RETURN; END IF;
  IF v_binding.saved_address_id IS DISTINCT FROM (p_input->'savedAddressRef'->>'resourceId')::uuid OR v_source->>'nativeAddressId' IS DISTINCT FROM v_binding.saved_address_id::text THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text; RETURN; END IF;
  SELECT * INTO v_address FROM commerce_customer_context.saved_addresses a WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id AND a.saved_address_id=v_binding.saved_address_id AND a.customer_profile_id=v_profile_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text; RETURN; END IF;
  IF p_input->>'operation'='REMOVE' OR NOT (p_input ? 'purposes') THEN
   IF NOT (v_source->'purposes' @> v_address.purposes AND v_source->'purposes' <@ v_address.purposes) THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text; RETURN; END IF;
  END IF;
 ELSIF p_input->>'operation'<>'ADD' THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'AUTHORIZED'::text;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.authorize_saved_address_source(uuid,uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.authorize_saved_address_source(uuid,uuid,uuid,uuid,text,text,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.record_saved_address_source_receipt(
 p_tenant_id uuid,p_legal_entity_id uuid,p_actor_id uuid,p_invocation_id uuid,p_action_key text,p_request_hash text,p_auth_context_ref text,p_source jsonb,p_result jsonb
) RETURNS TABLE(outcome text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,commerce_customer_context,pg_temp SET row_security=on AS $$
DECLARE v_profile_id uuid:=(p_result->'profile'->'profileRef'->>'resourceId')::uuid;
 v_address_id uuid:=(p_result->'savedAddressRef'->>'resourceId')::uuid;
 v_existing commerce_customer_context.saved_address_source_receipts%ROWTYPE;
BEGIN
 IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE='42501'; END IF;
 IF p_result-ARRAY['actionInvocationId','operation','outcome','profile','savedAddressRef','revision','clearedDefaults','requestHash']<> '{}'::jsonb OR p_source-ARRAY['identity','effectId','mappingRevision','routeRevision','order','revision','purposes','nativeAddressId']<>'{}'::jsonb OR p_source->'identity'-ARRAY['issuer','namespace','recordType','recordId','occurrenceId','routeRef']<>'{}'::jsonb THEN RETURN QUERY SELECT 'CONFLICT'::text; RETURN; END IF;
 IF p_result->>'actionInvocationId' IS DISTINCT FROM p_invocation_id::text OR p_result->>'requestHash' IS DISTINCT FROM p_request_hash OR p_result->'profile'->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR p_result->'savedAddressRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR p_action_key IS DISTINCT FROM 'commerce.customer-context.'||lower(p_result->>'operation')||'-saved-address' OR p_auth_context_ref IS NULL OR btrim(p_auth_context_ref)='' THEN RETURN QUERY SELECT 'CONFLICT'::text; RETURN; END IF;
 PERFORM 1 FROM commerce_customer_context.saved_address_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active AND r.principal_id=p_actor_id AND r.route_ref=p_source->'identity'->>'routeRef' AND r.route_revision=p_source->>'routeRevision' AND r.mapping_revision=p_source->>'mappingRevision' AND r.issuer=p_source->'identity'->>'issuer' AND r.namespace=p_source->'identity'->>'namespace' AND r.record_type=p_source->'identity'->>'recordType' FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM commerce_customer_context.saved_addresses a WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id AND a.customer_profile_id=v_profile_id AND a.saved_address_id=v_address_id AND a.revision=(p_result->>'revision')::integer) THEN RETURN QUERY SELECT 'CONFLICT'::text; RETURN; END IF;
 SELECT * INTO v_existing FROM commerce_customer_context.saved_address_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.issuer=p_source->'identity'->>'issuer' AND r.namespace=p_source->'identity'->>'namespace' AND r.effect_id=p_source->>'effectId';
 IF FOUND THEN
  IF v_existing.action_invocation_id=p_invocation_id AND v_existing.actor_principal_id=p_actor_id AND v_existing.action_key=p_action_key AND v_existing.request_hash=p_request_hash AND v_existing.recorded_auth_context_ref=p_auth_context_ref AND v_existing.source=p_source AND v_existing.result=p_result THEN RETURN QUERY SELECT 'RECORDED'::text; ELSE RETURN QUERY SELECT 'CONFLICT'::text; END IF; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM commerce_customer_context.saved_address_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.saved_address_id=v_address_id AND (b.issuer<>p_source->'identity'->>'issuer' OR b.namespace<>p_source->'identity'->>'namespace' OR b.record_type<>p_source->'identity'->>'recordType' OR b.record_id<>p_source->'identity'->>'recordId' OR b.customer_profile_id<>v_profile_id)) THEN RETURN QUERY SELECT 'CONFLICT'::text; RETURN; END IF;
 INSERT INTO commerce_customer_context.saved_address_source_bindings(tenant_id,legal_entity_id,issuer,namespace,record_type,record_id,customer_profile_id,saved_address_id,source_order,source_revision) VALUES(p_tenant_id,p_legal_entity_id,p_source->'identity'->>'issuer',p_source->'identity'->>'namespace',p_source->'identity'->>'recordType',p_source->'identity'->>'recordId',v_profile_id,v_address_id,(p_source->>'order')::integer,p_source->>'revision') ON CONFLICT(tenant_id,legal_entity_id,issuer,namespace,record_type,record_id,customer_profile_id) DO UPDATE SET source_order=excluded.source_order,source_revision=excluded.source_revision WHERE saved_address_source_bindings.saved_address_id=excluded.saved_address_id AND saved_address_source_bindings.source_order<excluded.source_order AND saved_address_source_bindings.source_revision<>excluded.source_revision;
 IF NOT FOUND THEN RETURN QUERY SELECT 'CONFLICT'::text; RETURN; END IF;
 INSERT INTO commerce_customer_context.saved_address_source_receipts(tenant_id,legal_entity_id,issuer,namespace,effect_id,action_invocation_id,actor_principal_id,action_key,request_hash,recorded_auth_context_ref,source,result) VALUES(p_tenant_id,p_legal_entity_id,p_source->'identity'->>'issuer',p_source->'identity'->>'namespace',p_source->>'effectId',p_invocation_id,p_actor_id,p_action_key,p_request_hash,p_auth_context_ref,p_source,p_result);
 RETURN QUERY SELECT 'RECORDED'::text;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.record_saved_address_source_receipt(uuid,uuid,uuid,uuid,text,text,text,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.record_saved_address_source_receipt(uuid,uuid,uuid,uuid,text,text,text,jsonb,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_saved_address_source_receipt(
 p_tenant_id uuid,p_legal_entity_id uuid,p_actor_id uuid,p_original_actor_id uuid,p_expected_auth_context_ref text,p_input jsonb
) RETURNS TABLE(outcome text,result jsonb,recorded_principal_id uuid,recorded_action_key text,recorded_auth_context_ref text) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,commerce_customer_context,pg_temp SET row_security=on AS $$
DECLARE v_source jsonb:=p_input->'source'; v_receipt commerce_customer_context.saved_address_source_receipts%ROWTYPE; v_binding commerce_customer_context.saved_address_source_bindings%ROWTYPE; v_address commerce_customer_context.saved_addresses%ROWTYPE;
BEGIN
 IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_customer_context.saved_address_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active AND r.principal_id=(CASE WHEN p_input->>'mode'='RECEIPT' THEN p_original_actor_id ELSE p_actor_id END) AND r.route_ref=v_source->'identity'->>'routeRef' AND r.route_revision=v_source->>'routeRevision' AND r.mapping_revision=v_source->>'mappingRevision' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.record_type=v_source->'identity'->>'recordType') THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 IF p_input->'profile'->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 IF p_input->>'mode'='CURRENT' THEN
  SELECT * INTO v_binding FROM commerce_customer_context.saved_address_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_profile_id=(p_input->'profile'->'profileRef'->>'resourceId')::uuid AND b.issuer=v_source->'identity'->>'issuer' AND b.namespace=v_source->'identity'->>'namespace' AND b.record_type=v_source->'identity'->>'recordType' AND b.record_id=v_source->'identity'->>'recordId';
  IF NOT FOUND THEN RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','ABSENT'),NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  SELECT * INTO v_address FROM commerce_customer_context.saved_addresses a WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id AND a.saved_address_id=v_binding.saved_address_id AND a.customer_profile_id=v_binding.customer_profile_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','CURRENT','profile',p_input->'profile','savedAddressRef',jsonb_build_object('moduleId','commerce.customer-context','resourceType','commerce.customer-context.saved-address','resourceId',v_address.saved_address_id,'tenantId',p_tenant_id),'revision',v_address.revision,'lifecycle',v_address.lifecycle,'purposes',v_address.purposes),NULL::uuid,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO v_receipt FROM commerce_customer_context.saved_address_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.action_invocation_id=(p_input->>'actionInvocationId')::uuid AND r.actor_principal_id=p_original_actor_id AND r.action_key=p_input->>'actionKey' AND r.request_hash=p_input->>'requestHash' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.effect_id=v_source->>'effectId' AND r.source=v_source AND r.result->'profile'=p_input->'profile' AND (p_expected_auth_context_ref IS NULL OR r.recorded_auth_context_ref=p_expected_auth_context_ref);
 IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','RECEIPT','receipt',v_receipt.result),v_receipt.actor_principal_id,v_receipt.action_key,v_receipt.recorded_auth_context_ref;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_saved_address_source_receipt(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_saved_address_source_receipt(uuid,uuid,uuid,uuid,text,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER ccc_saved_address_source_receipts_append_only BEFORE UPDATE OR DELETE ON commerce_customer_context.saved_address_source_receipts FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.reject_append_only_mutation();
