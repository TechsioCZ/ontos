CREATE FUNCTION commerce_customer_context.read_organization_customer_profile_source_receipt(
 p_tenant_id uuid,p_legal_entity_id uuid,p_original_actor_id uuid,p_expected_invocation_id uuid,p_input jsonb
) RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security=on SET search_path=pg_catalog,commerce_customer_context,pg_temp AS $$
DECLARE v_row record;v_receipt jsonb;v_current jsonb;v_intent jsonb;v_profile jsonb;v_safe_intent jsonb;
BEGIN
 IF p_original_actor_id IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
 SELECT * INTO v_row FROM commerce_customer_context.read_customer_profile_source(p_tenant_id,p_legal_entity_id,p_original_actor_id,p_input||jsonb_build_object('mode','RECEIPT'));
 IF NOT FOUND THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
 IF v_row.outcome<>'AVAILABLE' THEN RETURN QUERY SELECT v_row.outcome,NULL::jsonb;RETURN;END IF;
 v_receipt:=v_row.result->'receipt';v_current:=v_row.result->'current';v_intent:=v_receipt->'intent';v_profile:=v_current->'profile';
 IF v_receipt->>'profileKind'<>'COUNTERPARTY' OR v_profile->'subject'->>'kind'<>'COUNTERPARTY'
   OR v_receipt->>'actorPrincipalId' IS DISTINCT FROM p_original_actor_id::text
   OR (p_expected_invocation_id IS NOT NULL AND v_receipt->>'actionInvocationId' IS DISTINCT FROM p_expected_invocation_id::text)
   OR v_intent->'source' IS NULL OR v_intent->'partySourceReference' IS NULL
   OR v_receipt->'result'->'sourceEffect'->>'effectId' IS DISTINCT FROM v_intent->'source'->>'effectId'
   OR v_receipt->'result'->'profileRef'->>'resourceId' IS DISTINCT FROM v_profile->'profileRef'->>'resourceId'
 THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
 v_safe_intent:=jsonb_build_object('effectiveAt',v_intent->'effectiveAt','trigger',v_intent->'trigger','source',v_intent->'source','partySourceReference',v_intent->'partySourceReference','subject',jsonb_build_object('kind','COUNTERPARTY','counterpartyRef',v_intent->'subject'->'counterpartyRef'));
 RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object(
   'current',jsonb_build_object('partyRef',v_current->'partyRef','counterpartyRef',v_profile->'subject'->'counterpartyRef','profileRevision',v_profile->'revision'),
   'receipt',jsonb_build_object('actionInvocationId',v_receipt->'actionInvocationId','profileKind','COUNTERPARTY','recordedAt',v_receipt->'recordedAt','intent',v_safe_intent,'result',v_receipt->'result'));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_organization_customer_profile_source_receipt(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_organization_customer_profile_source_receipt(uuid,uuid,uuid,uuid,jsonb) TO ontos_runtime;
