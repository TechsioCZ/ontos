-- The Resolve Action has one transaction boundary.  Keep all Commerce Customer Context owner
-- checks behind the same scoped routine so a retry cannot observe a different set of member facts
-- between verification and recording its durable owner receipt.
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
  v_status text;
  v_evidence_ref text;
  v_existing_status text;
  v_existing_evidence_ref text;
  v_existing_correlation_ref text;
  v_existing_event_version bigint;
  v_existing_survivor_profile_id uuid;
  v_existing_resulting_state text;
  v_has_existing boolean := false;
  v_total_count integer := 0;
  v_survivor_count integer := 0;
  v_loser_count integer := 0;
  v_lifecycle_mismatches integer := 0;
  v_provenance_ref text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);

  -- APPROVAL and CONNECTOR_CORRELATION deliberately remain external owner capabilities.  They
  -- are returned as OWNER_UNAVAILABLE here and become the exact typed UNAVAILABLE result in the
  -- application adapter; this routine must never synthesize evidence for either owner.
  IF p_case_id IS NULL OR p_survivor_profile_id IS NULL OR p_owner IS NULL
     OR p_owner NOT IN (
       'PROFILE_LIFECYCLE','CUSTOMER_GROUP_MEMBERSHIP','PRICE_GROUP_ASSIGNMENT',
       'CURRENCY_PREFERENCE','PAYMENT_TERMS','ADDRESS_BOOK','RETAIL_PORTAL_BINDING',
       'COUNTERPARTY_ACCESS','PURCHASE_LIMITS','APPROVAL','CONNECTOR_CORRELATION'
     )
     OR p_resulting_state IS NULL OR p_resulting_state NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
     OR p_desired_status IS NULL OR p_desired_status NOT IN ('RESOLVED','NOT_APPLICABLE')
     OR p_expected_revision IS NULL OR p_expected_event_version IS NULL
     OR p_effective_at IS NULL OR nullif(btrim(p_reason),'') IS NULL
     OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL THEN
    RETURN QUERY SELECT 'OWNER_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;
  IF p_owner IN ('APPROVAL','CONNECTOR_CORRELATION') THEN
    RETURN QUERY SELECT 'OWNER_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_case FROM profile_reconciliation_cases
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND profile_reconciliation_case_id=p_case_id
   FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
       SELECT 1 FROM profile_reconciliation_case_members member
        WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
          AND member.profile_reconciliation_case_id=p_case_id
          AND member.customer_profile_id=p_survivor_profile_id
     ) THEN
    RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  -- The owner receipt is also a proof of the exact canonical target selected for this case.  Do
  -- not let a malformed or cross-scope target become evidence merely because owner-local facts
  -- happen to be empty.
  IF v_case.profile_kind NOT IN ('RETAIL','COUNTERPARTY')
     OR nullif(btrim(v_case.source_correlation_ref),'') IS NULL
     OR jsonb_typeof(v_case.target_subject) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_case.canonicalization_evidence) IS DISTINCT FROM 'object'
     OR nullif(btrim(v_case.canonicalization_evidence->>'evidenceKind'),'') IS NULL
     OR v_case.canonicalization_evidence->>'evidenceKind' NOT IN ('PARTY_OWNER_OBSERVATION','AUTHORIZED_OPERATOR_DECISION')
     OR (v_case.canonicalization_evidence->>'evidenceKind'='AUTHORIZED_OPERATOR_DECISION'
       AND nullif(btrim(v_case.canonicalization_evidence->>'decisionRef'),'') IS NULL)
     OR (v_case.canonicalization_evidence->>'evidenceKind'='PARTY_OWNER_OBSERVATION'
       AND (v_case.canonicalization_evidence->>'sourceOwnerModuleId' IS DISTINCT FROM 'party.registry'
         OR nullif(btrim(v_case.canonicalization_evidence->>'sourceDomainEventId'),'') IS NULL
         OR nullif(btrim(v_case.canonicalization_evidence->>'sourceMessageId'),'') IS NULL
         OR coalesce(v_case.canonicalization_evidence->>'sourceEventVersion','') !~ '^[1-9][0-9]*$'))
     OR nullif(btrim(v_case.canonicalization_evidence->>'policyVersion'),'') IS NULL
     OR nullif(btrim(v_case.canonicalization_evidence->>'observedAt'),'') IS NULL
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

  -- Lock every profile participating in the case before reading any owner projection.  The
  -- profile transition/Resolve routines use the same lock order, making retries deterministic.
  PERFORM 1
    FROM profile_reconciliation_case_members member
    JOIN customer_profiles profile
      ON profile.tenant_id=member.tenant_id AND profile.legal_entity_id=member.legal_entity_id
     AND profile.customer_profile_id=member.customer_profile_id
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.profile_reconciliation_case_id=p_case_id
   ORDER BY member.member_position
   FOR UPDATE OF profile;

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

  ELSIF p_owner='RETAIL_PORTAL_BINDING' THEN
    IF v_case.profile_kind<>'RETAIL' THEN
      v_status:='NOT_APPLICABLE';
    ELSE
      PERFORM 1
        FROM profile_reconciliation_case_members member
        JOIN retail_portal_profile_bindings binding
          ON binding.tenant_id=member.tenant_id AND binding.legal_entity_id=member.legal_entity_id
         AND binding.retail_customer_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id
       ORDER BY member.member_position, binding.revision
       FOR UPDATE OF binding;
      SELECT count(*) FILTER (WHERE binding.lifecycle='ACTIVE'),
             count(*) FILTER (WHERE binding.lifecycle='ACTIVE'
                               AND binding.retail_customer_profile_id<>p_survivor_profile_id)
        INTO v_total_count,v_loser_count
        FROM profile_reconciliation_case_members member
        JOIN retail_portal_profile_bindings binding
          ON binding.tenant_id=member.tenant_id AND binding.legal_entity_id=member.legal_entity_id
         AND binding.retail_customer_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id;
      IF v_loser_count<>0 THEN
        RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
        RETURN;
      END IF;
      v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
    END IF;

  ELSIF p_owner='CUSTOMER_GROUP_MEMBERSHIP' THEN
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN customer_group_memberships membership
        ON membership.tenant_id=member.tenant_id AND membership.legal_entity_id=member.legal_entity_id
       AND membership.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, membership.revision
     FOR UPDATE OF membership;
    SELECT count(*) FILTER (WHERE membership.lifecycle='ACTIVE' AND membership.effective_to IS NULL),
           count(*) FILTER (WHERE membership.lifecycle='ACTIVE' AND membership.effective_to IS NULL
                             AND membership.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN customer_group_memberships membership
        ON membership.tenant_id=member.tenant_id AND membership.legal_entity_id=member.legal_entity_id
       AND membership.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    IF v_loser_count<>0 THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;

  ELSIF p_owner='PRICE_GROUP_ASSIGNMENT' THEN
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN customer_price_group_assignments assignment
        ON assignment.tenant_id=member.tenant_id AND assignment.legal_entity_id=member.legal_entity_id
       AND assignment.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, assignment.revision
     FOR UPDATE OF assignment;
    SELECT count(*) FILTER (WHERE assignment.lifecycle='ACTIVE' AND assignment.effective_to IS NULL),
           count(*) FILTER (WHERE assignment.lifecycle='ACTIVE' AND assignment.effective_to IS NULL
                             AND assignment.customer_profile_id=p_survivor_profile_id),
           count(*) FILTER (WHERE assignment.lifecycle='ACTIVE' AND assignment.effective_to IS NULL
                             AND assignment.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_survivor_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN customer_price_group_assignments assignment
        ON assignment.tenant_id=member.tenant_id AND assignment.legal_entity_id=member.legal_entity_id
       AND assignment.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    IF v_loser_count<>0 OR v_survivor_count>1 THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;

  ELSIF p_owner='CURRENCY_PREFERENCE' THEN
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN customer_currency_preferences preference
        ON preference.tenant_id=member.tenant_id AND preference.legal_entity_id=member.legal_entity_id
       AND preference.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, preference.revision
     FOR UPDATE OF preference;
    SELECT count(*) FILTER (WHERE preference.lifecycle='ACTIVE' AND preference.effective_to IS NULL),
           count(*) FILTER (WHERE preference.lifecycle='ACTIVE' AND preference.effective_to IS NULL
                             AND preference.customer_profile_id=p_survivor_profile_id),
           count(*) FILTER (WHERE preference.lifecycle='ACTIVE' AND preference.effective_to IS NULL
                             AND preference.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_survivor_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN customer_currency_preferences preference
        ON preference.tenant_id=member.tenant_id AND preference.legal_entity_id=member.legal_entity_id
       AND preference.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    IF v_loser_count<>0 OR v_survivor_count>1 THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;

  ELSIF p_owner='PAYMENT_TERMS' THEN
    -- Read the two Payment Terms projections separately.  A join between preferences and
    -- entitlements would multiply rows and could turn one valid fact into a false conflict.
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN customer_payment_term_entitlements entitlement
        ON entitlement.tenant_id=member.tenant_id AND entitlement.legal_entity_id=member.legal_entity_id
       AND entitlement.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, entitlement.revision
     FOR UPDATE OF entitlement;
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN customer_payment_term_preferences preference
        ON preference.tenant_id=member.tenant_id AND preference.legal_entity_id=member.legal_entity_id
       AND preference.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, preference.revision
     FOR UPDATE OF preference;
    SELECT count(*) FILTER (WHERE preference.lifecycle='ACTIVE' AND preference.effective_to IS NULL),
           count(*) FILTER (WHERE preference.lifecycle='ACTIVE' AND preference.effective_to IS NULL
                             AND preference.customer_profile_id=p_survivor_profile_id),
           count(*) FILTER (WHERE preference.lifecycle='ACTIVE' AND preference.effective_to IS NULL
                             AND preference.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_survivor_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN customer_payment_term_preferences preference
        ON preference.tenant_id=member.tenant_id AND preference.legal_entity_id=member.legal_entity_id
       AND preference.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    SELECT v_total_count + count(*) FILTER (WHERE entitlement.lifecycle='ACTIVE' AND entitlement.effective_to IS NULL),
           v_survivor_count + count(*) FILTER (WHERE entitlement.lifecycle='ACTIVE' AND entitlement.effective_to IS NULL
                             AND entitlement.customer_profile_id=p_survivor_profile_id),
           v_loser_count + count(*) FILTER (WHERE entitlement.lifecycle='ACTIVE' AND entitlement.effective_to IS NULL
                             AND entitlement.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_survivor_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN customer_payment_term_entitlements entitlement
        ON entitlement.tenant_id=member.tenant_id AND entitlement.legal_entity_id=member.legal_entity_id
       AND entitlement.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    IF v_loser_count<>0 OR v_survivor_count>1 THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;

  ELSIF p_owner='ADDRESS_BOOK' THEN
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN saved_addresses address
        ON address.tenant_id=member.tenant_id AND address.legal_entity_id=member.legal_entity_id
       AND address.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, address.revision
     FOR UPDATE OF address;
    PERFORM 1
      FROM profile_reconciliation_case_members member
      JOIN customer_address_defaults defaults
        ON defaults.tenant_id=member.tenant_id AND defaults.legal_entity_id=member.legal_entity_id
       AND defaults.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id
     ORDER BY member.member_position, defaults.revision
     FOR UPDATE OF defaults;
    SELECT count(*) FILTER (WHERE address.lifecycle='ACTIVE'),
           count(*) FILTER (WHERE address.lifecycle='ACTIVE'
                             AND address.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN saved_addresses address
        ON address.tenant_id=member.tenant_id AND address.legal_entity_id=member.legal_entity_id
       AND address.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    SELECT v_total_count + count(*) FILTER (WHERE defaults.lifecycle='ACTIVE' AND defaults.effective_to IS NULL),
           v_loser_count + count(*) FILTER (WHERE defaults.lifecycle='ACTIVE' AND defaults.effective_to IS NULL
                                             AND defaults.customer_profile_id<>p_survivor_profile_id)
      INTO v_total_count,v_loser_count
      FROM profile_reconciliation_case_members member
      JOIN customer_address_defaults defaults
        ON defaults.tenant_id=member.tenant_id AND defaults.legal_entity_id=member.legal_entity_id
       AND defaults.customer_profile_id=member.customer_profile_id
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.profile_reconciliation_case_id=p_case_id;
    IF v_loser_count<>0 THEN
      RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;

  ELSIF p_owner='COUNTERPARTY_ACCESS' THEN
    IF v_case.profile_kind<>'COUNTERPARTY' THEN
      v_status:='NOT_APPLICABLE';
    ELSE
      -- COUNTERPARTY_ACCESS is an exact survivor-profile reconciliation.  We intentionally do
      -- never merge grants from the absorbed profiles: every live tuple must already belong to the
      -- selected survivor, and duplicate survivor tuples are a conflict rather than evidence to
      -- merge.  This keeps a loser grant from silently widening the survivor's authorization set.
      PERFORM 1
        FROM profile_reconciliation_case_members member
        JOIN counterparty_commerce_access_grants grant_row
          ON grant_row.tenant_id=member.tenant_id AND grant_row.legal_entity_id=member.legal_entity_id
         AND grant_row.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id
       ORDER BY member.member_position, grant_row.revision
       FOR UPDATE OF grant_row;
      PERFORM 1
        FROM profile_reconciliation_case_members member
        JOIN counterparty_access_invitations invitation
          ON invitation.tenant_id=member.tenant_id AND invitation.legal_entity_id=member.legal_entity_id
         AND invitation.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id
         AND invitation.lifecycle IN ('PENDING','CLAIMING','RECONCILIATION_REQUIRED')
       ORDER BY member.member_position, invitation.revision
       FOR UPDATE OF invitation;
      SELECT count(*) FILTER (WHERE grant_row.lifecycle IN ('PENDING_GRANT','ACTIVE','PENDING_REVOKE','RECONCILIATION_REQUIRED')),
             count(*) FILTER (WHERE grant_row.lifecycle IN ('PENDING_GRANT','ACTIVE','PENDING_REVOKE','RECONCILIATION_REQUIRED')
                               AND grant_row.counterparty_purchasing_profile_id<>p_survivor_profile_id)
        INTO v_total_count,v_loser_count
        FROM profile_reconciliation_case_members member
        JOIN counterparty_commerce_access_grants grant_row
          ON grant_row.tenant_id=member.tenant_id AND grant_row.legal_entity_id=member.legal_entity_id
         AND grant_row.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id;
      -- Count invitation claims independently from grants. Joining the two projections would
      -- multiply rows and effectively combine Permissions across profiles during reconciliation.
      SELECT v_total_count + count(*) FILTER (
               WHERE invitation.lifecycle IN ('PENDING','CLAIMING','RECONCILIATION_REQUIRED')
             ),
             v_loser_count + count(*) FILTER (
               WHERE invitation.lifecycle IN ('PENDING','CLAIMING','RECONCILIATION_REQUIRED')
                 AND invitation.counterparty_purchasing_profile_id<>p_survivor_profile_id
             )
        INTO v_total_count,v_loser_count
        FROM profile_reconciliation_case_members member
        JOIN counterparty_access_invitations invitation
          ON invitation.tenant_id=member.tenant_id AND invitation.legal_entity_id=member.legal_entity_id
         AND invitation.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id;
      IF EXISTS (
        SELECT 1
          FROM counterparty_commerce_access_grants grant_row
          JOIN profile_reconciliation_case_members member
            ON member.tenant_id=grant_row.tenant_id
           AND member.legal_entity_id=grant_row.legal_entity_id
           AND member.customer_profile_id=grant_row.counterparty_purchasing_profile_id
         WHERE grant_row.tenant_id=p_tenant_id AND grant_row.legal_entity_id=p_legal_entity_id
           AND member.profile_reconciliation_case_id=p_case_id
           AND grant_row.lifecycle IN ('PENDING_GRANT','ACTIVE','PENDING_REVOKE','RECONCILIATION_REQUIRED')
           AND grant_row.counterparty_purchasing_profile_id<>p_survivor_profile_id
      ) THEN
        RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM counterparty_commerce_access_grants survivor_grant
         WHERE survivor_grant.tenant_id=p_tenant_id AND survivor_grant.legal_entity_id=p_legal_entity_id
           AND survivor_grant.counterparty_purchasing_profile_id=p_survivor_profile_id
           AND survivor_grant.lifecycle IN ('PENDING_GRANT','ACTIVE','PENDING_REVOKE','RECONCILIATION_REQUIRED')
           AND EXISTS (
             SELECT 1 FROM counterparty_commerce_access_grants duplicate_grant
              WHERE duplicate_grant.tenant_id=survivor_grant.tenant_id
                AND duplicate_grant.legal_entity_id=survivor_grant.legal_entity_id
                AND duplicate_grant.counterparty_purchasing_profile_id=p_survivor_profile_id
                AND duplicate_grant.principal_id=survivor_grant.principal_id
                AND duplicate_grant.permission_code=survivor_grant.permission_code
                AND duplicate_grant.storefront_resource_id IS NOT DISTINCT FROM survivor_grant.storefront_resource_id
                AND duplicate_grant.lifecycle IN ('PENDING_GRANT','ACTIVE','PENDING_REVOKE','RECONCILIATION_REQUIRED')
                AND duplicate_grant.counterparty_commerce_access_grant_id<>survivor_grant.counterparty_commerce_access_grant_id
           )
      ) THEN
        RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
        RETURN;
      END IF;
      IF v_loser_count<>0 THEN
        RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
        RETURN;
      END IF;
      v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
    END IF;

  ELSIF p_owner='PURCHASE_LIMITS' THEN
    IF v_case.profile_kind<>'COUNTERPARTY' THEN
      v_status:='NOT_APPLICABLE';
    ELSE
      -- Purchase Limit mutations serialize on the Counterparty Purchasing Profile and then on
      -- the current policy row.  Take the same locks before deriving the owner receipt so a
      -- concurrent SET/CLEAR cannot change the facts between verification and recording.
      PERFORM 1
        FROM profile_reconciliation_case_members member
        JOIN counterparty_purchasing_profiles purchasing_profile
          ON purchasing_profile.tenant_id=member.tenant_id
         AND purchasing_profile.legal_entity_id=member.legal_entity_id
         AND purchasing_profile.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id
       ORDER BY member.member_position
       FOR UPDATE OF purchasing_profile;
      PERFORM 1
        FROM profile_reconciliation_case_members member
        JOIN counterparty_purchase_limit_defaults defaults
          ON defaults.tenant_id=member.tenant_id
         AND defaults.legal_entity_id=member.legal_entity_id
         AND defaults.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id
         AND defaults.is_current
       ORDER BY member.member_position, defaults.revision
       FOR UPDATE OF defaults;
      PERFORM 1
        FROM profile_reconciliation_case_members member
        JOIN principal_purchase_limit_overrides overrides
          ON overrides.tenant_id=member.tenant_id
         AND overrides.legal_entity_id=member.legal_entity_id
         AND overrides.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id
         AND overrides.is_current
       ORDER BY member.member_position, overrides.revision
       FOR UPDATE OF overrides;
      SELECT count(*) FILTER (WHERE defaults.is_current
                               AND defaults.policy_kind<>'CLEARED'),
             count(*) FILTER (WHERE defaults.is_current
                               AND defaults.policy_kind<>'CLEARED'
                               AND defaults.counterparty_purchasing_profile_id<>p_survivor_profile_id)
        INTO v_total_count,v_loser_count
        FROM profile_reconciliation_case_members member
        JOIN counterparty_purchase_limit_defaults defaults
          ON defaults.tenant_id=member.tenant_id AND defaults.legal_entity_id=member.legal_entity_id
         AND defaults.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id;
      SELECT v_total_count + count(*) FILTER (WHERE overrides.is_current
                                               AND overrides.policy_kind<>'CLEARED'),
             v_loser_count + count(*) FILTER (WHERE overrides.is_current
                                               AND overrides.policy_kind<>'CLEARED'
                                               AND overrides.counterparty_purchasing_profile_id<>p_survivor_profile_id)
        INTO v_total_count,v_loser_count
        FROM profile_reconciliation_case_members member
        JOIN principal_purchase_limit_overrides overrides
          ON overrides.tenant_id=member.tenant_id AND overrides.legal_entity_id=member.legal_entity_id
         AND overrides.counterparty_purchasing_profile_id=member.customer_profile_id
       WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
         AND member.profile_reconciliation_case_id=p_case_id;
      IF v_loser_count<>0 THEN
        RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb;
        RETURN;
      END IF;
      v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
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
