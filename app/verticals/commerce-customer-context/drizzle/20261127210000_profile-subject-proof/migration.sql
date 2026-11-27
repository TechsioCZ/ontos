-- Resolve a profile to its original Party source without recursively entering Privacy eligibility.
CREATE FUNCTION commerce_customer_context.read_source_profile_subject(p_tenant_id uuid,p_legal_entity_id uuid,p_profile_id uuid,p_kind text)
RETURNS TABLE(proof jsonb) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET row_security = on SET search_path = pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE item jsonb; binding jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  -- Ambiguous owner bindings are not subject evidence. Do not choose a convenient one.
  SELECT to_jsonb(b) INTO STRICT binding FROM commerce_customer_context.customer_profile_source_bindings b
    WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_profile_id=p_profile_id AND b.profile_kind=p_kind;
  item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,binding);
  IF item->'partySourceReference'->>'recordId' IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object('partyRef',item->'partyRef','sourceReference',item->'partySourceReference','profileRef',item->'profile'->'profileRef','legalEntityId',p_legal_entity_id);
EXCEPTION WHEN no_data_found OR too_many_rows THEN RETURN;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_source_profile_subject(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_source_profile_subject(uuid,uuid,uuid,text) TO ontos_runtime;
