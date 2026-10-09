-- The read-only half of `ensure_retail_profile`.
--
-- `ensure_retail_profile` is read-or-create, so it cannot answer "does this Tenant, Legal Entity and
-- Party already hold a Retail Customer Profile?" without creating one when the answer is no. An
-- enrollment reconciling a lost ensure response needs exactly that question, so it gets its own
-- SELECT-only routine. `STABLE` is the enforcement, not a hint: PL/pgSQL refuses to run a data
-- modifying statement inside a non-volatile function.
--
-- An open reconciliation case makes the Party's profile identity contested, so this routine reports
-- that rather than naming a profile the owner has not settled on — the same refusal
-- `ensure_retail_profile` and `read_retail_portal_binding` already make.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_retail_profile_by_party"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_party_resource_id text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_case_id uuid;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_party_resource_id IS NULL OR btrim(p_party_resource_id) = '' THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM profile_reconciliation_cases c
     WHERE c.tenant_id = p_tenant_id AND c.legal_entity_id = p_legal_entity_id
       AND c.profile_kind = 'RETAIL'
       AND c.canonical_party_resource_id = btrim(p_party_resource_id)
       AND c.lifecycle <> 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;

  SELECT cp.* INTO v_profile
    FROM retail_customer_profiles rp
    JOIN customer_profiles cp
      ON cp.tenant_id = rp.tenant_id
     AND cp.legal_entity_id = rp.legal_entity_id
     AND cp.customer_profile_id = rp.retail_customer_profile_id
   WHERE rp.tenant_id = p_tenant_id
     AND rp.legal_entity_id = p_legal_entity_id
     AND rp.party_resource_id = btrim(p_party_resource_id);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;

  SELECT c.profile_reconciliation_case_id INTO v_case_id
    FROM profile_reconciliation_case_members m
    JOIN profile_reconciliation_cases c
      USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
   WHERE m.tenant_id = p_tenant_id AND m.legal_entity_id = p_legal_entity_id
     AND m.customer_profile_id = v_profile.customer_profile_id
     AND c.lifecycle <> 'COMPLETED'
   ORDER BY c.recorded_at
   LIMIT 1;
  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'PROFILE_AVAILABLE', jsonb_build_object(
    'outcome', 'PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle,
    'profileRef', jsonb_build_object(
      'moduleId', 'commerce.customer-context',
      'resourceId', v_profile.customer_profile_id,
      'resourceType', 'commerce.customer-context.retail-customer-profile',
      'tenantId', p_tenant_id),
    'revision', v_profile.revision,
    'state', v_profile.lifecycle
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_retail_profile_by_party"(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_retail_profile_by_party"(uuid,uuid,text) TO "ontos_runtime";
