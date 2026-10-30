-- #1257: append-only per-intent proofs; final-owner authority remains unavailable by default.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."revalidate_purchase_approval"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_request_row purchase_approval_requests%ROWTYPE;
  v_proposal_row purchase_proposal_revisions%ROWTYPE;
  v_decision_row approval_decisions%ROWTYPE;
  v_existing approval_revalidations%ROWTYPE;
  v_revalidation jsonb;
  v_request_snapshot jsonb;
  v_ref jsonb;
  v_request_id text := p_payload->'requestRef'->>'resourceId';
  v_idempotency text := p_payload->>'idempotencyKey';
  v_status text;
  v_profile_state text := 'INACTIVE';
  v_route_current boolean := false;
  v_checked_at timestamptz;
  v_valid_until timestamptz;
  v_now timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  -- Establish owner-derived profile and route currentness before replay comparison.  The
  -- corresponding payload booleans are intentionally not trusted for either decision.
  SELECT request_snapshot INTO v_request_snapshot
    FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND request_resource_id = v_request_id
   FOR UPDATE;
  IF v_request_snapshot IS NOT NULL THEN
    IF v_request_snapshot->'proposal'->'identity'->'profileRef'->>'resourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      SELECT CASE WHEN cp.lifecycle = 'ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END
        INTO v_profile_state
        FROM counterparty_purchasing_profiles cpp
        JOIN customer_profiles cp
          ON cp.tenant_id = cpp.tenant_id
         AND cp.legal_entity_id = cpp.legal_entity_id
         AND cp.customer_profile_id = cpp.counterparty_purchasing_profile_id
       WHERE cpp.tenant_id = p_tenant_id
         AND cpp.legal_entity_id = p_legal_entity_id
         AND cpp.counterparty_purchasing_profile_id = (v_request_snapshot->'proposal'->'identity'->'profileRef'->>'resourceId')::uuid
         AND cpp.counterparty_resource_id = v_request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId';
    END IF;
    -- #1257 replay eligibility linearizes after the request lock and current owner reads.
    v_now := clock_timestamp();
    SELECT
      v_request_snapshot->>'status' = 'APPROVED'
      AND v_request_snapshot->'route'->>'status' = 'APPROVED'
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(v_request_snapshot->'route'->'levels') = 'array'
                 THEN v_request_snapshot->'route'->'levels' ELSE '[]'::jsonb END
          ) AS levels(level)
         WHERE level->'completedBy' IS NULL
      )
      AND EXISTS (
        SELECT 1
          FROM approval_hierarchies h
         WHERE h.tenant_id = p_tenant_id
           AND h.legal_entity_id = p_legal_entity_id
           AND h.hierarchy_resource_id = v_request_snapshot->'route'->'hierarchyRef'->>'resourceId'
           AND h.revision = (v_request_snapshot->'route'->>'hierarchyRevision')::integer
           AND h.hierarchy_snapshot->>'state' = 'ACTIVE'
           AND h.effective_from <= v_now
           AND (h.effective_to IS NULL OR v_now < h.effective_to)
      )
      AND (v_request_snapshot->>'expiresAt')::timestamptz > v_now
      INTO v_route_current;
  END IF;
  SELECT * INTO v_existing FROM approval_revalidations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency;
  IF FOUND THEN
    IF v_existing.request_resource_id IS DISTINCT FROM v_request_id
       OR v_existing.proposal_revision_resource_id IS DISTINCT FROM p_payload->'proposalRevisionRef'->>'resourceId'
       OR v_existing.proposal_hash IS DISTINCT FROM p_payload->>'expectedProposalHash'
       OR v_existing.evidence->>'buyerPermission' IS DISTINCT FROM p_payload->>'buyerPermission'
       OR v_existing.evidence->>'profileState' IS DISTINCT FROM v_profile_state
       OR v_existing.evidence->>'policyRouteCurrent' IS DISTINCT FROM lower(v_route_current::text)
       OR v_existing.evidence->>'decisionBundleHash' IS DISTINCT FROM p_payload->>'decisionBundleHash'
       OR v_existing.evidence->>'decisionBundleVersion' IS DISTINCT FROM p_payload->>'decisionBundleVersion'
       OR v_existing.evidence->'decisionRef' IS DISTINCT FROM p_payload->'decisionRef'
       OR v_existing.evidence->'hierarchyRef' IS DISTINCT FROM p_payload->'hierarchyRef'
       OR v_existing.evidence->'routeRef' IS DISTINCT FROM p_payload->'routeRef'
       OR v_existing.evidence->'sourceRevisions' IS DISTINCT FROM p_payload->'sourceRevisions'
       OR v_existing.evidence->'finalBindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding'
       OR v_existing.evidence->>'commitmentCorrelationId' IS DISTINCT FROM p_payload->>'commitmentCorrelationId' THEN
      RAISE EXCEPTION 'approval revalidation idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_revalidation_idem';
    END IF;
    SELECT request_snapshot INTO v_request_snapshot FROM purchase_approval_requests
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id;
    IF NOT FOUND OR v_existing.status NOT IN ('APPROVAL_VALID', 'ALREADY_CONSUMED') THEN
      RAISE EXCEPTION 'approval revalidation request snapshot is unavailable' USING ERRCODE = '40001', CONSTRAINT = 'pa_revalidation_snapshot_missing';
    END IF;
    IF v_existing.checked_at > v_now
       OR v_existing.valid_until <= v_now
       OR v_existing.valid_until <= v_existing.checked_at THEN
      RAISE EXCEPTION 'approval revalidation evidence is outside the trusted validity window' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_revalidation_expired';
    END IF;
    IF p_payload->>'checkedAt' IS NULL
       OR p_payload->>'validUntil' IS NULL
       OR (p_payload->>'checkedAt')::timestamptz > v_now
       OR (p_payload->>'validUntil')::timestamptz <= v_now
       OR (p_payload->>'validUntil')::timestamptz <= (p_payload->>'checkedAt')::timestamptz THEN
      RAISE EXCEPTION 'approval revalidation evidence is outside the trusted validity window' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_revalidation_expired';
    END IF;
    IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
       OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
       OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
       OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
       OR p_payload->>'storefrontId' IS DISTINCT FROM v_request_snapshot->'proposal'->'context'->>'storefrontId'
       OR p_payload->'requestRef' IS DISTINCT FROM v_request_snapshot->'requestRef'
       OR p_payload->'proposalRevisionRef' IS DISTINCT FROM v_request_snapshot->'proposal'->'proposalRevisionRef'
       OR p_payload->'routeRef' IS DISTINCT FROM v_request_snapshot->'route'->'routeRef'
       OR p_payload->'hierarchyRef' IS DISTINCT FROM v_request_snapshot->'route'->'hierarchyRef'
       OR v_existing.evidence->'decisionRef' IS DISTINCT FROM p_payload->'decisionRef' THEN
      RAISE EXCEPTION 'approval revalidation target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_revalidation_target';
    END IF;
    v_revalidation := jsonb_build_object(
      'revalidationRef', jsonb_build_object(
        'moduleId', 'commerce.customer-context',
        'resourceId', v_existing.revalidation_resource_id,
        'resourceType', 'commerce.customer-context.approval-revalidation',
        'tenantId', p_tenant_id
      ),
      'requestRef', v_request_snapshot->'requestRef',
      'proposalRevisionRef', v_request_snapshot->'proposal'->'proposalRevisionRef',
      'approvedRoute', v_request_snapshot->'route',
      'checkedAt', v_existing.checked_at,
      'validUntil', v_existing.valid_until,
      'status', v_existing.status,
      'committedOrderRef', v_request_snapshot->'committedOrderRef',
      'evidence', v_existing.evidence
    );
    v_status := CASE WHEN v_request_snapshot->>'status' = 'CONSUMED' THEN 'ALREADY_CONSUMED' ELSE v_existing.status END;
    v_revalidation := v_revalidation || jsonb_build_object('status', v_status);
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', v_status,
      'revalidation', v_revalidation
    );
    RETURN;
  END IF;
  SELECT * INTO v_request_row FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id FOR UPDATE;
  IF NOT FOUND OR v_request_row.proposal_revision_resource_id <> p_payload->'proposalRevisionRef'->>'resourceId'
     OR v_request_row.request_snapshot->'proposal'->>'canonicalHash' <> p_payload->>'expectedProposalHash' THEN
    RAISE EXCEPTION 'approval proposal revision is not the captured immutable revision' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_proposal_material';
  END IF;
  SELECT * INTO v_proposal_row FROM purchase_proposal_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND proposal_revision_resource_id = v_request_row.proposal_revision_resource_id
     AND revision = (v_request_row.request_snapshot->'proposal'->>'revision')::integer
     AND state IN ('CURRENT', 'CONSUMED')
   FOR SHARE;
  IF NOT FOUND OR v_proposal_row.canonical_hash IS DISTINCT FROM p_payload->>'expectedProposalHash'
     OR v_proposal_row.source_revision_vector IS DISTINCT FROM p_payload->'sourceRevisions' THEN
    RAISE EXCEPTION 'approval current source revisions are unavailable or changed' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_proposal_material';
  END IF;
  SELECT * INTO v_decision_row FROM approval_decisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND decision_resource_id = p_payload->'decisionRef'->>'resourceId'
     AND request_resource_id = v_request_row.request_resource_id
   FOR SHARE;
  IF NOT FOUND
     OR v_request_row.last_decision_resource_id IS DISTINCT FROM v_decision_row.decision_resource_id
     OR v_decision_row.decision <> 'APPROVE'
     OR v_decision_row.decision_snapshot->'proposalRevisionRef' IS DISTINCT FROM p_payload->'proposalRevisionRef'
     OR v_decision_row.decision_snapshot->'routeRef' IS DISTINCT FROM p_payload->'routeRef'
     OR v_decision_row.decision_snapshot->'hierarchyRef' IS DISTINCT FROM p_payload->'hierarchyRef'
     OR v_decision_row.decision_snapshot->>'decisionBundleHash' IS DISTINCT FROM p_payload->>'decisionBundleHash'
     OR v_decision_row.decision_snapshot->>'decisionBundleVersion' IS DISTINCT FROM p_payload->>'decisionBundleVersion'
     OR v_request_row.request_snapshot->>'decisionBundleHash' IS DISTINCT FROM p_payload->>'decisionBundleHash'
     OR v_request_row.request_snapshot->>'decisionBundleVersion' IS DISTINCT FROM p_payload->>'decisionBundleVersion' THEN
    RAISE EXCEPTION 'approval decision bundle is not the captured current approval' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_proposal_material';
  END IF;
  IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
     OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
     OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
     OR p_payload->>'storefrontId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'context'->>'storefrontId'
     OR p_payload->'requestRef' IS DISTINCT FROM v_request_row.request_snapshot->'requestRef'
     OR p_payload->'proposalRevisionRef' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'proposalRevisionRef'
     OR p_payload->'routeRef' IS DISTINCT FROM v_request_row.request_snapshot->'route'->'routeRef'
     OR p_payload->'hierarchyRef' IS DISTINCT FROM v_request_row.request_snapshot->'route'->'hierarchyRef' THEN
      RAISE EXCEPTION 'approval revalidation target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_revalidation_target';
  END IF;
  -- Refresh the owner-derived facts after taking the request lock so a concurrent profile or
  -- hierarchy change cannot be hidden by the initial replay lookup.
  v_request_snapshot := v_request_row.request_snapshot;
  v_profile_state := 'INACTIVE';
  v_route_current := false;
  IF v_request_snapshot->'proposal'->'identity'->'profileRef'->>'resourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT CASE WHEN cp.lifecycle = 'ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END
      INTO v_profile_state
      FROM counterparty_purchasing_profiles cpp
      JOIN customer_profiles cp
        ON cp.tenant_id = cpp.tenant_id
       AND cp.legal_entity_id = cpp.legal_entity_id
       AND cp.customer_profile_id = cpp.counterparty_purchasing_profile_id
     WHERE cpp.tenant_id = p_tenant_id
       AND cpp.legal_entity_id = p_legal_entity_id
       AND cpp.counterparty_purchasing_profile_id = (v_request_snapshot->'proposal'->'identity'->'profileRef'->>'resourceId')::uuid
       AND cpp.counterparty_resource_id = v_request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId';
  END IF;
  -- #1257 issuance eligibility linearizes after all existing owner row acquisitions.
  v_now := clock_timestamp();
  SELECT
    v_request_snapshot->>'status' = 'APPROVED'
    AND v_request_snapshot->'route'->>'status' = 'APPROVED'
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_request_snapshot->'route'->'levels') = 'array'
               THEN v_request_snapshot->'route'->'levels' ELSE '[]'::jsonb END
        ) AS levels(level)
       WHERE level->'completedBy' IS NULL
    )
    AND EXISTS (
      SELECT 1
        FROM approval_hierarchies h
       WHERE h.tenant_id = p_tenant_id
         AND h.legal_entity_id = p_legal_entity_id
         AND h.hierarchy_resource_id = v_request_snapshot->'route'->'hierarchyRef'->>'resourceId'
         AND h.revision = (v_request_snapshot->'route'->>'hierarchyRevision')::integer
         AND h.hierarchy_snapshot->>'state' = 'ACTIVE'
         AND h.effective_from <= v_now
         AND (h.effective_to IS NULL OR v_now < h.effective_to)
    )
    AND (v_request_snapshot->>'expiresAt')::timestamptz > v_now
    INTO v_route_current;
  -- #1257 checkedAt and every effective interval use the same post-lock eligibility instant.
  -- checkedAt/validUntil are owner evidence supplied by the caller, but the routine's
  -- server clock is authoritative for accepting and replaying that evidence.
  v_status := CASE WHEN v_request_row.status = 'CONSUMED' THEN 'ALREADY_CONSUMED' ELSE 'APPROVAL_VALID' END;
  v_checked_at := v_now;
  IF p_payload->>'checkedAt' IS NULL
     OR p_payload->>'validUntil' IS NULL
     OR (p_payload->>'checkedAt')::timestamptz > v_now
     OR (p_payload->>'validUntil')::timestamptz <= v_now
     OR (p_payload->>'validUntil')::timestamptz <= (p_payload->>'checkedAt')::timestamptz THEN
    RAISE EXCEPTION 'approval revalidation evidence is outside the trusted validity window' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_revalidation_expired';
  END IF;
  IF v_status = 'APPROVAL_VALID' THEN
    IF p_payload->>'buyerPermission' <> 'ALLOWED' THEN
      RAISE EXCEPTION 'approval owner confirmation is not current' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_buyer_denied';
    END IF;
    IF v_profile_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'approval owner confirmation is not current' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_profile_inactive';
    END IF;
    IF NOT v_route_current THEN
      RAISE EXCEPTION 'approval owner confirmation is not current' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_policy_route';
    END IF;
    v_valid_until := LEAST(
      v_request_row.expires_at,
      (p_payload->>'validUntil')::timestamptz,
      v_checked_at + interval '5 minutes'
    );
    IF v_request_row.status <> 'APPROVED'
       OR v_request_row.request_snapshot->'route'->>'status' <> 'APPROVED'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_request_row.request_snapshot->'route'->'levels') AS levels(level) WHERE level->'completedBy' IS NULL) THEN
      RAISE EXCEPTION 'approval request is not currently revalidatable' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_request_not_pending';
    END IF;
    IF v_checked_at >= v_request_row.expires_at THEN
      RAISE EXCEPTION 'approval request validity window has expired' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_request_expired';
    END IF;
    IF v_valid_until <= v_checked_at THEN
      RAISE EXCEPTION 'approval revalidation evidence is outside the trusted validity window' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_revalidation_expired';
    END IF;
  ELSE
    v_valid_until := v_checked_at + interval '1 minute';
  END IF;
  -- New proof issuance requires an owner-verified final binding; legacy rows are never upgraded.
  IF v_status <> 'APPROVAL_VALID'
     OR jsonb_typeof(p_payload->'finalBinding') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload->'finalBindingEvidence') IS DISTINCT FROM 'object'
     OR p_payload->'finalBindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding'
     OR p_payload->'finalBinding'->'attemptRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'finalBinding'->'bundleRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR coalesce(p_payload->'finalBinding'->'attemptRef'->>'resourceId', '') = ''
     OR coalesce(p_payload->'finalBinding'->'attemptRef'->>'moduleId', '') = ''
     OR coalesce(p_payload->'finalBinding'->'attemptRef'->>'resourceType', '') = ''
     OR coalesce(p_payload->'finalBinding'->'bundleRef'->>'resourceId', '') = ''
     OR coalesce(p_payload->'finalBinding'->'bundleRef'->>'moduleId', '') = ''
     OR coalesce(p_payload->'finalBinding'->'bundleRef'->>'resourceType', '') = ''
     OR coalesce(p_payload->'finalBinding'->>'bundleHash', '') !~ '^[a-f0-9]{64}$'
     OR coalesce(p_payload->'finalBinding'->>'bundleVersion', '') = ''
     OR coalesce(p_payload->'finalBindingEvidence'->>'provenance', '') = ''
     OR p_payload->'finalBindingEvidence'->>'observedAt' IS NULL
     OR p_payload->'finalBindingEvidence'->>'validUntil' IS NULL
     OR (p_payload->'finalBindingEvidence'->>'observedAt')::timestamptz > v_checked_at
     OR (p_payload->'finalBindingEvidence'->>'validUntil')::timestamptz <= v_checked_at
     OR coalesce(v_idempotency, '') = '' OR length(v_idempotency) > 200 THEN
    RAISE EXCEPTION 'final Bundle/Attempt authority is unavailable or not exact'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_revalidation_target';
  END IF;
  IF EXISTS (
    SELECT 1 FROM approval_revalidations prior
     WHERE prior.tenant_id = p_tenant_id AND prior.legal_entity_id = p_legal_entity_id
       AND prior.request_resource_id = v_request_id
       AND prior.evidence->>'requestRevision' = v_request_row.request_revision::text
       AND prior.evidence->'finalBindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding'
  ) THEN
    RAISE EXCEPTION 'new intent cannot replace the retained final Bundle/Attempt'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_revalidation_target';
  END IF;
  v_valid_until := LEAST(v_valid_until, (p_payload->'finalBindingEvidence'->>'validUntil')::timestamptz);
  -- Canonical JSON array framing prevents delimiter ambiguity. All 256 SHA bits are retained.
  -- Resource uniqueness detects any digest collision and aborts; it never conflates intents.
  v_ref := jsonb_build_object('moduleId','commerce.customer-context','resourceId',
    'approval-revalidation:v2:' || encode(sha256(convert_to(jsonb_build_array(
      'ccc-approval-proof.v2', p_tenant_id::text, p_legal_entity_id::text,
      v_request_id, v_request_row.request_revision, v_idempotency
    )::text, 'UTF8')), 'hex'),
    'resourceType','commerce.customer-context.approval-revalidation','tenantId',p_tenant_id);
  v_revalidation := jsonb_build_object('revalidationRef', v_ref, 'requestRef', v_request_row.request_snapshot->'requestRef', 'proposalRevisionRef', v_request_row.request_snapshot->'proposal'->'proposalRevisionRef', 'approvedRoute', v_request_row.request_snapshot->'route', 'checkedAt', v_checked_at, 'validUntil', v_valid_until, 'status', v_status, 'committedOrderRef', v_request_row.request_snapshot->'committedOrderRef', 'evidence', jsonb_build_object('proposalHash', p_payload->>'expectedProposalHash', 'decisionBundleHash', p_payload->>'decisionBundleHash', 'decisionBundleVersion', p_payload->>'decisionBundleVersion', 'decisionRef', p_payload->'decisionRef', 'hierarchyRef', p_payload->'hierarchyRef', 'routeRef', p_payload->'routeRef', 'sourceRevisions', p_payload->'sourceRevisions', 'commitmentCorrelationId', p_payload->>'commitmentCorrelationId', 'buyerPermission', p_payload->>'buyerPermission', 'profileState', v_profile_state, 'policyRouteCurrent', v_route_current));
  v_revalidation := jsonb_set(v_revalidation, '{evidence}',
    v_revalidation->'evidence' || jsonb_build_object(
      'finalBindingEvidence', p_payload->'finalBindingEvidence',
      'requestRevision', v_request_row.request_revision,
      'actorPrincipalId', p_payload->>'actorPrincipalId',
      'actionInvocationId', p_payload->>'actionInvocationId'
    ));
  INSERT INTO approval_revalidations (
    tenant_id, legal_entity_id, revalidation_resource_id, request_resource_id, proposal_revision_resource_id,
    status, proposal_hash, checked_at, valid_until, evidence, idempotency_key, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_ref->>'resourceId', v_request_id, v_revalidation->'proposalRevisionRef'->>'resourceId',
    v_status, p_payload->>'expectedProposalHash', v_checked_at, v_valid_until,
    v_revalidation->'evidence', v_idempotency, NULLIF(p_payload->>'actionInvocationId', '')::uuid,
    (p_payload->>'actorPrincipalId')::uuid, 'REVALIDATE'
  );
  -- Revalidation proves a handoff to the Order Commitment Gate.  The request is
  -- marked CONSUMED only by the Order owner after its commit is proven; a
  -- pre-commit failure must leave an otherwise-current approval reusable.
  RETURN QUERY SELECT jsonb_build_object('outcome', v_status, 'revalidation', v_revalidation);
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."consume_purchase_approval"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_request_row purchase_approval_requests%ROWTYPE;
  v_request jsonb;
  v_request_id text := p_payload->'requestRef'->>'resourceId';
  v_proposal_id text := p_payload->'proposalRevisionRef'->>'resourceId';
  v_commitment_id text := p_payload->>'commitmentCorrelationId';
  v_idempotency text := p_payload->>'idempotencyKey';
  v_order_ref jsonb := p_payload->'orderRef';
  v_consumption_evidence jsonb;
  v_proof approval_revalidations%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  IF p_payload->'requestRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
     OR p_payload->'requestRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.purchase-approval-request'
     OR p_payload->'requestRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'proposalRevisionRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
     OR p_payload->'proposalRevisionRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.purchase-proposal-revision'
     OR p_payload->'proposalRevisionRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR v_request_id IS NULL OR v_proposal_id IS NULL
     OR p_payload->'orderRef'->>'moduleId' IS DISTINCT FROM 'commerce.order'
     OR p_payload->'orderRef'->>'resourceType' IS DISTINCT FROM 'commerce.order.order'
     OR p_payload->'orderRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'orderRef'->>'resourceId' IS NULL
     OR p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
     OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
     OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'counterpartyRef'->>'resourceId' IS NULL
     OR p_payload->>'actionInvocationId' IS NULL
     OR btrim(p_payload->>'actionInvocationId') = ''
     OR p_payload->>'storefrontId' IS NULL
     OR v_commitment_id IS NULL OR btrim(v_commitment_id) = ''
     OR v_idempotency IS NULL OR btrim(v_idempotency) = ''
     OR p_payload->>'decisionBundleHash' !~ '^[a-f0-9]{64}$'
     OR p_payload->>'decisionBundleVersion' IS DISTINCT FROM 'approval-decision-bundle.v1'
     OR p_payload->>'committedAt' IS NULL THEN
    RAISE EXCEPTION 'approval commitment evidence is malformed' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_commitment_malformed';
  END IF;
  SELECT * INTO v_request_row FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request is unavailable for commitment' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_commitment_not_found';
  END IF;
  IF v_request_row.proposal_revision_resource_id IS DISTINCT FROM v_proposal_id
     OR v_request_row.request_snapshot->'proposal'->'proposalRevisionRef' IS DISTINCT FROM p_payload->'proposalRevisionRef'
     OR p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'moduleId'
     OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceType'
     OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'tenantId'
     OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
     OR p_payload->>'storefrontId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'context'->>'storefrontId'
     OR v_request_row.request_snapshot->>'decisionBundleHash' IS DISTINCT FROM p_payload->>'decisionBundleHash'
     OR v_request_row.request_snapshot->>'decisionBundleVersion' IS DISTINCT FROM p_payload->>'decisionBundleVersion' THEN
    RAISE EXCEPTION 'approval commitment does not match the captured proposal or decision bundle' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_commitment_target';
  END IF;
  v_consumption_evidence := jsonb_build_object(
    'idempotencyKey', v_idempotency,
    'commitmentCorrelationId', v_commitment_id,
    'committedAt', p_payload->>'committedAt',
    'orderRef', v_order_ref,
    'counterpartyRef', p_payload->'counterpartyRef',
    'storefrontId', p_payload->>'storefrontId',
    'decisionBundleHash', p_payload->>'decisionBundleHash',
    'decisionBundleVersion', p_payload->>'decisionBundleVersion'
  );
  IF p_payload->'revalidationRef' IS NOT NULL OR p_payload->'finalBinding' IS NOT NULL THEN
    v_consumption_evidence := v_consumption_evidence || jsonb_build_object(
      'revalidationRef', p_payload->'revalidationRef', 'finalBinding', p_payload->'finalBinding'
    );
  END IF;
  IF v_request_row.status = 'CONSUMED' THEN
    IF v_request_row.consumption_commitment_id IS DISTINCT FROM v_commitment_id
       OR v_request_row.committed_order_ref IS DISTINCT FROM v_order_ref
       OR v_request_row.request_snapshot->>'consumptionIdempotencyKey' IS DISTINCT FROM v_idempotency
       OR v_request_row.request_snapshot->>'consumedAt' IS DISTINCT FROM p_payload->>'committedAt'
       OR v_request_row.request_snapshot->'consumptionEvidence' IS DISTINCT FROM v_consumption_evidence THEN
      RAISE EXCEPTION 'approval commitment conflicts with an existing committed Order' USING ERRCODE = '23505', CONSTRAINT = 'pa_commitment_conflict';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ALREADY_CONSUMED', 'request', v_request_row.request_snapshot);
    RETURN;
  END IF;
  SELECT * INTO v_proof FROM approval_revalidations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND revalidation_resource_id = p_payload->'revalidationRef'->>'resourceId'
     AND request_resource_id = v_request_id;
  IF NOT FOUND
     OR v_proof.status <> 'APPROVAL_VALID'
     OR p_payload->'revalidationRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
     OR p_payload->'revalidationRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.approval-revalidation'
     OR p_payload->'revalidationRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR v_proof.proposal_revision_resource_id IS DISTINCT FROM v_proposal_id
     OR v_proof.proposal_hash IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->>'canonicalHash'
     OR v_proof.evidence->>'requestRevision' IS DISTINCT FROM v_request_row.request_revision::text
     OR v_proof.evidence->'finalBindingEvidence'->'binding' IS NULL
     OR v_proof.evidence->'finalBindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding'
     OR v_proof.evidence->>'commitmentCorrelationId' IS DISTINCT FROM v_commitment_id
     OR p_payload->'finalCommitmentEvidence'->'revalidationRef' IS DISTINCT FROM p_payload->'revalidationRef'
     OR p_payload->'finalCommitmentEvidence'->'orderRef' IS DISTINCT FROM v_order_ref
     OR p_payload->'finalCommitmentEvidence'->'bindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding'
     OR coalesce(p_payload->'finalCommitmentEvidence'->'bindingEvidence'->>'provenance', '') = ''
     OR p_payload->'finalCommitmentEvidence'->'bindingEvidence'->>'observedAt' IS NULL
     OR p_payload->'finalCommitmentEvidence'->'bindingEvidence'->>'validUntil' IS NULL
     OR (p_payload->'finalCommitmentEvidence'->'bindingEvidence'->>'observedAt')::timestamptz > clock_timestamp()
     OR (p_payload->'finalCommitmentEvidence'->'bindingEvidence'->>'validUntil')::timestamptz <= clock_timestamp()
     OR (p_payload->>'committedAt')::timestamptz < v_proof.checked_at
     OR (p_payload->>'committedAt')::timestamptz >= v_proof.valid_until THEN
    RAISE EXCEPTION 'committed Order does not match the exact current final proof'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_commitment_target';
  END IF;
  IF v_request_row.status <> 'APPROVED'
     OR v_request_row.request_snapshot->'route'->>'status' <> 'APPROVED'
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(v_request_row.request_snapshot->'route'->'levels') = 'array'
              THEN v_request_row.request_snapshot->'route'->'levels' ELSE '[]'::jsonb END
       ) AS levels(level)
       WHERE level->'completedBy' IS NULL
     )
     OR (p_payload->>'committedAt')::timestamptz < v_request_row.submitted_at
     OR (p_payload->>'committedAt')::timestamptz > v_request_row.expires_at
     OR (p_payload->>'committedAt')::timestamptz > now() THEN
    RAISE EXCEPTION 'approval request is not approved for commitment' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_commitment_not_approved';
  END IF;
  v_request := v_request_row.request_snapshot || jsonb_build_object(
    'status', 'CONSUMED',
    'requestRevision', v_request_row.request_revision + 1,
    'requestRevisionRef', jsonb_build_object('revision', v_request_row.request_revision + 1),
    'proposal', v_request_row.request_snapshot->'proposal' || jsonb_build_object('state', 'CONSUMED'),
    'consumedAt', p_payload->>'committedAt',
    'committedOrderRef', v_order_ref,
    'consumptionCommitmentId', v_commitment_id,
    'consumptionIdempotencyKey', v_idempotency,
    'consumptionProofRef', p_payload->'revalidationRef',
    'consumptionFinalBinding', p_payload->'finalBinding',
    'consumptionEvidence', v_consumption_evidence,
    'finalCommitmentEvidence', p_payload->'finalCommitmentEvidence'
  );
  UPDATE purchase_approval_requests
     SET request_revision = request_revision + 1,
         request_snapshot = v_request,
         status = 'CONSUMED',
         consumed_at = (p_payload->>'committedAt')::timestamptz,
         committed_order_ref = v_order_ref,
         consumption_commitment_id = v_commitment_id,
         action_invocation_id = NULLIF(p_payload->>'actionInvocationId', '')::uuid,
         actor_principal_id = (p_payload->>'actorPrincipalId')::uuid,
         reason = 'ORDER_COMMITTED'
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND request_resource_id = v_request_id AND request_revision = v_request_row.request_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval commitment CAS lost' USING ERRCODE = '40001', CONSTRAINT = 'pa_commitment_cas';
  END IF;
  UPDATE purchase_proposal_revisions
     SET state = 'CONSUMED',
         proposal_snapshot = proposal_snapshot || jsonb_build_object('state', 'CONSUMED')
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND proposal_revision_resource_id = v_proposal_id
     AND revision = (v_request_row.request_snapshot->'proposal'->>'revision')::integer
     AND state = 'CURRENT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval proposal CAS lost during commitment' USING ERRCODE = '40001', CONSTRAINT = 'pa_commitment_cas';
  END IF;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'CONSUMED', 'request', v_request);
END;
$$;

