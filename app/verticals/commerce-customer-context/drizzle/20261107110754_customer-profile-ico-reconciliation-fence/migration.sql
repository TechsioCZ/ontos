CREATE OR REPLACE FUNCTION commerce_customer_context.customer_profile_ico_state(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_id uuid := (p_input->'profileRef'->>'resourceId')::uuid;
  v_history jsonb;
  v_current jsonb;
  v_authority commerce_customer_context.customer_profile_ico_authority%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR p_input->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb; RETURN;
  END IF;
  SELECT * INTO v_profile FROM commerce_customer_context.customer_profiles
    WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id
    AND profile_kind=p_input->'profileRef'->>'kind'
    AND (profile_kind='COUNTERPARTY' OR legal_entity_id=p_legal_entity_id);
  IF NOT FOUND OR NOT (
    (v_profile.profile_kind='RETAIL' AND EXISTS (
      SELECT 1 FROM commerce_customer_context.retail_customer_profiles WHERE tenant_id=p_tenant_id
      AND retail_customer_profile_id=v_id AND legal_entity_id=p_legal_entity_id
      AND party_resource_id=p_input->'authorizationSubject'->'partyRef'->>'resourceId'
      AND p_input->'authorizationSubject'->'sellingLegalEntityRef'->>'resourceId'=p_legal_entity_id::text))
    OR (v_profile.profile_kind='COUNTERPARTY' AND EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles WHERE tenant_id=p_tenant_id
      AND counterparty_purchasing_profile_id=v_id
      AND counterparty_resource_id=p_input->'authorizationSubject'->'counterpartyRef'->>'resourceId'))
  ) THEN RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM commerce_customer_context.profile_reconciliation_case_members m JOIN commerce_customer_context.profile_reconciliation_cases c USING(tenant_id,legal_entity_id,profile_reconciliation_case_id)
    WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id AND m.customer_profile_id=v_id AND c.lifecycle<>'COMPLETED') THEN
    RETURN QUERY SELECT 'MIGRATION_REQUIRED',jsonb_build_object('_tag','MIGRATION_REQUIRED','profileRef',p_input->'profileRef');RETURN;
  END IF;
  SELECT * INTO v_authority FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id;
  IF NOT FOUND OR v_authority.phase <> 'COMMERCE' OR coalesce(v_authority.plan->'migrationRequiredProfileIds','[]'::jsonb) ? v_id::text THEN
    RETURN QUERY SELECT 'MIGRATION_REQUIRED', jsonb_build_object('_tag','MIGRATION_REQUIRED','profileRef',p_input->'profileRef'); RETURN;
  END IF;
  IF p_input ? 'effectId' THEN
    SELECT assertion INTO v_current FROM commerce_customer_context.customer_profile_ico_assertions
      WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND effect_id=p_input->>'effectId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'EFFECT_NOT_FOUND',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','RECEIPT','profileRef',p_input->'profileRef','assertion',v_current);RETURN;
  END IF;
  SELECT coalesce(jsonb_agg(assertion ORDER BY revision),'[]'::jsonb) INTO v_history
    FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id;
  SELECT assertion INTO v_current FROM commerce_customer_context.customer_profile_ico_assertions
    WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND effective_at<=coalesce((p_input->>'asOf')::timestamptz,current_timestamp)
    ORDER BY revision DESC LIMIT 1;
  IF v_current->>'operation'='END' THEN v_current:=NULL;END IF;
  RETURN QUERY SELECT 'AVAILABLE', jsonb_build_object('_tag',CASE WHEN v_current IS NULL THEN 'ABSENT' ELSE 'PRESENT' END,
    'profileRef',p_input->'profileRef','current',v_current,'history',v_history,'revision',jsonb_array_length(v_history));
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.profile_ico_target_inventory(p_tenant_id uuid,p_legal_entity_id uuid)
RETURNS TABLE(result jsonb) LANGUAGE plpgsql SECURITY DEFINER SET row_security = on SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$ DECLARE v_targets jsonb; BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RAISE EXCEPTION 'invalid scope' USING ERRCODE='42501';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('profileRef',jsonb_build_object('kind',profile_kind,'moduleId','commerce.customer-context','resourceType',CASE WHEN profile_kind='RETAIL' THEN 'commerce.customer-context.retail-customer-profile' ELSE 'commerce.customer-context.counterparty-purchasing-profile' END,'resourceId',customer_profile_id::text,'tenantId',tenant_id::text),'legalEntityId',legal_entity_id::text,'subjectResourceId',subject_resource_id,'revision',revision,'lifecycle',lifecycle,'reconciliationRequired',EXISTS(SELECT 1 FROM commerce_customer_context.profile_reconciliation_case_members m JOIN commerce_customer_context.profile_reconciliation_cases c USING(tenant_id,legal_entity_id,profile_reconciliation_case_id) WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id AND m.customer_profile_id=customer_profile_ico_target_inventory.customer_profile_id AND c.lifecycle<>'COMPLETED')) ORDER BY customer_profile_id),'[]'::jsonb) INTO v_targets FROM commerce_customer_context.customer_profile_ico_target_inventory WHERE tenant_id=p_tenant_id;
  RETURN QUERY SELECT jsonb_build_object('targets',v_targets,'version',md5(v_targets::text));
END; $$;
--> statement-breakpoint
CREATE TRIGGER ccc_ico_reconciliation_case_lock BEFORE INSERT OR UPDATE OR DELETE ON commerce_customer_context.profile_reconciliation_cases FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.lock_profile_ico_inventory();
--> statement-breakpoint
CREATE TRIGGER ccc_ico_reconciliation_member_lock BEFORE INSERT OR DELETE ON commerce_customer_context.profile_reconciliation_case_members FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.lock_profile_ico_inventory();
