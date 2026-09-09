ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "canonicalization_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "commerce_customer_context"."profile_reconciliation_cases"
SET "trigger"='IMPORT_CORRELATION',
    "canonicalization_evidence"=jsonb_build_object(
      'evidenceKind','AUTHORIZED_OPERATOR_DECISION',
      'decisionRef','migration:action-invocation:' || "action_invocation_id"::text,
      'policyVersion','profile-canonicalization-migration.v1',
      'observedAt',to_char("recorded_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
WHERE "action_invocation_id" IS NOT NULL;--> statement-breakpoint
DO $canonicalization_evidence_backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "commerce_customer_context"."profile_reconciliation_cases"
     WHERE "canonicalization_evidence" IS NULL
  ) THEN
    RAISE EXCEPTION 'Profile reconciliation canonicalization evidence cannot be inferred; explicit owner migration is required';
  END IF;
END
$canonicalization_evidence_backfill$;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ALTER COLUMN "canonicalization_evidence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_canonicalization_evidence_ck" CHECK (jsonb_typeof("canonicalization_evidence") = 'object');--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."open_profile_reconciliation"(uuid,uuid,uuid[],text,text,jsonb,jsonb,timestamptz,text,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."observe_party_merge_reconciliation"(uuid,uuid,text,uuid,uuid,bigint,timestamptz,text,text,text[],jsonb,uuid) TO "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."reconcile_profile_reconciliation_owner"(
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
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_case profile_reconciliation_cases%ROWTYPE;
  v_total_bindings integer;
  v_conflicting_bindings integer;
  v_lifecycle_mismatches integer;
  v_status text;
  v_provenance_ref text;
  v_evidence_ref text;
  v_existing_status text;
  v_existing_evidence_ref text;
  v_existing_correlation_ref text;
  v_existing_event_version bigint;
  v_existing_survivor_profile_id uuid;
  v_existing_resulting_state text;
  v_has_existing boolean := false;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_case_id IS NULL OR p_survivor_profile_id IS NULL
     OR p_owner IS NULL OR p_owner NOT IN ('PROFILE_LIFECYCLE','RETAIL_PORTAL_BINDING')
     OR p_resulting_state IS NULL OR p_resulting_state NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
     OR p_desired_status IS NULL OR p_desired_status NOT IN ('RESOLVED','NOT_APPLICABLE')
     OR p_expected_revision IS NULL OR p_expected_event_version IS NULL
     OR p_effective_at IS NULL OR nullif(btrim(p_reason),'') IS NULL
     OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL THEN
    RETURN QUERY SELECT 'OWNER_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;
  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id;
  IF NOT FOUND OR NOT EXISTS (
       SELECT 1 FROM profile_reconciliation_case_members member
        WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
          AND member.profile_reconciliation_case_id=p_case_id
          AND member.customer_profile_id=p_survivor_profile_id
     ) THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  -- This verifier is intentionally read-only.  Establish the exact canonical target and
  -- provenance before the action compares the desired owner receipt and persists progress.
  IF v_case.profile_kind NOT IN ('RETAIL','COUNTERPARTY')
     OR nullif(btrim(v_case.source_correlation_ref),'') IS NULL
     OR jsonb_typeof(v_case.target_subject) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_case.canonicalization_evidence) IS DISTINCT FROM 'object'
     OR nullif(btrim(v_case.canonicalization_evidence->>'evidenceKind'),'') IS NULL
     OR nullif(btrim(v_case.canonicalization_evidence->>'decisionRef'),'') IS NULL
     OR nullif(btrim(v_case.canonicalization_evidence->>'policyVersion'),'') IS NULL
     OR v_case.target_subject->>'kind' IS DISTINCT FROM v_case.profile_kind
     OR (
       v_case.profile_kind='RETAIL'
       AND (
         v_case.target_subject->'partyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
         OR v_case.target_subject->'partyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.party'
         OR v_case.target_subject->'partyRef'->>'resourceId' IS DISTINCT FROM v_case.canonical_party_resource_id
         OR v_case.target_subject->'partyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
         OR v_case.target_subject->'sellingLegalEntityRef'->>'moduleId' IS DISTINCT FROM 'core.identity'
         OR v_case.target_subject->'sellingLegalEntityRef'->>'resourceType' IS DISTINCT FROM 'core.identity.legal-entity'
         OR v_case.target_subject->'sellingLegalEntityRef'->>'resourceId' IS DISTINCT FROM p_legal_entity_id::text
         OR v_case.target_subject->'sellingLegalEntityRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
         OR NOT EXISTS (
           SELECT 1
             FROM retail_customer_profiles retail
            WHERE retail.tenant_id=p_tenant_id AND retail.legal_entity_id=p_legal_entity_id
              AND retail.retail_customer_profile_id=p_survivor_profile_id
              AND retail.party_resource_id=v_case.canonical_party_resource_id
         )
       )
     )
     OR (
       v_case.profile_kind='COUNTERPARTY'
       AND (
         v_case.target_subject->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
         OR v_case.target_subject->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
         OR v_case.target_subject->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_case.canonical_party_resource_id
         OR v_case.target_subject->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
         OR NOT EXISTS (
           SELECT 1
             FROM counterparty_purchasing_profiles counterparty
            WHERE counterparty.tenant_id=p_tenant_id AND counterparty.legal_entity_id=p_legal_entity_id
              AND counterparty.counterparty_purchasing_profile_id=p_survivor_profile_id
              AND counterparty.counterparty_resource_id=v_case.canonical_party_resource_id
         )
       )
     ) THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  SELECT recorded.status,recorded.evidence_ref,recorded.correlation_ref,recorded.event_version,
         recorded.survivor_profile_id,recorded.resulting_state
    INTO v_existing_status,v_existing_evidence_ref,v_existing_correlation_ref,v_existing_event_version,
         v_existing_survivor_profile_id,v_existing_resulting_state
    FROM profile_reconciliation_owner_outcomes recorded
   WHERE recorded.tenant_id=p_tenant_id AND recorded.legal_entity_id=p_legal_entity_id
     AND recorded.profile_reconciliation_case_id=p_case_id AND recorded.owner=p_owner
     AND recorded.status IN ('RESOLVED','NOT_APPLICABLE')
     AND recorded.event_version=v_case.last_processed_event_version
   ORDER BY recorded.case_revision DESC
   LIMIT 1;
  v_has_existing:=FOUND;

  IF NOT v_has_existing AND (v_case.lifecycle='COMPLETED'
     OR v_case.revision IS DISTINCT FROM p_expected_revision
     OR v_case.last_processed_event_version IS DISTINCT FROM p_expected_event_version) THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  IF p_owner='PROFILE_LIFECYCLE' THEN
    SELECT count(*) INTO v_lifecycle_mismatches
      FROM profile_reconciliation_case_members member
      JOIN customer_profiles profile
        ON profile.tenant_id=member.tenant_id AND profile.legal_entity_id=member.legal_entity_id
       AND profile.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
       AND ((member.customer_profile_id=p_survivor_profile_id AND profile.lifecycle<>p_resulting_state)
         OR (member.customer_profile_id<>p_survivor_profile_id AND profile.lifecycle<>'ARCHIVED'));
    IF v_lifecycle_mismatches<>0 THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    v_status:='RESOLVED';
  ELSE
    IF v_case.profile_kind<>'RETAIL' THEN
      v_status:='NOT_APPLICABLE';
    ELSE
      SELECT count(*) FILTER (WHERE binding.lifecycle='ACTIVE'),count(*) FILTER (
        WHERE binding.lifecycle='ACTIVE'
          AND binding.retail_customer_profile_id<>p_survivor_profile_id
      ) INTO v_total_bindings,v_conflicting_bindings
        FROM profile_reconciliation_case_members member
        JOIN retail_portal_profile_bindings binding
          ON binding.tenant_id=member.tenant_id AND binding.legal_entity_id=member.legal_entity_id
         AND binding.retail_customer_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id;
      IF v_conflicting_bindings<>0 THEN
        RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
        RETURN;
      END IF;
      v_status:=CASE WHEN v_total_bindings=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
    END IF;
  END IF;

  IF v_status IS DISTINCT FROM p_desired_status THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;
  v_provenance_ref:='profile-case:v1:'||md5(
    p_tenant_id::text||':'||p_legal_entity_id::text||':'||p_case_id::text||':'||
    v_case.source_correlation_ref||':'||v_case.canonical_party_resource_id||':'||
    v_case.target_subject::text||':'||v_case.canonicalization_evidence::text
  );
  v_evidence_ref:='profile-owner:v2:'||lower(p_owner)||':'||p_case_id::text||':'||
    p_survivor_profile_id::text||':'||lower(p_resulting_state)||':'||
    v_case.last_processed_event_version::text||':'||lower(v_status)||':'||v_provenance_ref;
  IF v_has_existing THEN
    IF v_existing_status IS DISTINCT FROM v_status
       OR v_existing_evidence_ref IS DISTINCT FROM v_evidence_ref
       OR v_existing_correlation_ref IS DISTINCT FROM v_evidence_ref
       OR v_existing_event_version IS DISTINCT FROM p_expected_event_version
       OR v_existing_survivor_profile_id IS DISTINCT FROM p_survivor_profile_id
       OR v_existing_resulting_state IS DISTINCT FROM p_resulting_state THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'VERIFIED',jsonb_build_object(
      'owner',p_owner,'status',v_existing_status,'evidenceRef',v_existing_evidence_ref,
      'correlationRef',v_existing_correlation_ref,'survivorProfileId',p_survivor_profile_id,
      'resultingState',p_resulting_state,'provenanceRef',v_provenance_ref
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT 'VERIFIED',jsonb_build_object(
    'owner',p_owner,'status',v_status,'evidenceRef',v_evidence_ref,
    'correlationRef',v_evidence_ref,'survivorProfileId',p_survivor_profile_id,
    'resultingState',p_resulting_state,'provenanceRef',v_provenance_ref
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."reconcile_profile_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,text,integer,bigint,timestamptz,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reconcile_profile_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,text,integer,bigint,timestamptz,text,uuid,uuid) TO "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."verify_currency_preference_reconciliation_owner"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_case_id uuid,
  p_owner text,
  p_survivor_profile_id uuid,
  p_resulting_state text,
  p_expected_revision integer,
  p_expected_event_version bigint,
  p_effective_at timestamptz,
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
  v_total_present integer;
  v_survivor_present integer;
  v_conflicting_present integer;
  v_status text;
  v_evidence_ref text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_case_id IS NULL OR p_survivor_profile_id IS NULL
     OR p_owner IS DISTINCT FROM 'CURRENCY_PREFERENCE'
     OR p_resulting_state IS NULL OR p_resulting_state NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
     OR p_expected_revision IS NULL OR p_expected_event_version IS NULL
     OR p_effective_at IS NULL OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL
     OR p_policy_version IS DISTINCT FROM 'currency-preference-reconciliation.v1' THEN
    RETURN QUERY SELECT 'OWNER_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id FOR UPDATE;
  IF NOT FOUND OR v_case.lifecycle='COMPLETED'
     OR v_case.revision IS DISTINCT FROM p_expected_revision
     OR v_case.last_processed_event_version IS DISTINCT FROM p_expected_event_version
     OR NOT EXISTS (
       SELECT 1 FROM profile_reconciliation_case_members member
        WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
          AND member.profile_reconciliation_case_id=p_case_id
          AND member.customer_profile_id=p_survivor_profile_id
     ) THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  -- Currency changes lock these same profile rows, so the facts remain stable until the enclosing
  -- Resolve Action transaction records the returned owner receipt.
  PERFORM 1 FROM profile_reconciliation_case_members member
    JOIN customer_profiles profile
      ON profile.tenant_id=member.tenant_id AND profile.legal_entity_id=member.legal_entity_id
     AND profile.customer_profile_id=member.customer_profile_id
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id
   ORDER BY member.member_position
   FOR UPDATE OF profile;

  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'profileId',member.customer_profile_id,
      'profileKind',profile.profile_kind,
      'currentPreference',CASE WHEN preference.customer_currency_preference_id IS NULL THEN NULL
        ELSE jsonb_build_object(
          'currencyCode',preference.currency_code,
          'preferenceId',preference.customer_currency_preference_id,
          'revision',preference.revision
        ) END
    ) ORDER BY member.member_position),'[]'::jsonb),
    count(*) FILTER (WHERE preference.customer_currency_preference_id IS NOT NULL),
    count(*) FILTER (WHERE preference.customer_currency_preference_id IS NOT NULL
      AND member.customer_profile_id=p_survivor_profile_id),
    count(*) FILTER (WHERE preference.customer_currency_preference_id IS NOT NULL
      AND member.customer_profile_id<>p_survivor_profile_id)
    INTO v_member_facts,v_total_present,v_survivor_present,v_conflicting_present
    FROM profile_reconciliation_case_members member
    JOIN customer_profiles profile
      ON profile.tenant_id=member.tenant_id AND profile.legal_entity_id=member.legal_entity_id
     AND profile.customer_profile_id=member.customer_profile_id
    LEFT JOIN customer_currency_preferences preference
      ON preference.tenant_id=member.tenant_id
     AND preference.legal_entity_id=member.legal_entity_id
     AND preference.customer_profile_id=member.customer_profile_id
     AND preference.effective_to IS NULL
     AND preference.lifecycle='ACTIVE'
     AND preference.currency_code IS NOT NULL
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id;

  IF v_conflicting_present<>0 OR v_survivor_present>1
     OR (v_total_present<>0 AND v_survivor_present<>1) THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;
  v_status:=CASE WHEN v_total_present=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
  v_receipt:=jsonb_build_object(
    'actionInvocationId',p_action_invocation_id,
    'actorPrincipalId',p_actor_principal_id,
    'afterFacts',v_member_facts,
    'beforeFacts',v_member_facts,
    'caseId',p_case_id,
    'caseRevision',v_case.revision,
    'effectiveAt',to_char(p_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'eventVersion',v_case.last_processed_event_version::text,
    'members',v_member_facts,
    'owner',p_owner,
    'policyVersion',p_policy_version,
    'resultingState',p_resulting_state,
    'status',v_status,
    'survivorProfileId',p_survivor_profile_id
  );
  v_evidence_ref:='currency-preference-owner:'||p_policy_version||':'||md5(v_receipt::text);
  RETURN QUERY SELECT 'VERIFIED',jsonb_build_object(
    'owner',p_owner,'status',v_status,'evidenceRef',v_evidence_ref,
    'correlationRef',v_evidence_ref
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."verify_currency_preference_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,integer,bigint,timestamptz,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."verify_currency_preference_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,integer,bigint,timestamptz,uuid,uuid,text) TO "ontos_runtime";
