-- Resolve a profile to its original Party source without recursively entering Privacy eligibility.
CREATE FUNCTION commerce_customer_context.read_source_profile_subject(p_tenant_id uuid,p_legal_entity_id uuid,p_profile_id uuid,p_kind text,p_person_record jsonb)
RETURNS TABLE(proof jsonb) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET row_security = on SET search_path = pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE binding jsonb; item jsonb; chosen jsonb; party text; seen integer := 0;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  -- A profile keeps one binding per source record, so several records of one person are several bindings that agree
  -- on its Party. The caller's exact person record selects its own binding; a request that names no record (a
  -- membership whose customer the caller does not know yet) gets the earliest recorded binding, the canonical owner
  -- identity.
  FOR binding IN SELECT to_jsonb(b) FROM commerce_customer_context.customer_profile_source_bindings b
    WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_profile_id=p_profile_id AND b.profile_kind=p_kind
    ORDER BY b.recorded_at,b.issuer,b.namespace,b.record_type,b.record_id LIMIT 65
  LOOP
    seen:=seen+1;
    item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,binding);
    -- A binding the current profile no longer supports, or one that names another Party, is a conflict: prove nothing.
    IF seen>64 OR item IS NULL OR item->'partyRef'->>'resourceId' IS DISTINCT FROM COALESCE(party,item->'partyRef'->>'resourceId') THEN RETURN; END IF;
    party:=item->'partyRef'->>'resourceId';
    IF chosen IS NULL AND item->'partySourceReference'->>'recordId' IS NOT NULL AND (p_person_record->>'recordId' IS NULL OR (
      item->'partySourceReference'->>'recordId'=p_person_record->>'recordId'
      AND item->'partySourceReference'->'source'->>'issuer'=p_person_record->'source'->>'issuer'
      AND item->'partySourceReference'->'source'->>'namespace'=p_person_record->'source'->>'namespace'
      AND item->'partySourceReference'->'source'->>'recordType'=p_person_record->'source'->>'recordType'
      AND item->'partySourceReference'->'source'->>'routeRef'=p_person_record->'source'->>'routeRef')) THEN chosen:=item; END IF;
  END LOOP;
  IF chosen IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object('partyRef',chosen->'partyRef','sourceReference',chosen->'partySourceReference','profileRef',chosen->'profile'->'profileRef','legalEntityId',p_legal_entity_id);
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_source_profile_subject(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_source_profile_subject(uuid,uuid,uuid,text,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE INDEX "ccc_profile_source_bindings_profile_idx" ON "commerce_customer_context"."customer_profile_source_bindings" ("tenant_id","legal_entity_id","customer_profile_id");
