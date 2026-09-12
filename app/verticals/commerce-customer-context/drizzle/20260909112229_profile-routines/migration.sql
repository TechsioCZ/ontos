-- Customer Profile persistence boundary.
--
-- These routines are deliberately PL/pgSQL: this custom migration is serialized before the
-- native profile-completion migration and PL/pgSQL defers relation/column statement planning
-- until invocation, after the full migration chain is installed.

CREATE OR REPLACE FUNCTION "commerce_customer_context"."assert_profile_operation_scope"(
  p_tenant_id uuid,
  p_legal_entity_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $scope$
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
     OR nullif(current_setting('ontos.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id
     OR nullif(current_setting('ontos.legal_entity_id', true), '')::uuid IS DISTINCT FROM p_legal_entity_id
  THEN
    RAISE EXCEPTION 'verified Commerce Customer Context scope is required' USING ERRCODE = '42501';
  END IF;
END
$scope$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."ensure_retail_profile"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_party_resource_id text,
  p_party_resource_revision text,
  p_attribution_kind text,
  p_effective_at timestamptz,
  p_trigger text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_canonical_profile_ids uuid[];
  v_merge_outcome text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_effective_at IS NULL
     OR p_party_resource_id IS NULL OR btrim(p_party_resource_id) = ''
     OR p_attribution_kind IS NULL
     OR p_attribution_kind NOT IN ('AUTHENTICATED', 'GUEST_ACCEPTANCE', 'RECONCILED')
     OR p_trigger IS NULL
     OR p_trigger NOT IN ('AUTHORIZED_ONBOARDING', 'ENSURE_BEFORE_ORDER_ACCEPTANCE', 'GUEST_RETAIL_ATTRIBUTION')
  THEN
    RETURN QUERY SELECT 'SUBJECT_NOT_RESOLVED_OR_INVALID', NULL::jsonb;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':retail:' || btrim(p_party_resource_id), 0));

  IF EXISTS (
    SELECT 1
      FROM profile_reconciliation_cases c
     WHERE c.tenant_id=p_tenant_id AND c.legal_entity_id=p_legal_entity_id
       AND c.profile_kind='RETAIL'
       AND c.canonical_party_resource_id=btrim(p_party_resource_id)
       AND c.lifecycle<>'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED',NULL::jsonb;
    RETURN;
  END IF;

  SELECT observation.outcome INTO v_merge_outcome
    FROM party_merge_profile_observations observation
   WHERE observation.tenant_id=p_tenant_id AND observation.legal_entity_id=p_legal_entity_id
     AND (observation.survivor_party_resource_id=btrim(p_party_resource_id)
       OR btrim(p_party_resource_id)=ANY(observation.absorbed_party_resource_ids))
   ORDER BY observation.event_version DESC
   LIMIT 1;
  IF FOUND AND v_merge_outcome='RECONCILIATIONS_OBSERVED' THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED',NULL::jsonb;
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT canonical_profile_id) INTO v_canonical_profile_ids
    FROM (
      SELECT c.canonical_profile_id
        FROM profile_reconciliation_cases c
       WHERE c.tenant_id=p_tenant_id AND c.legal_entity_id=p_legal_entity_id
         AND c.profile_kind='RETAIL'
         AND c.canonical_party_resource_id=btrim(p_party_resource_id)
         AND c.lifecycle='COMPLETED' AND c.canonical_profile_id IS NOT NULL
      UNION ALL
      SELECT o.canonicalized_profile_id
        FROM party_merge_profile_observations o
       WHERE o.tenant_id=p_tenant_id AND o.legal_entity_id=p_legal_entity_id
         AND (o.survivor_party_resource_id=btrim(p_party_resource_id)
           OR btrim(p_party_resource_id)=ANY(o.absorbed_party_resource_ids))
         AND o.canonicalized_profile_id IS NOT NULL
    ) canonical_mappings;
  IF coalesce(cardinality(v_canonical_profile_ids),0)>1 THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED',NULL::jsonb; RETURN;
  END IF;

  IF coalesce(cardinality(v_canonical_profile_ids),0)=1 THEN
    SELECT cp.* INTO v_profile FROM customer_profiles cp
     WHERE cp.tenant_id=p_tenant_id AND cp.legal_entity_id=p_legal_entity_id
       AND cp.customer_profile_id=v_canonical_profile_ids[1]
     FOR UPDATE;
  ELSE
    SELECT cp.* INTO v_profile
    FROM retail_customer_profiles rp
    JOIN customer_profiles cp
      ON cp.tenant_id = rp.tenant_id
     AND cp.legal_entity_id = rp.legal_entity_id
     AND cp.customer_profile_id = rp.retail_customer_profile_id
    WHERE rp.tenant_id = p_tenant_id
      AND rp.legal_entity_id = p_legal_entity_id
      AND rp.party_resource_id = btrim(p_party_resource_id)
    FOR UPDATE OF cp;
  END IF;

  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM profile_reconciliation_case_members m
      JOIN profile_reconciliation_cases c
        ON c.tenant_id = m.tenant_id AND c.legal_entity_id = m.legal_entity_id
       AND c.profile_reconciliation_case_id = m.profile_reconciliation_case_id
      WHERE m.tenant_id = p_tenant_id AND m.legal_entity_id = p_legal_entity_id
        AND m.customer_profile_id = v_profile.customer_profile_id
        AND c.lifecycle <> 'COMPLETED'
    ) THEN
      RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
      RETURN;
    END IF;
    RETURN QUERY SELECT
      ('PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle)::text,
      jsonb_build_object(
        'outcome', 'PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle,
        'profileRef', jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_profile.customer_profile_id,'resourceType','commerce.customer-context.retail-customer-profile','tenantId',p_tenant_id),
        'revision', v_profile.revision,
        'state', v_profile.lifecycle
      );
    RETURN;
  END IF;

  INSERT INTO customer_profiles(tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
  VALUES (p_tenant_id, p_legal_entity_id, 'RETAIL', 'ACTIVE', 1)
  RETURNING * INTO v_profile;

  INSERT INTO retail_customer_profiles(
    retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id,
    party_resource_revision, attribution_kind
  ) VALUES (
    v_profile.customer_profile_id, p_tenant_id, p_legal_entity_id, btrim(p_party_resource_id),
    nullif(btrim(p_party_resource_revision), ''), p_attribution_kind
  );

  INSERT INTO customer_profile_lifecycle_history(
    tenant_id, legal_entity_id, customer_profile_id, revision, from_lifecycle, to_lifecycle,
    recorded_at, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile.customer_profile_id, 1, NULL, 'ACTIVE',
    p_effective_at, p_action_invocation_id, p_actor_principal_id, 'Created by ' || p_trigger
  );

  RETURN QUERY SELECT 'PROFILE_CREATED', jsonb_build_object(
    'outcome','PROFILE_CREATED',
    'profileRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_profile.customer_profile_id,'resourceType','commerce.customer-context.retail-customer-profile','tenantId',p_tenant_id),
    'revision',1,
    'state','ACTIVE'
  );
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."record_guest_attribution"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_correlation_root text,
  p_guest_evidence_ref text,
  p_attribution_outcome text,
  p_party_resource_id text,
  p_profile_id uuid,
  p_reconciliation_ref text,
  p_requested_at timestamptz,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_existing_evidence text;
  v_existing_outcome text;
  v_existing_party text;
  v_existing_profile uuid;
  v_existing_reconciliation text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_requested_at IS NULL
     OR nullif(btrim(p_correlation_root),'') IS NULL OR nullif(btrim(p_guest_evidence_ref),'') IS NULL
     OR p_attribution_outcome NOT IN ('ATTRIBUTED','PARTY_UNRESOLVED','PARTY_AMBIGUOUS','PARTY_INVALID','PROFILE_NOT_ACTIVE')
  THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':'||p_legal_entity_id::text||':guest:'||btrim(p_correlation_root),0));
  SELECT g.guest_evidence_ref,g.outcome,g.party_resource_id,g.retail_customer_profile_id,g.reconciliation_ref
    INTO v_existing_evidence,v_existing_outcome,v_existing_party,v_existing_profile,v_existing_reconciliation
    FROM guest_retail_attributions g
   WHERE g.tenant_id=p_tenant_id AND g.legal_entity_id=p_legal_entity_id
     AND g.correlation_root=btrim(p_correlation_root);
  IF FOUND THEN
    IF v_existing_evidence IS NOT DISTINCT FROM btrim(p_guest_evidence_ref)
       AND v_existing_outcome IS NOT DISTINCT FROM p_attribution_outcome
       AND v_existing_party IS NOT DISTINCT FROM nullif(btrim(p_party_resource_id),'')
       AND v_existing_profile IS NOT DISTINCT FROM p_profile_id
       AND v_existing_reconciliation IS NOT DISTINCT FROM nullif(btrim(p_reconciliation_ref),'') THEN
      RETURN QUERY SELECT 'UNCHANGED',jsonb_build_object(
        'outcome',v_existing_outcome,'partyResourceId',v_existing_party,
        'profileId',v_existing_profile,
        'reconciliationRef',v_existing_reconciliation); RETURN;
    END IF;
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN;
  END IF;
  IF p_attribution_outcome = 'ATTRIBUTED' AND NOT EXISTS (
    SELECT 1
      FROM retail_customer_profiles rp
      JOIN customer_profiles cp
        ON cp.tenant_id = rp.tenant_id
       AND cp.legal_entity_id = rp.legal_entity_id
       AND cp.customer_profile_id = rp.retail_customer_profile_id
     WHERE rp.tenant_id = p_tenant_id
       AND rp.legal_entity_id = p_legal_entity_id
       AND rp.retail_customer_profile_id = p_profile_id
       AND rp.party_resource_id = btrim(p_party_resource_id)
       AND cp.lifecycle = 'ACTIVE'
  ) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;
  INSERT INTO guest_retail_attributions(
    tenant_id,legal_entity_id,correlation_root,guest_evidence_ref,outcome,party_resource_id,
    retail_customer_profile_id,reconciliation_ref,requested_at,
    action_invocation_id,actor_principal_id,reason
  ) VALUES (
    p_tenant_id,p_legal_entity_id,btrim(p_correlation_root),btrim(p_guest_evidence_ref),p_attribution_outcome,
    nullif(btrim(p_party_resource_id),''),p_profile_id,nullif(btrim(p_reconciliation_ref),''),p_requested_at,
    p_action_invocation_id,p_actor_principal_id,'Guest attribution decision'
  );
  RETURN QUERY SELECT 'RECORDED',jsonb_build_object(
    'outcome',p_attribution_outcome,'partyResourceId',p_party_resource_id,
    'profileId',p_profile_id,'reconciliationRef',p_reconciliation_ref);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_guest_attribution"(
  p_tenant_id uuid,p_legal_entity_id uuid,p_correlation_root text
) RETURNS TABLE(outcome text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE v_payload jsonb;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT jsonb_build_object(
    'correlationRoot',g.correlation_root,'outcome',g.outcome,
    'partyResourceId',g.party_resource_id,'profileId',g.retail_customer_profile_id,
    'reconciliationRef',g.reconciliation_ref,'observedAt',
      to_char(g.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    INTO v_payload FROM guest_retail_attributions g
   WHERE g.tenant_id=p_tenant_id AND g.legal_entity_id=p_legal_entity_id
     AND g.correlation_root=p_correlation_root;
  IF NOT FOUND THEN RETURN QUERY SELECT 'ATTRIBUTION_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ATTRIBUTION_AVAILABLE',v_payload;
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."observe_party_merge_reconciliation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_merge_id text,
  p_domain_event_id uuid,
  p_message_id uuid,
  p_event_version bigint,
  p_occurred_at timestamptz,
  p_policy_version text,
  p_survivor_party_resource_id text,
  p_absorbed_party_resource_ids text[],
  p_initial_owner_outcomes jsonb,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text,current_event_version bigint,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_case profile_reconciliation_cases%ROWTYPE;
  v_observation_event_version bigint;
  v_observation_domain_event_id uuid;
  v_observation_message_id uuid;
  v_observation_occurred_at timestamptz;
  v_observation_policy_version text;
  v_observation_survivor text;
  v_observation_absorbed text[];
  v_observation_actor uuid;
  v_profiles uuid[];
  v_cases jsonb;
  v_profile_refs jsonb;
  v_change text;
  v_canonicalized_profile_id uuid;
  v_case_found boolean;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF to_regclass('commerce_customer_context.party_merge_profile_observations') IS NULL THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',p_event_version,NULL::jsonb;
    RETURN;
  END IF;
  IF p_domain_event_id IS NULL OR p_message_id IS NULL OR p_actor_principal_id IS NULL
     OR p_event_version<=0 OR p_occurred_at IS NULL OR nullif(btrim(p_merge_id),'') IS NULL
     OR nullif(btrim(p_policy_version),'') IS NULL OR nullif(btrim(p_survivor_party_resource_id),'') IS NULL
     OR coalesce(cardinality(p_absorbed_party_resource_ids),0)<1
     OR array_position(p_absorbed_party_resource_ids,NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(p_absorbed_party_resource_ids) absorbed WHERE nullif(btrim(absorbed),'') IS NULL)
     OR cardinality(p_absorbed_party_resource_ids)<>(SELECT count(DISTINCT btrim(absorbed)) FROM unnest(p_absorbed_party_resource_ids) absorbed)
     OR btrim(p_survivor_party_resource_id)=ANY(SELECT btrim(absorbed) FROM unnest(p_absorbed_party_resource_ids) absorbed)
     OR jsonb_typeof(p_initial_owner_outcomes)<>'array' OR jsonb_array_length(p_initial_owner_outcomes)<>11
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_initial_owner_outcomes) owner_outcome WHERE owner_outcome->>'status'<>'PENDING')
     OR (SELECT count(DISTINCT owner_outcome->>'owner') FROM jsonb_array_elements(p_initial_owner_outcomes) owner_outcome)<>11
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_initial_owner_outcomes) owner_outcome
        WHERE owner_outcome->>'owner' NOT IN ('PROFILE_LIFECYCLE','CUSTOMER_GROUP_MEMBERSHIP','PRICE_GROUP_ASSIGNMENT','CURRENCY_PREFERENCE','PAYMENT_TERMS','ADDRESS_BOOK','RETAIL_PORTAL_BINDING','COUNTERPARTY_ACCESS','PURCHASE_LIMITS','APPROVAL','CONNECTOR_CORRELATION')
     )
  THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',p_event_version,NULL::jsonb; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':'||p_legal_entity_id::text||':party-merge:'||btrim(p_merge_id),0));

  SELECT observation.event_version,observation.source_domain_event_id,observation.source_message_id,
         observation.occurred_at,observation.policy_version,observation.survivor_party_resource_id,
         observation.absorbed_party_resource_ids,observation.actor_principal_id
    INTO v_observation_event_version,v_observation_domain_event_id,v_observation_message_id,
         v_observation_occurred_at,v_observation_policy_version,v_observation_survivor,
         v_observation_absorbed,v_observation_actor
    FROM party_merge_profile_observations observation
   WHERE observation.tenant_id=p_tenant_id AND observation.legal_entity_id=p_legal_entity_id
     AND observation.merge_resource_id=btrim(p_merge_id)
   ORDER BY observation.event_version DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND v_observation_event_version=p_event_version THEN
    IF v_observation_domain_event_id=p_domain_event_id
       AND v_observation_message_id=p_message_id
       AND v_observation_occurred_at=p_occurred_at
       AND v_observation_policy_version=btrim(p_policy_version)
       AND v_observation_survivor=btrim(p_survivor_party_resource_id)
       AND v_observation_absorbed=ARRAY(SELECT btrim(absorbed) FROM unnest(p_absorbed_party_resource_ids) absorbed ORDER BY btrim(absorbed))
       AND v_observation_actor=p_actor_principal_id THEN
      RETURN QUERY SELECT 'DUPLICATE',v_observation_event_version,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',v_observation_event_version,NULL::jsonb; RETURN;
  END IF;
  IF FOUND AND v_observation_event_version>p_event_version THEN
    RETURN QUERY SELECT 'OUT_OF_ORDER',v_observation_event_version,NULL::jsonb; RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM party_merge_profile_observations observation
     WHERE observation.tenant_id=p_tenant_id AND observation.legal_entity_id=p_legal_entity_id
       AND (observation.source_domain_event_id=p_domain_event_id OR observation.source_message_id=p_message_id)
  ) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',
      coalesce(v_observation_event_version,p_event_version),NULL::jsonb; RETURN;
  END IF;

  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND merge_resource_id=btrim(p_merge_id)
   ORDER BY (lifecycle='COMPLETED'),recorded_at DESC LIMIT 1 FOR UPDATE;
  v_case_found:=FOUND;

  SELECT array_agg(DISTINCT rp.retail_customer_profile_id ORDER BY rp.retail_customer_profile_id)
    INTO v_profiles FROM retail_customer_profiles rp
   WHERE rp.tenant_id=p_tenant_id AND rp.legal_entity_id=p_legal_entity_id
     AND rp.party_resource_id=ANY(array_prepend(btrim(p_survivor_party_resource_id),ARRAY(SELECT btrim(absorbed) FROM unnest(p_absorbed_party_resource_ids) absorbed)));

  IF v_case_found AND v_case.lifecycle='COMPLETED' AND coalesce(cardinality(v_profiles),0)<2 THEN
    INSERT INTO party_merge_profile_observations(
      tenant_id,legal_entity_id,merge_resource_id,source_domain_event_id,source_message_id,
      event_version,occurred_at,policy_version,survivor_party_resource_id,
      absorbed_party_resource_ids,outcome,canonicalized_profile_id,actor_principal_id
    ) VALUES (
      p_tenant_id,p_legal_entity_id,btrim(p_merge_id),p_domain_event_id,p_message_id,p_event_version,
      p_occurred_at,btrim(p_policy_version),btrim(p_survivor_party_resource_id),ARRAY(SELECT btrim(absorbed) FROM unnest(p_absorbed_party_resource_ids) absorbed ORDER BY btrim(absorbed)),
      'COMPLETED_NO_CHANGE',v_case.canonical_profile_id,p_actor_principal_id
    );
    RETURN QUERY SELECT 'COMPLETED_NO_CHANGE',p_event_version,NULL::jsonb; RETURN;
  END IF;
  IF v_case_found AND v_case.lifecycle='COMPLETED' THEN
    v_case_found:=false;
  END IF;
  IF coalesce(cardinality(v_profiles),0)<2 THEN
    IF coalesce(cardinality(v_profiles),0)=1 THEN
      v_canonicalized_profile_id:=v_profiles[1];
    END IF;
    INSERT INTO party_merge_profile_observations(
      tenant_id,legal_entity_id,merge_resource_id,source_domain_event_id,source_message_id,
      event_version,occurred_at,policy_version,survivor_party_resource_id,
      absorbed_party_resource_ids,outcome,canonicalized_profile_id,actor_principal_id
    ) VALUES (
      p_tenant_id,p_legal_entity_id,btrim(p_merge_id),p_domain_event_id,p_message_id,p_event_version,
      p_occurred_at,btrim(p_policy_version),btrim(p_survivor_party_resource_id),ARRAY(SELECT btrim(absorbed) FROM unnest(p_absorbed_party_resource_ids) absorbed ORDER BY btrim(absorbed)),
      'NO_CONFLICTING_PROFILES',v_canonicalized_profile_id,p_actor_principal_id
    );
    RETURN QUERY SELECT 'NO_CONFLICTING_PROFILES',p_event_version,NULL::jsonb; RETURN;
  END IF;
  IF v_case_found THEN
    IF v_case.action_invocation_id IS NOT NULL THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',p_event_version,NULL::jsonb; RETURN;
    END IF;
    INSERT INTO profile_reconciliation_case_members(
      tenant_id,legal_entity_id,profile_reconciliation_case_id,customer_profile_id,member_position,observed_lifecycle
    ) SELECT p_tenant_id,p_legal_entity_id,v_case.profile_reconciliation_case_id,cp.customer_profile_id,
        coalesce((SELECT max(member_position)+1 FROM profile_reconciliation_case_members
          WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
            AND profile_reconciliation_case_id=v_case.profile_reconciliation_case_id),0)
          + row_number() OVER (ORDER BY cp.customer_profile_id)-1,
        cp.lifecycle
      FROM customer_profiles cp WHERE cp.tenant_id=p_tenant_id AND cp.legal_entity_id=p_legal_entity_id
        AND cp.customer_profile_id=ANY(v_profiles)
        AND NOT EXISTS (SELECT 1 FROM profile_reconciliation_case_members m
          WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
            AND m.profile_reconciliation_case_id=v_case.profile_reconciliation_case_id
            AND m.customer_profile_id=cp.customer_profile_id);
    UPDATE profile_reconciliation_cases SET last_processed_event_version=p_event_version,
      source_domain_event_id=p_domain_event_id,source_message_id=p_message_id,
      canonical_party_resource_id=btrim(p_survivor_party_resource_id),
      target_subject=jsonb_build_object('kind','RETAIL','partyRef',jsonb_build_object(
        'moduleId','party.registry','resourceId',btrim(p_survivor_party_resource_id),'resourceType','party.registry.party','tenantId',p_tenant_id),
        'sellingLegalEntityRef',jsonb_build_object('moduleId','core.identity','resourceId',p_legal_entity_id,'resourceType','core.identity.legal-entity','tenantId',p_tenant_id)),
      canonicalization_evidence=jsonb_build_object('evidenceKind','PARTY_OWNER_OBSERVATION','sourceOwnerModuleId','party.registry',
        'sourceDomainEventId',p_domain_event_id,'sourceMessageId',p_message_id,
        'sourceEventVersion',p_event_version::text,'policyVersion',btrim(p_policy_version),
        'observedAt',to_char(p_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      owner_outcomes=p_initial_owner_outcomes,lifecycle='OPEN',revision=revision+1
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND profile_reconciliation_case_id=v_case.profile_reconciliation_case_id;
    v_change:='UPDATED';
  ELSE
    INSERT INTO profile_reconciliation_cases(
      tenant_id,legal_entity_id,profile_kind,source_profile_id,colliding_profile_id,
      canonical_party_resource_id,merge_resource_id,source_correlation_ref,trigger,target_subject,canonicalization_evidence,
      owner_outcomes,last_processed_event_version,lifecycle,revision,action_invocation_id,
      source_domain_event_id,source_message_id,actor_principal_id,reason,recorded_at
    ) VALUES (
      p_tenant_id,p_legal_entity_id,'RETAIL',v_profiles[1],v_profiles[2],btrim(p_survivor_party_resource_id),
      btrim(p_merge_id),btrim(p_merge_id),'PARTY_ALIAS',jsonb_build_object('kind','RETAIL','partyRef',jsonb_build_object(
        'moduleId','party.registry','resourceId',btrim(p_survivor_party_resource_id),'resourceType','party.registry.party','tenantId',p_tenant_id),
        'sellingLegalEntityRef',jsonb_build_object('moduleId','core.identity','resourceId',p_legal_entity_id,'resourceType','core.identity.legal-entity','tenantId',p_tenant_id)),
      jsonb_build_object('evidenceKind','PARTY_OWNER_OBSERVATION','sourceOwnerModuleId','party.registry',
        'sourceDomainEventId',p_domain_event_id,'sourceMessageId',p_message_id,
        'sourceEventVersion',p_event_version::text,'policyVersion',btrim(p_policy_version),
        'observedAt',to_char(p_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      p_initial_owner_outcomes,p_event_version,'OPEN',1,NULL,p_domain_event_id,p_message_id,
      p_actor_principal_id,'Party merge observed under policy '||btrim(p_policy_version),p_occurred_at
    ) RETURNING * INTO v_case;
    INSERT INTO profile_reconciliation_case_members(
      tenant_id,legal_entity_id,profile_reconciliation_case_id,customer_profile_id,member_position,observed_lifecycle
    ) SELECT p_tenant_id,p_legal_entity_id,v_case.profile_reconciliation_case_id,cp.customer_profile_id,
        row_number() OVER (ORDER BY cp.customer_profile_id)-1,cp.lifecycle
      FROM customer_profiles cp WHERE cp.tenant_id=p_tenant_id AND cp.legal_entity_id=p_legal_entity_id
        AND cp.customer_profile_id=ANY(v_profiles);
    v_change:='OPENED';
  END IF;
  INSERT INTO party_merge_profile_observations(
    tenant_id,legal_entity_id,merge_resource_id,source_domain_event_id,source_message_id,
    event_version,occurred_at,policy_version,survivor_party_resource_id,
    absorbed_party_resource_ids,outcome,canonicalized_profile_id,actor_principal_id
  ) VALUES (
    p_tenant_id,p_legal_entity_id,btrim(p_merge_id),p_domain_event_id,p_message_id,p_event_version,
    p_occurred_at,btrim(p_policy_version),btrim(p_survivor_party_resource_id),ARRAY(SELECT btrim(absorbed) FROM unnest(p_absorbed_party_resource_ids) absorbed ORDER BY btrim(absorbed)),
    'RECONCILIATIONS_OBSERVED',NULL,p_actor_principal_id
  );
  SELECT jsonb_agg(jsonb_build_object(
    'kind','RETAIL','moduleId','commerce.customer-context','resourceId',cp.customer_profile_id,
    'resourceType','commerce.customer-context.retail-customer-profile','tenantId',p_tenant_id)
    ORDER BY m.member_position) INTO v_profile_refs
   FROM profile_reconciliation_case_members m JOIN customer_profiles cp
     ON cp.tenant_id=m.tenant_id AND cp.legal_entity_id=m.legal_entity_id
    AND cp.customer_profile_id=m.customer_profile_id
   WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
     AND m.profile_reconciliation_case_id=v_case.profile_reconciliation_case_id;
  v_cases:=jsonb_build_array(jsonb_build_object(
    'caseRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_case.profile_reconciliation_case_id,'resourceType','commerce.customer-context.profile-reconciliation-case','tenantId',p_tenant_id),
    'change',v_change,'conflictingProfiles',v_profile_refs,'legalEntityId',p_legal_entity_id,
    'ownerOutcomes',v_case.owner_outcomes));
  RETURN QUERY SELECT 'RECONCILIATIONS_OBSERVED',p_event_version,jsonb_build_object('cases',v_cases);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."open_profile_reconciliation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_ids uuid[],
  p_evidence_ref text,
  p_trigger text,
  p_target_subject jsonb,
  p_canonicalization_evidence jsonb,
  p_detected_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_case profile_reconciliation_cases%ROWTYPE;
  v_kind text; v_count integer; v_first uuid; v_second uuid; v_subject_id text;
  v_owner_outcomes jsonb := '[{"owner":"PROFILE_LIFECYCLE","status":"PENDING"},{"owner":"CUSTOMER_GROUP_MEMBERSHIP","status":"PENDING"},{"owner":"PRICE_GROUP_ASSIGNMENT","status":"PENDING"},{"owner":"CURRENCY_PREFERENCE","status":"PENDING"},{"owner":"PAYMENT_TERMS","status":"PENDING"},{"owner":"ADDRESS_BOOK","status":"PENDING"},{"owner":"RETAIL_PORTAL_BINDING","status":"PENDING"},{"owner":"COUNTERPARTY_ACCESS","status":"PENDING"},{"owner":"PURCHASE_LIMITS","status":"PENDING"},{"owner":"APPROVAL","status":"PENDING"},{"owner":"CONNECTOR_CORRELATION","status":"PENDING"}]'::jsonb;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_detected_at IS NULL
     OR nullif(btrim(p_evidence_ref),'') IS NULL OR nullif(btrim(p_reason),'') IS NULL
     OR p_trigger NOT IN ('PARTY_ALIAS','COUNTERPARTY_ALIAS','CREATE_COLLISION','IMPORT_CORRELATION')
     OR jsonb_typeof(p_target_subject)<>'object'
     OR jsonb_typeof(p_canonicalization_evidence)<>'object'
     OR coalesce(cardinality(p_profile_ids),0)<2
     OR cardinality(p_profile_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_profile_ids) x) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':'||p_legal_entity_id::text||':reconciliation:'||btrim(p_evidence_ref),0));
  SELECT count(*),min(profile_kind),max(profile_kind) INTO v_count,v_kind,v_subject_id
    FROM customer_profiles WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
      AND customer_profile_id=ANY(p_profile_ids);
  IF v_count<>cardinality(p_profile_ids) THEN RETURN QUERY SELECT 'PROFILE_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  IF v_kind IS DISTINCT FROM v_subject_id THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;
  IF p_target_subject->>'kind' IS DISTINCT FROM v_kind
     OR (p_trigger IN ('PARTY_ALIAS','COUNTERPARTY_ALIAS')
       AND (p_canonicalization_evidence->>'evidenceKind' IS DISTINCT FROM 'PARTY_OWNER_OBSERVATION'
         OR p_canonicalization_evidence->>'sourceOwnerModuleId' IS DISTINCT FROM 'party.registry'))
     OR (p_canonicalization_evidence->>'evidenceKind' = 'PARTY_OWNER_OBSERVATION' AND (
       nullif(btrim(p_canonicalization_evidence->>'sourceDomainEventId'),'') IS NULL
       OR nullif(btrim(p_canonicalization_evidence->>'sourceMessageId'),'') IS NULL
       OR coalesce(p_canonicalization_evidence->>'sourceEventVersion','') !~ '^[1-9][0-9]*$'))
     OR (p_canonicalization_evidence->>'evidenceKind' = 'AUTHORIZED_OPERATOR_DECISION'
       AND (p_trigger NOT IN ('CREATE_COLLISION','IMPORT_CORRELATION')
         OR nullif(btrim(p_canonicalization_evidence->>'decisionRef'),'') IS NULL))
     OR p_canonicalization_evidence->>'evidenceKind' NOT IN ('PARTY_OWNER_OBSERVATION','AUTHORIZED_OPERATOR_DECISION')
     OR nullif(btrim(p_canonicalization_evidence->>'policyVersion'),'') IS NULL
     OR nullif(btrim(p_canonicalization_evidence->>'observedAt'),'') IS NULL
     OR (v_kind='RETAIL' AND (
       p_target_subject#>>'{partyRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
       OR p_target_subject#>>'{sellingLegalEntityRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
       OR p_target_subject#>>'{sellingLegalEntityRef,resourceId}' IS DISTINCT FROM p_legal_entity_id::text))
     OR (v_kind='COUNTERPARTY' AND
       p_target_subject#>>'{counterpartyRef,tenantId}' IS DISTINCT FROM p_tenant_id::text)
  THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;

  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND source_correlation_ref=btrim(p_evidence_ref) AND lifecycle<>'COMPLETED'
   ORDER BY recorded_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_case.lifecycle <> 'OPEN'
       OR v_case.revision <> 1
       OR v_case.trigger IS DISTINCT FROM p_trigger
       OR v_case.action_invocation_id IS DISTINCT FROM p_action_invocation_id
       OR v_case.actor_principal_id IS DISTINCT FROM p_actor_principal_id
       OR v_case.reason IS DISTINCT FROM btrim(p_reason)
       OR v_case.target_subject IS DISTINCT FROM p_target_subject
       OR v_case.canonicalization_evidence IS DISTINCT FROM p_canonicalization_evidence
       OR v_case.recorded_at IS DISTINCT FROM p_detected_at
       OR (SELECT array_agg(m.customer_profile_id ORDER BY m.customer_profile_id)
             FROM profile_reconciliation_case_members m
            WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
              AND m.profile_reconciliation_case_id=v_case.profile_reconciliation_case_id)
          IS DISTINCT FROM (SELECT array_agg(profile_id ORDER BY profile_id)
                              FROM unnest(p_profile_ids) profile_id)
    THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'RECONCILIATION_ALREADY_OPEN',jsonb_build_object(
      'caseRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_case.profile_reconciliation_case_id,'resourceType','commerce.customer-context.profile-reconciliation-case','tenantId',p_tenant_id),
      'outcome','RECONCILIATION_ALREADY_OPEN','revision',v_case.revision,'state','OPEN'); RETURN;
  END IF;
  v_first:=p_profile_ids[1]; v_second:=p_profile_ids[2];
  v_subject_id:=CASE v_kind WHEN 'RETAIL' THEN p_target_subject#>>'{partyRef,resourceId}'
    ELSE p_target_subject#>>'{counterpartyRef,resourceId}' END;
  IF nullif(btrim(v_subject_id),'') IS NULL THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;
  INSERT INTO profile_reconciliation_cases(
    tenant_id,legal_entity_id,profile_kind,source_profile_id,colliding_profile_id,
    canonical_party_resource_id,merge_resource_id,source_correlation_ref,trigger,target_subject,canonicalization_evidence,
    owner_outcomes,last_processed_event_version,lifecycle,revision,action_invocation_id,
    actor_principal_id,reason,recorded_at
  ) VALUES (
    p_tenant_id,p_legal_entity_id,v_kind,v_first,v_second,v_subject_id,btrim(p_evidence_ref),
    btrim(p_evidence_ref),p_trigger,p_target_subject,p_canonicalization_evidence,
    v_owner_outcomes,0,'OPEN',1,p_action_invocation_id,p_actor_principal_id,btrim(p_reason),p_detected_at
  ) RETURNING * INTO v_case;
  INSERT INTO profile_reconciliation_case_members(
    tenant_id,legal_entity_id,profile_reconciliation_case_id,customer_profile_id,member_position,observed_lifecycle
  ) SELECT p_tenant_id,p_legal_entity_id,v_case.profile_reconciliation_case_id,cp.customer_profile_id,
      u.ordinality-1,cp.lifecycle
    FROM unnest(p_profile_ids) WITH ORDINALITY u(profile_id,ordinality)
    JOIN customer_profiles cp ON cp.tenant_id=p_tenant_id AND cp.legal_entity_id=p_legal_entity_id
      AND cp.customer_profile_id=u.profile_id;
  RETURN QUERY SELECT 'RECONCILIATION_OPENED',jsonb_build_object(
    'caseRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_case.profile_reconciliation_case_id,'resourceType','commerce.customer-context.profile-reconciliation-case','tenantId',p_tenant_id),
    'outcome','RECONCILIATION_OPENED','revision',1,'state','OPEN');
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."record_profile_reconciliation_owner_outcome"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_case_id uuid,
  p_survivor_profile_id uuid,
  p_resulting_state text,
  p_owner text,
  p_status text,
  p_evidence_ref text,
  p_expected_revision integer,
  p_expected_event_version bigint,
  p_correlation_ref text,
  p_observed_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_case profile_reconciliation_cases%ROWTYPE;
  v_owner_current jsonb;
  v_owner_outcomes jsonb;
  v_lifecycle text;
  v_recorded_status text;
  v_recorded_evidence_ref text;
  v_recorded_event_version bigint;
  v_recorded_case_revision integer;
  v_recorded_observed_at timestamptz;
  v_recorded_action_invocation_id uuid;
  v_recorded_actor_principal_id uuid;
  v_recorded_reason text;
  v_recorded_survivor_profile_id uuid;
  v_recorded_resulting_state text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF to_regclass('commerce_customer_context.profile_reconciliation_owner_outcomes') IS NULL THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_observed_at IS NULL
     OR p_survivor_profile_id IS NULL
     OR p_resulting_state IS NULL OR p_resulting_state NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
     OR nullif(btrim(p_correlation_ref),'') IS NULL OR nullif(btrim(p_reason),'') IS NULL
     OR p_owner NOT IN ('PROFILE_LIFECYCLE','CUSTOMER_GROUP_MEMBERSHIP','PRICE_GROUP_ASSIGNMENT','CURRENCY_PREFERENCE','PAYMENT_TERMS','ADDRESS_BOOK','RETAIL_PORTAL_BINDING','COUNTERPARTY_ACCESS','PURCHASE_LIMITS','APPROVAL','CONNECTOR_CORRELATION')
     OR p_status NOT IN ('BLOCKED','RESOLVED','NOT_APPLICABLE')
     OR (p_status IN ('RESOLVED','NOT_APPLICABLE') AND nullif(btrim(p_evidence_ref),'') IS NULL)
  THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;

  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'RECONCILIATION_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profile_reconciliation_case_members member
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
       AND member.customer_profile_id=p_survivor_profile_id
  ) THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;

  SELECT recorded.status,recorded.evidence_ref,recorded.event_version,recorded.case_revision,
         recorded.observed_at,recorded.action_invocation_id,recorded.actor_principal_id,recorded.reason,
         recorded.survivor_profile_id,recorded.resulting_state
    INTO v_recorded_status,v_recorded_evidence_ref,v_recorded_event_version,v_recorded_case_revision,
         v_recorded_observed_at,v_recorded_action_invocation_id,v_recorded_actor_principal_id,v_recorded_reason,
         v_recorded_survivor_profile_id,v_recorded_resulting_state
    FROM profile_reconciliation_owner_outcomes recorded
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND profile_reconciliation_case_id=p_case_id AND owner=p_owner
       AND correlation_ref=btrim(p_correlation_ref);
  IF FOUND THEN
    IF v_recorded_status IS DISTINCT FROM p_status
       OR v_recorded_evidence_ref IS DISTINCT FROM nullif(btrim(p_evidence_ref),'')
       OR v_recorded_event_version IS DISTINCT FROM p_expected_event_version
       OR v_recorded_case_revision IS DISTINCT FROM p_expected_revision+1
       OR v_recorded_observed_at IS DISTINCT FROM p_observed_at
       OR v_recorded_action_invocation_id IS DISTINCT FROM p_action_invocation_id
       OR v_recorded_actor_principal_id IS DISTINCT FROM p_actor_principal_id
       OR v_recorded_reason IS DISTINCT FROM btrim(p_reason)
       OR v_recorded_survivor_profile_id IS DISTINCT FROM p_survivor_profile_id
       OR v_recorded_resulting_state IS DISTINCT FROM p_resulting_state THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT 'OWNER_OUTCOME_ALREADY_RECORDED',jsonb_build_object(
      'caseRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',p_case_id,'resourceType','commerce.customer-context.profile-reconciliation-case','tenantId',p_tenant_id),
      'lastProcessedEventVersion',v_case.last_processed_event_version::text,
      'ownerOutcomes',v_case.owner_outcomes,'revision',v_case.revision,'state',v_case.lifecycle);
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profile_reconciliation_owner_outcomes recorded
     WHERE recorded.tenant_id=p_tenant_id AND recorded.legal_entity_id=p_legal_entity_id
       AND recorded.profile_reconciliation_case_id=p_case_id
       AND recorded.event_version=v_case.last_processed_event_version
       AND (recorded.survivor_profile_id IS DISTINCT FROM p_survivor_profile_id
         OR recorded.resulting_state IS DISTINCT FROM p_resulting_state)
  ) THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;

  IF v_case.lifecycle='COMPLETED' OR v_case.revision IS DISTINCT FROM p_expected_revision
     OR v_case.last_processed_event_version IS DISTINCT FROM p_expected_event_version THEN
    RETURN QUERY SELECT 'RECONCILIATION_OUT_OF_ORDER',NULL::jsonb; RETURN;
  END IF;

  SELECT item INTO v_owner_current
    FROM jsonb_array_elements(v_case.owner_outcomes) item
   WHERE item->>'owner'=p_owner;
  IF v_owner_current IS NULL
     OR (v_owner_current->>'status' IN ('RESOLVED','NOT_APPLICABLE')
         AND (v_owner_current->>'status' IS DISTINCT FROM p_status
              OR v_owner_current->>'evidenceRef' IS DISTINCT FROM nullif(btrim(p_evidence_ref),''))) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN;
  END IF;

  SELECT jsonb_agg(
    CASE WHEN item->>'owner'=p_owner THEN jsonb_strip_nulls(jsonb_build_object(
      'owner',p_owner,'status',p_status,'evidenceRef',nullif(btrim(p_evidence_ref),'')))
    ELSE item END ORDER BY ordinality)
    INTO v_owner_outcomes
    FROM jsonb_array_elements(v_case.owner_outcomes) WITH ORDINALITY entries(item,ordinality);

  v_lifecycle:=CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_owner_outcomes) item WHERE item->>'status'='BLOCKED')
      THEN 'BLOCKED'
    WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_owner_outcomes) item WHERE item->>'status'='PENDING')
      THEN 'READY_TO_COMPLETE'
    ELSE 'OPEN'
  END;

  INSERT INTO profile_reconciliation_owner_outcomes(
    tenant_id,legal_entity_id,profile_reconciliation_case_id,survivor_profile_id,resulting_state,
    owner,status,evidence_ref,
    case_revision,event_version,correlation_ref,observed_at,action_invocation_id,
    actor_principal_id,reason
  ) VALUES (
    p_tenant_id,p_legal_entity_id,p_case_id,p_survivor_profile_id,p_resulting_state,
    p_owner,p_status,nullif(btrim(p_evidence_ref),''),
    v_case.revision+1,v_case.last_processed_event_version,btrim(p_correlation_ref),p_observed_at,
    p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
  );
  UPDATE profile_reconciliation_cases
     SET owner_outcomes=v_owner_outcomes,lifecycle=v_lifecycle,revision=revision+1,
         reason=btrim(p_reason)
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id;

  RETURN QUERY SELECT 'OWNER_OUTCOME_RECORDED',jsonb_build_object(
    'caseRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',p_case_id,'resourceType','commerce.customer-context.profile-reconciliation-case','tenantId',p_tenant_id),
    'lastProcessedEventVersion',v_case.last_processed_event_version::text,
    'ownerOutcomes',v_owner_outcomes,'revision',v_case.revision+1,'state',v_lifecycle);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."resolve_profile_reconciliation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_case_id uuid,
  p_survivor_profile_id uuid,
  p_expected_revision integer,
  p_expected_event_version bigint,
  p_owner_outcomes jsonb,
  p_resulting_state text,
  p_effective_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_case profile_reconciliation_cases%ROWTYPE;
  v_profile_kind text;
  v_loser record;
  v_survivor customer_profiles%ROWTYPE;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'RECONCILIATION_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  IF v_case.lifecycle='COMPLETED' OR v_case.revision IS DISTINCT FROM p_expected_revision
     OR v_case.last_processed_event_version IS DISTINCT FROM p_expected_event_version THEN
    RETURN QUERY SELECT 'RECONCILIATION_OUT_OF_ORDER',NULL::jsonb; RETURN;
  END IF;
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_effective_at IS NULL
     OR nullif(btrim(p_reason),'') IS NULL OR p_resulting_state NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
     OR jsonb_typeof(p_owner_outcomes)<>'array' OR jsonb_array_length(p_owner_outcomes)<>11
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_owner_outcomes) desired
        WHERE desired->>'status' NOT IN ('RESOLVED','NOT_APPLICABLE')
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_case.owner_outcomes) durable
             WHERE durable->>'owner'=desired->>'owner'
               AND durable->>'status'=desired->>'status'
          )
     )
     OR (SELECT count(DISTINCT desired->>'owner') FROM jsonb_array_elements(p_owner_outcomes) desired)<>11
     OR (SELECT count(*) FROM profile_reconciliation_owner_outcomes receipt
          WHERE receipt.tenant_id=p_tenant_id AND receipt.legal_entity_id=p_legal_entity_id
            AND receipt.profile_reconciliation_case_id=p_case_id
            AND receipt.event_version=p_expected_event_version
            AND receipt.survivor_profile_id=p_survivor_profile_id
            AND receipt.resulting_state=p_resulting_state
            AND receipt.status IN ('RESOLVED','NOT_APPLICABLE'))<>11
     OR NOT EXISTS (SELECT 1 FROM profile_reconciliation_case_members WHERE tenant_id=p_tenant_id
       AND legal_entity_id=p_legal_entity_id AND profile_reconciliation_case_id=p_case_id
       AND customer_profile_id=p_survivor_profile_id)
     OR v_case.lifecycle<>'READY_TO_COMPLETE'
     OR jsonb_typeof(v_case.owner_outcomes)<>'array'
     OR jsonb_array_length(v_case.owner_outcomes)<>11
     OR (SELECT count(DISTINCT item->>'owner') FROM jsonb_array_elements(v_case.owner_outcomes) item)<>11
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_case.owner_outcomes) item
       WHERE item->>'owner' NOT IN ('PROFILE_LIFECYCLE','CUSTOMER_GROUP_MEMBERSHIP','PRICE_GROUP_ASSIGNMENT','CURRENCY_PREFERENCE','PAYMENT_TERMS','ADDRESS_BOOK','RETAIL_PORTAL_BINDING','COUNTERPARTY_ACCESS','PURCHASE_LIMITS','APPROVAL','CONNECTOR_CORRELATION')
          OR item->>'status' NOT IN ('RESOLVED','NOT_APPLICABLE')
          OR nullif(btrim(item->>'evidenceRef'),'') IS NULL)
  THEN RETURN QUERY SELECT 'RECONCILIATION_INCOMPLETE',NULL::jsonb; RETURN; END IF;

  FOR v_loser IN
    SELECT m.customer_profile_id
      FROM profile_reconciliation_case_members m
     WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
       AND m.profile_reconciliation_case_id=p_case_id
     ORDER BY m.customer_profile_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_tenant_id::text||':'||p_legal_entity_id::text||':profile-alias:'||v_loser.customer_profile_id::text,0));
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM customer_profile_aliases a
     WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id
       AND (
         (a.alias_profile_id=p_survivor_profile_id)
         OR a.alias_profile_id IN (
           SELECT m.customer_profile_id FROM profile_reconciliation_case_members m
            WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
              AND m.profile_reconciliation_case_id=p_case_id
              AND m.customer_profile_id<>p_survivor_profile_id
         )
       )
  ) THEN RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT',NULL::jsonb; RETURN; END IF;

  SELECT * INTO v_survivor FROM customer_profiles WHERE tenant_id=p_tenant_id
    AND legal_entity_id=p_legal_entity_id AND customer_profile_id=p_survivor_profile_id FOR UPDATE;
  v_profile_kind:=v_survivor.profile_kind;
  IF v_survivor.lifecycle<>p_resulting_state THEN
    UPDATE customer_profiles SET lifecycle=p_resulting_state,revision=revision+1,updated_at=clock_timestamp()
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND customer_profile_id=p_survivor_profile_id;
    INSERT INTO customer_profile_lifecycle_history(
      tenant_id,legal_entity_id,customer_profile_id,revision,from_lifecycle,to_lifecycle,recorded_at,
      action_invocation_id,actor_principal_id,reason
    ) VALUES (p_tenant_id,p_legal_entity_id,p_survivor_profile_id,v_survivor.revision+1,
      v_survivor.lifecycle,p_resulting_state,p_effective_at,p_action_invocation_id,p_actor_principal_id,btrim(p_reason));
  END IF;
  FOR v_loser IN
    SELECT cp.* FROM profile_reconciliation_case_members m JOIN customer_profiles cp
      ON cp.tenant_id=m.tenant_id AND cp.legal_entity_id=m.legal_entity_id
     AND cp.customer_profile_id=m.customer_profile_id
     WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
       AND m.profile_reconciliation_case_id=p_case_id AND m.customer_profile_id<>p_survivor_profile_id
     FOR UPDATE OF cp
  LOOP
    IF v_loser.lifecycle<>'ARCHIVED' THEN
      UPDATE customer_profiles SET lifecycle='ARCHIVED',revision=revision+1,updated_at=clock_timestamp()
       WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
         AND customer_profile_id=v_loser.customer_profile_id;
      INSERT INTO customer_profile_lifecycle_history(
        tenant_id,legal_entity_id,customer_profile_id,revision,from_lifecycle,to_lifecycle,recorded_at,
        action_invocation_id,actor_principal_id,reason
      ) VALUES (p_tenant_id,p_legal_entity_id,v_loser.customer_profile_id,v_loser.revision+1,
        v_loser.lifecycle,'ARCHIVED',p_effective_at,p_action_invocation_id,p_actor_principal_id,btrim(p_reason));
    END IF;
    INSERT INTO customer_profile_aliases(
      tenant_id,legal_entity_id,alias_profile_id,canonical_profile_id,profile_reconciliation_case_id,
      recorded_at,action_invocation_id,actor_principal_id,reason
    ) VALUES (p_tenant_id,p_legal_entity_id,v_loser.customer_profile_id,p_survivor_profile_id,p_case_id,
      p_effective_at,p_action_invocation_id,p_actor_principal_id,btrim(p_reason));
  END LOOP;
  UPDATE profile_reconciliation_cases SET lifecycle='COMPLETED',resolution_kind='SELECT_CANONICAL',
    canonical_profile_id=p_survivor_profile_id,resulting_state=p_resulting_state,
    revision=revision+1,resolved_at=p_effective_at,reason=btrim(p_reason)
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id;
  RETURN QUERY SELECT 'RECONCILIATION_RESOLVED',jsonb_build_object(
    'caseRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',p_case_id,'resourceType','commerce.customer-context.profile-reconciliation-case','tenantId',p_tenant_id),
    'outcome','RECONCILIATION_RESOLVED','revision',v_case.revision+1,'state','COMPLETED',
    'survivorProfileRef',jsonb_build_object('kind',v_profile_kind,'moduleId','commerce.customer-context','resourceId',p_survivor_profile_id,'resourceType',CASE v_profile_kind WHEN 'RETAIL' THEN 'commerce.customer-context.retail-customer-profile' ELSE 'commerce.customer-context.counterparty-purchasing-profile' END,'tenantId',p_tenant_id));
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_profile_reconciliation"(
  p_tenant_id uuid,p_legal_entity_id uuid,p_case_id uuid
) RETURNS TABLE(outcome text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE v_case profile_reconciliation_cases%ROWTYPE; v_members jsonb;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_case FROM profile_reconciliation_cases WHERE tenant_id=p_tenant_id
    AND legal_entity_id=p_legal_entity_id AND profile_reconciliation_case_id=p_case_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'RECONCILIATION_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  SELECT jsonb_agg(jsonb_build_object('profileId',m.customer_profile_id,'profileKind',cp.profile_kind)
    ORDER BY m.member_position) INTO v_members
   FROM profile_reconciliation_case_members m JOIN customer_profiles cp
     ON cp.tenant_id=m.tenant_id AND cp.legal_entity_id=m.legal_entity_id
    AND cp.customer_profile_id=m.customer_profile_id
   WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
     AND m.profile_reconciliation_case_id=p_case_id;
  RETURN QUERY SELECT 'RECONCILIATION_AVAILABLE',jsonb_build_object(
    'caseId',p_case_id,'profileKind',v_case.profile_kind,'members',coalesce(v_members,'[]'::jsonb),
    'createdAt',to_char(v_case.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(greatest(
      coalesce(v_case.resolved_at,v_case.recorded_at),
      coalesce((SELECT max(owner_outcome.observed_at)
        FROM profile_reconciliation_owner_outcomes owner_outcome
        WHERE owner_outcome.tenant_id=p_tenant_id
          AND owner_outcome.legal_entity_id=p_legal_entity_id
          AND owner_outcome.profile_reconciliation_case_id=p_case_id),v_case.recorded_at),
      coalesce((SELECT max(observation.occurred_at)
        FROM party_merge_profile_observations observation
        WHERE observation.tenant_id=p_tenant_id
          AND observation.legal_entity_id=p_legal_entity_id
          AND observation.merge_resource_id=v_case.merge_resource_id),v_case.recorded_at)
    ) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastProcessedEventVersion',v_case.last_processed_event_version::text,'ownerOutcomes',v_case.owner_outcomes,
    'reason',coalesce(v_case.reason,'Reconciliation evidence'),'resultingState',v_case.resulting_state,
    'revision',v_case.revision,'sourceCorrelationRef',v_case.source_correlation_ref,
    'state',v_case.lifecycle,'survivorProfileId',v_case.canonical_profile_id,
    'targetSubject',v_case.target_subject,'trigger',v_case.trigger);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_customer_profile"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_id uuid, p_profile_kind text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE v_profile customer_profiles%ROWTYPE; v_subject jsonb; v_case_id uuid; v_case_target_subject jsonb;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_profile FROM customer_profiles
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND customer_profile_id=p_profile_id AND profile_kind=p_profile_kind;
  IF NOT FOUND THEN RETURN QUERY SELECT 'PROFILE_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  SELECT c.profile_reconciliation_case_id,c.target_subject INTO v_case_id,v_case_target_subject
    FROM profile_reconciliation_case_members m JOIN profile_reconciliation_cases c
      USING (tenant_id,legal_entity_id,profile_reconciliation_case_id)
   WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
     AND m.customer_profile_id=p_profile_id AND c.lifecycle<>'COMPLETED'
   ORDER BY c.recorded_at LIMIT 1;
  IF p_profile_kind='RETAIL' THEN
    SELECT jsonb_build_object('kind','RETAIL','partyResourceId',party_resource_id,
      'partyResourceRevision',party_resource_revision,'attributionKind',attribution_kind)
      INTO v_subject FROM retail_customer_profiles
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND retail_customer_profile_id=p_profile_id;
  ELSE
    SELECT jsonb_build_object('kind','COUNTERPARTY','counterpartyResourceId',counterparty_resource_id,
      'counterpartyResourceRevision',counterparty_resource_revision,
      'customerRoleResourceId',customer_role_resource_id,
      'customerRoleResourceRevision',customer_role_resource_revision)
      INTO v_subject FROM counterparty_purchasing_profiles
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND counterparty_purchasing_profile_id=p_profile_id;
  END IF;
  IF v_subject IS NULL THEN RETURN QUERY SELECT 'PROFILE_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED',jsonb_build_object(
      'profileId',p_profile_id,'profileKind',p_profile_kind,'caseId',v_case_id,
      'state',v_profile.lifecycle,'revision',v_profile.revision,
      'createdAt',to_char(v_profile.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt',to_char(v_profile.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'observedAt',to_char(v_profile.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'targetSubject',v_case_target_subject,
      'subject',v_subject);
    RETURN;
  END IF;
  RETURN QUERY SELECT 'PROFILE_AVAILABLE',jsonb_build_object(
    'profileId',p_profile_id,'profileKind',p_profile_kind,'state',v_profile.lifecycle,
    'revision',v_profile.revision,
    'createdAt',to_char(v_profile.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(v_profile.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'subject',v_subject);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_profile_trading_gate"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_id uuid, p_profile_kind text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
BEGIN
  RETURN QUERY SELECT * FROM read_customer_profile(p_tenant_id,p_legal_entity_id,p_profile_id,p_profile_kind);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_retail_portal_binding"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_binding_id uuid, p_requesting_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE v_binding retail_portal_profile_bindings%ROWTYPE; v_case_id uuid;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_binding FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=p_binding_id
     AND principal_id=p_requesting_principal_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'BINDING_NOT_FOUND',NULL::jsonb; RETURN; END IF;
  SELECT c.profile_reconciliation_case_id INTO v_case_id
    FROM profile_reconciliation_case_members m JOIN profile_reconciliation_cases c
      USING (tenant_id,legal_entity_id,profile_reconciliation_case_id)
   WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
     AND m.customer_profile_id=v_binding.retail_customer_profile_id AND c.lifecycle<>'COMPLETED'
   ORDER BY c.recorded_at LIMIT 1;
  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT 'BINDING_RECONCILIATION_REQUIRED',jsonb_build_object(
      'bindingId',p_binding_id,'profileId',v_binding.retail_customer_profile_id,'caseId',v_case_id,
      'observedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revision',v_binding.revision); RETURN;
  END IF;
  RETURN QUERY SELECT 'BINDING_AVAILABLE',jsonb_build_object(
    'bindingId',v_binding.retail_portal_profile_binding_id,
    'profileId',v_binding.retail_customer_profile_id,'principalId',v_binding.principal_id,
    'enrollmentEvidenceRef',v_binding.enrollment_evidence_ref,'state',v_binding.lifecycle,
    'revision',v_binding.revision,'revokedAt',CASE WHEN v_binding.revoked_at IS NULL THEN NULL ELSE to_char(v_binding.revoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'createdAt',to_char(v_binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'reason',coalesce(v_binding.reason,'Binding transition recorded'));
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."resolve_retail_principal"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_id uuid, p_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_count integer;
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_case_id uuid;
  v_profile customer_profiles%ROWTYPE;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT cp.* INTO v_profile
    FROM customer_profiles cp
    JOIN retail_customer_profiles rp
      ON rp.tenant_id=cp.tenant_id AND rp.legal_entity_id=cp.legal_entity_id
     AND rp.retail_customer_profile_id=cp.customer_profile_id
   WHERE cp.tenant_id=p_tenant_id AND cp.legal_entity_id=p_legal_entity_id
     AND cp.customer_profile_id=p_profile_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND',NULL::jsonb; RETURN;
  END IF;
  SELECT c.profile_reconciliation_case_id INTO v_case_id
    FROM profile_reconciliation_case_members m JOIN profile_reconciliation_cases c
      USING (tenant_id,legal_entity_id,profile_reconciliation_case_id)
   WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
     AND m.customer_profile_id=p_profile_id AND c.lifecycle<>'COMPLETED'
   ORDER BY c.recorded_at LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS',jsonb_build_object(
      'profileId',p_profile_id,'caseId',v_case_id,
      'observedAt',to_char(v_profile.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revision',v_profile.revision); RETURN;
  END IF;
  SELECT count(*) INTO v_count FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_customer_profile_id=p_profile_id AND principal_id=p_principal_id;
  IF v_count=0 THEN RETURN QUERY SELECT 'RETAIL_PRINCIPAL_NOT_BOUND',jsonb_build_object(
    'profileId',p_profile_id,
    'observedAt',to_char(v_profile.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revision',v_profile.revision); RETURN; END IF;
  IF v_count>1 THEN
    RETURN QUERY SELECT 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS',jsonb_build_object(
      'profileId',p_profile_id,'caseId',v_case_id,
      'observedAt',to_char(v_profile.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revision',v_profile.revision); RETURN;
  END IF;
  SELECT * INTO v_binding FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_customer_profile_id=p_profile_id AND principal_id=p_principal_id
   ORDER BY revision DESC LIMIT 1;
  RETURN QUERY SELECT CASE v_binding.lifecycle WHEN 'ACTIVE' THEN 'RETAIL_PRINCIPAL_BOUND' ELSE 'RETAIL_PRINCIPAL_BINDING_REVOKED' END,
    jsonb_build_object('profileId',p_profile_id,'bindingId',v_binding.retail_portal_profile_binding_id,
      'observedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revision',v_binding.revision);
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."transition_profile"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id uuid,
  p_profile_kind text,
  p_expected_state text,
  p_expected_revision integer,
  p_target_state text,
  p_effective_at timestamptz,
  p_reason text,
  p_dependencies_satisfied boolean,
  p_reconfirmation_satisfied boolean,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_canonical_profile_ids uuid[];
  v_resource_type text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_effective_at IS NULL
     OR p_dependencies_satisfied IS NULL OR p_reconfirmation_satisfied IS NULL
     OR nullif(btrim(p_reason), '') IS NULL THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_profile FROM customer_profiles
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND customer_profile_id = p_profile_id AND profile_kind = p_profile_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  IF v_profile.lifecycle IS DISTINCT FROM p_expected_state
     OR v_profile.revision IS DISTINCT FROM p_expected_revision THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM profile_reconciliation_case_members m
    JOIN profile_reconciliation_cases c USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
    WHERE m.tenant_id = p_tenant_id AND m.legal_entity_id = p_legal_entity_id
      AND m.customer_profile_id = p_profile_id AND c.lifecycle <> 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;
  IF NOT ((p_expected_state = 'ACTIVE' AND p_target_state IN ('SUSPENDED','ARCHIVED'))
       OR (p_expected_state = 'SUSPENDED' AND p_target_state IN ('ACTIVE','ARCHIVED'))
       OR (p_expected_state = 'ARCHIVED' AND p_target_state = 'ACTIVE')) THEN
    RETURN QUERY SELECT 'INVALID_LIFECYCLE_TRANSITION', NULL::jsonb;
    RETURN;
  END IF;
  IF p_target_state = 'ACTIVE' AND (NOT p_dependencies_satisfied OR NOT p_reconfirmation_satisfied) THEN
    RETURN QUERY SELECT 'REACTIVATION_RECONFIRMATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;

  UPDATE customer_profiles
  SET lifecycle = p_target_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND customer_profile_id = p_profile_id;
  INSERT INTO customer_profile_lifecycle_history(
    tenant_id, legal_entity_id, customer_profile_id, revision, from_lifecycle, to_lifecycle,
    recorded_at, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_profile_id, v_profile.revision + 1,
    v_profile.lifecycle, p_target_state, p_effective_at, p_action_invocation_id,
    p_actor_principal_id, btrim(p_reason)
  );

  v_resource_type := CASE p_profile_kind WHEN 'RETAIL'
    THEN 'commerce.customer-context.retail-customer-profile'
    ELSE 'commerce.customer-context.counterparty-purchasing-profile' END;
  RETURN QUERY SELECT
    CASE p_target_state WHEN 'ACTIVE' THEN 'PROFILE_REACTIVATED'
      WHEN 'SUSPENDED' THEN 'PROFILE_SUSPENDED' ELSE 'PROFILE_ARCHIVED' END,
    jsonb_build_object(
      'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', CASE p_target_state WHEN 'ACTIVE' THEN 'PROFILE_REACTIVATED'
        WHEN 'SUSPENDED' THEN 'PROFILE_SUSPENDED' ELSE 'PROFILE_ARCHIVED' END,
      'previousState', v_profile.lifecycle,
      'profileRef', jsonb_build_object('moduleId','commerce.customer-context','resourceId',p_profile_id,'resourceType',v_resource_type,'tenantId',p_tenant_id),
      'revision', v_profile.revision + 1,
      'state', p_target_state
    );
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id uuid,
  p_principal_id uuid,
  p_auth_binding_id uuid,
  p_enrollment_evidence_ref text,
  p_expected_state text,
  p_expected_revision integer,
  p_operation text,
  p_effective_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_profile_state text;
  v_next_state text;
  v_next_revision integer;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_auth_binding_id IS NULL
     OR p_principal_id IS NULL OR p_effective_at IS NULL
     OR nullif(btrim(p_enrollment_evidence_ref), '') IS NULL OR nullif(btrim(p_reason), '') IS NULL
     OR p_operation IS NULL OR p_operation NOT IN ('BIND','RECOVER','REVOKE') THEN
    RETURN QUERY SELECT 'ENROLLMENT_EVIDENCE_INSUFFICIENT', NULL::jsonb;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':binding:' || p_profile_id::text || ':' || p_principal_id::text, 0));
  SELECT cp.lifecycle INTO v_profile_state
  FROM retail_customer_profiles rp JOIN customer_profiles cp
    ON cp.tenant_id=rp.tenant_id AND cp.legal_entity_id=rp.legal_entity_id
   AND cp.customer_profile_id=rp.retail_customer_profile_id
  WHERE rp.tenant_id=p_tenant_id AND rp.legal_entity_id=p_legal_entity_id
    AND rp.retail_customer_profile_id=p_profile_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM profile_reconciliation_case_members m
    JOIN profile_reconciliation_cases c USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
    WHERE m.tenant_id=p_tenant_id AND m.legal_entity_id=p_legal_entity_id
      AND m.customer_profile_id=p_profile_id AND c.lifecycle<>'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  IF p_operation IN ('BIND','RECOVER') AND v_profile_state <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'PROFILE_NOT_ACTIVE', NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_binding FROM retail_portal_profile_bindings
  WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
    AND retail_customer_profile_id=p_profile_id AND principal_id=p_principal_id
  ORDER BY revision DESC, created_at DESC LIMIT 1 FOR UPDATE;

  IF p_operation = 'BIND' THEN
    IF p_expected_state IS NOT NULL OR p_expected_revision IS NOT NULL THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb; RETURN;
    END IF;
    IF FOUND THEN
      IF v_binding.lifecycle='ACTIVE' AND v_binding.auth_binding_id=p_auth_binding_id
         AND v_binding.enrollment_evidence_ref=btrim(p_enrollment_evidence_ref) THEN
        RETURN QUERY SELECT 'BINDING_CONFLICT', NULL::jsonb; RETURN;
      END IF;
      RETURN QUERY SELECT 'BINDING_CONFLICT', NULL::jsonb; RETURN;
    END IF;
    INSERT INTO retail_portal_profile_bindings(
      tenant_id, legal_entity_id, retail_customer_profile_id, principal_id, auth_binding_id,
      enrollment_evidence_ref, lifecycle, revision, revoked_at,
      action_invocation_id, actor_principal_id, reason
    ) VALUES (
      p_tenant_id,p_legal_entity_id,p_profile_id,p_principal_id,p_auth_binding_id,
      btrim(p_enrollment_evidence_ref),'ACTIVE',1,NULL,
      p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
    ) RETURNING * INTO v_binding;
    v_next_state := 'ACTIVE'; v_next_revision := 1;
    INSERT INTO retail_portal_profile_binding_history(
      tenant_id,legal_entity_id,retail_portal_profile_binding_id,revision,from_lifecycle,
      to_lifecycle,effective_at,enrollment_evidence_ref,action_invocation_id,actor_principal_id,reason
    ) VALUES (
      p_tenant_id,p_legal_entity_id,v_binding.retail_portal_profile_binding_id,1,NULL,'ACTIVE',
      p_effective_at,btrim(p_enrollment_evidence_ref),p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
    );
  ELSE
    IF NOT FOUND THEN RETURN QUERY SELECT 'BINDING_NOT_FOUND', NULL::jsonb; RETURN; END IF;
    IF v_binding.auth_binding_id IS DISTINCT FROM p_auth_binding_id THEN
      RETURN QUERY SELECT 'BINDING_CONFLICT', NULL::jsonb; RETURN;
    END IF;
    IF v_binding.lifecycle IS DISTINCT FROM p_expected_state
       OR v_binding.revision IS DISTINCT FROM p_expected_revision THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb; RETURN;
    END IF;
    IF (p_operation='RECOVER' AND p_expected_state<>'REVOKED')
       OR (p_operation='REVOKE' AND p_expected_state<>'ACTIVE') THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb; RETURN;
    END IF;
    v_next_state := CASE p_operation WHEN 'RECOVER' THEN 'ACTIVE' ELSE 'REVOKED' END;
    v_next_revision := v_binding.revision + 1;
    UPDATE retail_portal_profile_bindings
    SET lifecycle=v_next_state, revision=v_next_revision,
        revoked_at=CASE WHEN v_next_state='REVOKED' THEN p_effective_at ELSE NULL END,
        enrollment_evidence_ref=btrim(p_enrollment_evidence_ref),
        action_invocation_id=p_action_invocation_id,
        actor_principal_id=p_actor_principal_id, reason=btrim(p_reason), updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
      AND retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id;
    INSERT INTO retail_portal_profile_binding_history(
      tenant_id,legal_entity_id,retail_portal_profile_binding_id,revision,from_lifecycle,
      to_lifecycle,effective_at,enrollment_evidence_ref,action_invocation_id,actor_principal_id,reason
    ) VALUES (
      p_tenant_id,p_legal_entity_id,v_binding.retail_portal_profile_binding_id,v_next_revision,
      v_binding.lifecycle,v_next_state,p_effective_at,btrim(p_enrollment_evidence_ref),
      p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
    );
  END IF;

  RETURN QUERY SELECT
    CASE p_operation WHEN 'BIND' THEN 'BINDING_ACTIVATED' WHEN 'RECOVER' THEN 'BINDING_RECOVERED' ELSE 'BINDING_REVOKED' END,
    jsonb_build_object(
      'bindingRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_binding.retail_portal_profile_binding_id,'resourceType','commerce.customer-context.retail-portal-profile-binding','tenantId',p_tenant_id),
      'effectiveAt',to_char(p_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome',CASE p_operation WHEN 'BIND' THEN 'BINDING_ACTIVATED' WHEN 'RECOVER' THEN 'BINDING_RECOVERED' ELSE 'BINDING_REVOKED' END,
      'revision',v_next_revision,'state',v_next_state
    );
END
$routine$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."ensure_counterparty_profile"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_counterparty_resource_revision text,
  p_customer_role_resource_id text,
  p_customer_role_resource_revision text,
  p_effective_at timestamptz,
  p_trigger text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_canonical_profile_ids uuid[];
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_effective_at IS NULL
     OR nullif(btrim(p_counterparty_resource_id), '') IS NULL
     OR nullif(btrim(p_customer_role_resource_id), '') IS NULL
     OR nullif(btrim(p_customer_role_resource_revision), '') IS NULL
     OR p_trigger IS NULL
     OR p_trigger NOT IN ('AUTHORIZED_ONBOARDING', 'ENSURE_BEFORE_ORDER_ACCEPTANCE', 'GUEST_RETAIL_ATTRIBUTION')
  THEN
    RETURN QUERY SELECT 'COUNTERPARTY_ROLE_NOT_ELIGIBLE', NULL::jsonb;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':counterparty:' || btrim(p_counterparty_resource_id), 0));

  IF EXISTS (
    SELECT 1
      FROM profile_reconciliation_cases c
     WHERE c.tenant_id=p_tenant_id AND c.legal_entity_id=p_legal_entity_id
       AND c.profile_kind='COUNTERPARTY'
       AND c.canonical_party_resource_id=btrim(p_counterparty_resource_id)
       AND c.lifecycle<>'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED',NULL::jsonb;
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT c.canonical_profile_id) INTO v_canonical_profile_ids
    FROM profile_reconciliation_cases c
   WHERE c.tenant_id=p_tenant_id AND c.legal_entity_id=p_legal_entity_id
     AND c.profile_kind='COUNTERPARTY'
     AND c.canonical_party_resource_id=btrim(p_counterparty_resource_id)
     AND c.lifecycle='COMPLETED' AND c.canonical_profile_id IS NOT NULL;
  IF coalesce(cardinality(v_canonical_profile_ids),0)>1 THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED',NULL::jsonb;
    RETURN;
  END IF;

  IF coalesce(cardinality(v_canonical_profile_ids),0)=1 THEN
    SELECT cp.* INTO v_profile FROM customer_profiles cp
     WHERE cp.tenant_id=p_tenant_id AND cp.legal_entity_id=p_legal_entity_id
       AND cp.customer_profile_id=v_canonical_profile_ids[1]
     FOR UPDATE;
  ELSE
    SELECT cp.* INTO v_profile
    FROM counterparty_purchasing_profiles pp
    JOIN customer_profiles cp
      ON cp.tenant_id = pp.tenant_id AND cp.legal_entity_id = pp.legal_entity_id
     AND cp.customer_profile_id = pp.counterparty_purchasing_profile_id
    WHERE pp.tenant_id = p_tenant_id AND pp.legal_entity_id = p_legal_entity_id
      AND pp.counterparty_resource_id = btrim(p_counterparty_resource_id)
    FOR UPDATE OF cp;
  END IF;

  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM profile_reconciliation_case_members m
      JOIN profile_reconciliation_cases c USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
      WHERE m.tenant_id = p_tenant_id AND m.legal_entity_id = p_legal_entity_id
        AND m.customer_profile_id = v_profile.customer_profile_id AND c.lifecycle <> 'COMPLETED'
    ) THEN
      RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
      RETURN;
    END IF;
    RETURN QUERY SELECT
      ('PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle)::text,
      jsonb_build_object(
        'outcome','PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle,
        'profileRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_profile.customer_profile_id,'resourceType','commerce.customer-context.counterparty-purchasing-profile','tenantId',p_tenant_id),
        'revision',v_profile.revision,'state',v_profile.lifecycle
      );
    RETURN;
  END IF;

  BEGIN
    INSERT INTO customer_profiles(tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
    VALUES (p_tenant_id, p_legal_entity_id, 'COUNTERPARTY', 'ACTIVE', 1)
    RETURNING * INTO v_profile;
    INSERT INTO counterparty_purchasing_profiles(
      counterparty_purchasing_profile_id, tenant_id, legal_entity_id, counterparty_resource_id,
      counterparty_resource_revision, customer_role_resource_id, customer_role_resource_revision
    ) VALUES (
      v_profile.customer_profile_id, p_tenant_id, p_legal_entity_id, btrim(p_counterparty_resource_id),
      nullif(btrim(p_counterparty_resource_revision), ''), btrim(p_customer_role_resource_id),
      btrim(p_customer_role_resource_revision)
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'COUNTERPARTY_ROLE_NOT_ELIGIBLE', NULL::jsonb;
    RETURN;
  END;
  INSERT INTO customer_profile_lifecycle_history(
    tenant_id, legal_entity_id, customer_profile_id, revision, from_lifecycle, to_lifecycle,
    recorded_at, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile.customer_profile_id, 1, NULL, 'ACTIVE',
    p_effective_at, p_action_invocation_id, p_actor_principal_id, 'Created by ' || p_trigger
  );
  RETURN QUERY SELECT 'PROFILE_CREATED', jsonb_build_object(
    'outcome','PROFILE_CREATED',
    'profileRef',jsonb_build_object('moduleId','commerce.customer-context','resourceId',v_profile.customer_profile_id,'resourceType','commerce.customer-context.counterparty-purchasing-profile','tenantId',p_tenant_id),
    'revision',1,'state','ACTIVE'
  );
END
$routine$;

-- Function creation grants EXECUTE to PUBLIC by default. The runtime receives only the owner
-- routines; the scope assertion remains private to the owning role.
REVOKE ALL ON FUNCTION "commerce_customer_context"."assert_profile_operation_scope"(uuid,uuid) FROM PUBLIC, "ontos_runtime";

REVOKE ALL ON FUNCTION "commerce_customer_context"."ensure_retail_profile"(uuid,uuid,text,text,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."ensure_counterparty_profile"(uuid,uuid,text,text,text,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."transition_profile"(uuid,uuid,uuid,text,text,integer,text,timestamptz,text,boolean,boolean,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(uuid,uuid,uuid,uuid,uuid,text,text,integer,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_customer_profile"(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_profile_trading_gate"(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_retail_portal_binding"(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."resolve_retail_principal"(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."open_profile_reconciliation"(uuid,uuid,uuid[],text,text,jsonb,jsonb,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."resolve_profile_reconciliation"(uuid,uuid,uuid,uuid,integer,bigint,jsonb,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_profile_reconciliation_owner_outcome"(uuid,uuid,uuid,uuid,text,text,text,text,integer,bigint,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_profile_reconciliation"(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_guest_attribution"(uuid,uuid,text,text,text,text,uuid,text,timestamptz,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_guest_attribution"(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."observe_party_merge_reconciliation"(uuid,uuid,text,uuid,uuid,bigint,timestamptz,text,text,text[],jsonb,uuid) FROM PUBLIC;

-- Runtime grants are intentionally deferred until the migrations that create every relation and
-- column referenced by each routine. The prefix therefore fails closed instead of exposing a
-- callable routine whose lazily planned body references schema that does not exist yet.
