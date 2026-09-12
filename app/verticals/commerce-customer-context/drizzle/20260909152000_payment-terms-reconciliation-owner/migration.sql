-- Payment Terms is a Commerce-owned reconciliation owner.  The verifier locks the case,
-- every member profile, and every retained Payment Terms fact in one Resolve Action transaction.
-- It proves facts and records no transfer: entitlements/preferences remain attached to their
-- original profile until an explicit, separately authorized Payment Terms Action changes them.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."verify_payment_terms_reconciliation_owner"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_case_id uuid,
  p_owner text,
  p_survivor_profile_id uuid,
  p_resulting_state text,
  p_desired_status text,
  p_expected_revision integer,
  p_expected_event_version bigint,
  p_effective_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid,
  p_policy_version text
) RETURNS TABLE(outcome text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_case profile_reconciliation_cases%ROWTYPE;
  v_member_facts jsonb;
  v_receipt jsonb;
  v_total_entitlements integer;
  v_total_preferences integer;
  v_current_preferences integer;
  v_survivor_current_preferences integer;
  v_non_survivor_current_preferences integer;
  v_horizon_entitlements integer;
  v_horizon_preferences integer;
  v_status text;
  v_evidence_ref text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_case_id IS NULL OR p_owner IS DISTINCT FROM 'PAYMENT_TERMS'
     OR p_survivor_profile_id IS NULL
     OR p_resulting_state IS NULL OR p_resulting_state NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
     OR p_desired_status IS NULL OR p_desired_status NOT IN ('RESOLVED','NOT_APPLICABLE')
     OR p_expected_revision IS NULL OR p_expected_event_version IS NULL
     OR p_effective_at IS NULL
     OR p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 1000
     OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL
     OR p_policy_version IS DISTINCT FROM 'customer-payment-terms-reconciliation.v1'
  THEN
    RETURN QUERY SELECT 'OWNER_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_case
    FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id
   FOR UPDATE;
  IF NOT FOUND OR v_case.lifecycle='COMPLETED'
     OR v_case.revision IS DISTINCT FROM p_expected_revision
     OR v_case.last_processed_event_version IS DISTINCT FROM p_expected_event_version
     OR NOT EXISTS (
       SELECT 1 FROM profile_reconciliation_case_members member
        WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
          AND member.profile_reconciliation_case_id=p_case_id
          AND member.customer_profile_id=p_survivor_profile_id
     )
  THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  -- Profile lifecycle Actions and Payment Terms Actions lock these same rows.  Keeping all locks
  -- in the verifier transaction prevents an owner receipt from being based on moving facts.
  PERFORM 1
    FROM profile_reconciliation_case_members member
    JOIN customer_profiles profile
      ON profile.tenant_id=member.tenant_id
     AND profile.legal_entity_id=member.legal_entity_id
     AND profile.customer_profile_id=member.customer_profile_id
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id
   ORDER BY member.member_position
   FOR UPDATE OF profile;

  PERFORM 1
    FROM profile_reconciliation_case_members member
    JOIN customer_payment_term_entitlements entitlement
      ON entitlement.tenant_id=member.tenant_id
     AND entitlement.legal_entity_id=member.legal_entity_id
     AND entitlement.customer_profile_id=member.customer_profile_id
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id
   FOR UPDATE OF entitlement;

  PERFORM 1
    FROM profile_reconciliation_case_members member
    JOIN customer_payment_term_preferences preference
      ON preference.tenant_id=member.tenant_id
     AND preference.legal_entity_id=member.legal_entity_id
     AND preference.customer_profile_id=member.customer_profile_id
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id
   FOR UPDATE OF preference;

  -- A durable Payment Terms aggregate must be independently valid before its profile can be
  -- resolved.  This catches future overlaps as well as currently effective overlaps.
  IF EXISTS (
    SELECT 1
      FROM customer_payment_term_entitlements left_entitlement
      JOIN customer_payment_term_entitlements right_entitlement
        ON right_entitlement.tenant_id=left_entitlement.tenant_id
       AND right_entitlement.legal_entity_id=left_entitlement.legal_entity_id
       AND right_entitlement.customer_profile_id=left_entitlement.customer_profile_id
       AND right_entitlement.payment_term_resource_id=left_entitlement.payment_term_resource_id
       AND right_entitlement.customer_payment_term_entitlement_id > left_entitlement.customer_payment_term_entitlement_id
     JOIN profile_reconciliation_case_members member
       ON member.tenant_id=left_entitlement.tenant_id
      AND member.legal_entity_id=left_entitlement.legal_entity_id
      AND member.customer_profile_id=left_entitlement.customer_profile_id
      AND member.profile_reconciliation_case_id=p_case_id
     WHERE left_entitlement.tenant_id=p_tenant_id
       AND left_entitlement.legal_entity_id=p_legal_entity_id
       AND left_entitlement.lifecycle IN ('ACTIVE','ENDED')
       AND right_entitlement.lifecycle IN ('ACTIVE','ENDED')
       AND left_entitlement.effective_from < coalesce(right_entitlement.effective_to,'infinity'::timestamptz)
       AND right_entitlement.effective_from < coalesce(left_entitlement.effective_to,'infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1
      FROM customer_payment_term_preferences preference
     JOIN profile_reconciliation_case_members member
       ON member.tenant_id=preference.tenant_id
      AND member.legal_entity_id=preference.legal_entity_id
      AND member.customer_profile_id=preference.customer_profile_id
      AND member.profile_reconciliation_case_id=p_case_id
     WHERE preference.tenant_id=p_tenant_id
       AND preference.legal_entity_id=p_legal_entity_id
       AND preference.lifecycle IN ('ACTIVE','ENDED')
       AND NOT EXISTS (
         SELECT 1
           FROM customer_payment_term_entitlements entitlement
          WHERE entitlement.tenant_id=preference.tenant_id
            AND entitlement.legal_entity_id=preference.legal_entity_id
            AND entitlement.customer_profile_id=preference.customer_profile_id
            AND entitlement.payment_term_resource_id=preference.payment_term_resource_id
            AND entitlement.lifecycle IN ('ACTIVE','ENDED')
            AND entitlement.effective_from <= preference.effective_from
            AND (entitlement.effective_to IS NULL OR (
              preference.effective_to IS NOT NULL
              AND preference.effective_to <= entitlement.effective_to
            ))
       )
  )
  THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  SELECT count(*)
    INTO v_total_entitlements
    FROM customer_payment_term_entitlements entitlement
    JOIN profile_reconciliation_case_members member
      ON member.tenant_id=entitlement.tenant_id
     AND member.legal_entity_id=entitlement.legal_entity_id
     AND member.customer_profile_id=entitlement.customer_profile_id
     AND member.profile_reconciliation_case_id=p_case_id
   WHERE entitlement.tenant_id=p_tenant_id AND entitlement.legal_entity_id=p_legal_entity_id;
  SELECT count(*)
    INTO v_horizon_entitlements
    FROM customer_payment_term_entitlements entitlement
    JOIN profile_reconciliation_case_members member
      ON member.tenant_id=entitlement.tenant_id
     AND member.legal_entity_id=entitlement.legal_entity_id
     AND member.customer_profile_id=entitlement.customer_profile_id
     AND member.profile_reconciliation_case_id=p_case_id
   WHERE entitlement.tenant_id=p_tenant_id AND entitlement.legal_entity_id=p_legal_entity_id
     AND entitlement.lifecycle IN ('ACTIVE','ENDED')
     AND (entitlement.effective_to IS NULL OR entitlement.effective_to > p_effective_at);
  SELECT count(*)
    INTO v_total_preferences
    FROM customer_payment_term_preferences preference
    JOIN profile_reconciliation_case_members member
      ON member.tenant_id=preference.tenant_id
     AND member.legal_entity_id=preference.legal_entity_id
     AND member.customer_profile_id=preference.customer_profile_id
     AND member.profile_reconciliation_case_id=p_case_id
   WHERE preference.tenant_id=p_tenant_id AND preference.legal_entity_id=p_legal_entity_id
     AND preference.lifecycle IN ('ACTIVE','ENDED');
  SELECT count(*)
    INTO v_current_preferences
    FROM customer_payment_term_preferences preference
    JOIN profile_reconciliation_case_members member
      ON member.tenant_id=preference.tenant_id
     AND member.legal_entity_id=preference.legal_entity_id
     AND member.customer_profile_id=preference.customer_profile_id
     AND member.profile_reconciliation_case_id=p_case_id
   WHERE preference.tenant_id=p_tenant_id AND preference.legal_entity_id=p_legal_entity_id
     AND preference.lifecycle IN ('ACTIVE','ENDED')
     AND preference.effective_from <= p_effective_at
     AND (preference.effective_to IS NULL OR preference.effective_to > p_effective_at);
  SELECT count(*)
    INTO v_survivor_current_preferences
    FROM customer_payment_term_preferences preference
   WHERE preference.tenant_id=p_tenant_id AND preference.legal_entity_id=p_legal_entity_id
     AND preference.customer_profile_id=p_survivor_profile_id
     AND preference.lifecycle IN ('ACTIVE','ENDED')
     AND preference.effective_from <= p_effective_at
     AND (preference.effective_to IS NULL OR preference.effective_to > p_effective_at);
  v_non_survivor_current_preferences:=v_current_preferences-v_survivor_current_preferences;

  SELECT count(*) FILTER (WHERE preference.lifecycle IN ('ACTIVE','ENDED'))
    INTO v_horizon_preferences
    FROM profile_reconciliation_case_members member
    JOIN customer_payment_term_preferences preference
      ON preference.tenant_id=member.tenant_id
     AND preference.legal_entity_id=member.legal_entity_id
     AND preference.customer_profile_id=member.customer_profile_id
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id
     AND (preference.effective_to IS NULL OR preference.effective_to > p_effective_at);

  -- The verifier never silently chooses a preference from an absorbed profile.  A single current
  -- survivor preference is already an explicit durable choice; all other current preferences block
  -- resolution until a dedicated Payment Terms Action records the choice.
  IF v_current_preferences > 1 OR v_non_survivor_current_preferences > 0 THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  v_status:=CASE WHEN v_total_entitlements + v_total_preferences = 0
                 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
  IF v_status IS DISTINCT FROM p_desired_status THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'profileId',member.customer_profile_id,
    'entitlements',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'entitlementId',entitlement.customer_payment_term_entitlement_id,
        'effectiveFrom',to_char(entitlement.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo',CASE WHEN entitlement.effective_to IS NULL THEN NULL ELSE to_char(entitlement.effective_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'lifecycle',entitlement.lifecycle,
        'paymentTermResourceId',entitlement.payment_term_resource_id,
        'semanticRevision',entitlement.payment_term_semantic_revision,
        'revision',entitlement.revision
      ) ORDER BY entitlement.effective_from,entitlement.customer_payment_term_entitlement_id)
      FROM customer_payment_term_entitlements entitlement
      WHERE entitlement.tenant_id=member.tenant_id
        AND entitlement.legal_entity_id=member.legal_entity_id
        AND entitlement.customer_profile_id=member.customer_profile_id
    ),'[]'::jsonb),
    'preferences',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'effectiveFrom',to_char(preference.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo',CASE WHEN preference.effective_to IS NULL THEN NULL ELSE to_char(preference.effective_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'lifecycle',preference.lifecycle,
        'paymentTermResourceId',preference.payment_term_resource_id,
        'revision',preference.revision
      ) ORDER BY preference.effective_from,preference.customer_payment_term_preference_id)
      FROM customer_payment_term_preferences preference
      WHERE preference.tenant_id=member.tenant_id
        AND preference.legal_entity_id=member.legal_entity_id
        AND preference.customer_profile_id=member.customer_profile_id
        AND preference.lifecycle IN ('ACTIVE','ENDED')
    ),'[]'::jsonb)
  ) ORDER BY member.member_position),'[]'::jsonb)
    INTO v_member_facts
    FROM profile_reconciliation_case_members member
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id;

  v_receipt:=jsonb_build_object(
    'actionInvocationId',p_action_invocation_id,
    'actorPrincipalId',p_actor_principal_id,
    'caseId',p_case_id,
    'caseRevision',v_case.revision,
    'currentPreferenceCount',v_current_preferences,
    'effectiveAt',to_char(p_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'eventVersion',v_case.last_processed_event_version::text,
    'futureOverlapInventory',jsonb_build_object(
      'entitlements',v_horizon_entitlements,
      'preferences',v_horizon_preferences
    ),
    'memberFacts',v_member_facts,
    'owner',p_owner,
    'policyVersion',p_policy_version,
    'reason',p_reason,
    'resultingState',p_resulting_state,
    'status',v_status,
    'survivorProfileId',p_survivor_profile_id,
    'totalEntitlements',v_total_entitlements,
    'totalPreferences',v_total_preferences
  );
  v_evidence_ref:='payment-terms-owner:'||p_policy_version||':'||md5(v_receipt::text);
  RETURN QUERY SELECT 'VERIFIED',jsonb_build_object(
    'owner',p_owner,'status',v_status,'evidenceRef',v_evidence_ref,
    'correlationRef',v_evidence_ref
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."verify_payment_terms_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,text,integer,bigint,timestamptz,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."verify_payment_terms_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,text,integer,bigint,timestamptz,text,uuid,uuid,text) TO "ontos_runtime";
