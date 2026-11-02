-- New Decision eligibility uses the trusted post-serialization instant.
-- Exact committed replay and existing operation/audit clocks remain unchanged.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."decide_purchase_approval_request"(
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
  v_prior approval_decisions%ROWTYPE;
  v_route jsonb;
  v_proposal jsonb;
  v_levels jsonb;
  v_next integer;
  v_current_level integer;
  v_status text;
  v_decision_ref jsonb;
  v_decision jsonb;
  v_decision_bundle_hash text;
  v_next_request jsonb;
  v_kind text := p_payload->>'decision';
  v_request_id text := p_payload->'requestRef'->>'resourceId';
  v_idempotency text := p_payload->>'idempotencyKey';
  v_operation_at timestamptz := now();
  v_eligibility_at timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  IF v_kind IN ('RETURN', 'REJECT') AND NULLIF(btrim(p_payload->>'reason'), '') IS NULL THEN
    RAISE EXCEPTION 'return and reject decisions require a non-empty reason' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_decision_reason_required';
  END IF;
  SELECT * INTO v_prior FROM approval_decisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency;
  IF FOUND THEN
    IF v_prior.request_resource_id IS DISTINCT FROM v_request_id
       OR v_prior.proposal_revision_resource_id IS DISTINCT FROM p_payload->'proposalRevisionRef'->>'resourceId'
       OR v_prior.decision IS DISTINCT FROM p_payload->>'decision'
       OR v_prior.decision_snapshot->'actor' IS DISTINCT FROM p_payload->'actor'
       OR v_prior.decision_snapshot->>'reason' IS DISTINCT FROM p_payload->>'reason' THEN
      RAISE EXCEPTION 'approval decision idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_decision_idem';
    END IF;
    SELECT request_snapshot INTO v_next_request FROM purchase_approval_requests
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_prior.request_resource_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval decision request snapshot is unavailable' USING ERRCODE = '40001', CONSTRAINT = 'pa_request_snapshot_missing';
    END IF;
    IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM v_next_request->'proposal'->'identity'->'counterpartyRef'->>'moduleId'
       OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM v_next_request->'proposal'->'identity'->'counterpartyRef'->>'resourceType'
       OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM v_next_request->'proposal'->'identity'->'counterpartyRef'->>'tenantId'
       OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_next_request->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
       OR p_payload->>'storefrontId' IS DISTINCT FROM v_next_request->'proposal'->'context'->>'storefrontId' THEN
      RAISE EXCEPTION 'approval decision target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_target_mismatch';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ALREADY_RECORDED', 'decision', v_prior.decision_snapshot, 'request', v_next_request);
    RETURN;
  END IF;
  IF v_kind NOT IN ('APPROVE', 'RETURN', 'REJECT')
     OR p_payload->'actor'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'actor'->>'principalId' IS DISTINCT FROM p_payload->>'actorPrincipalId' THEN
    RAISE EXCEPTION 'approval decision actor or kind is invalid' USING ERRCODE = '42501', CONSTRAINT = 'pa_decision_actor';
  END IF;
  SELECT * INTO v_request_row FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval request is unavailable' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_request_not_pending'; END IF;
  -- Expiry linearizes after the request lock, including any earlier Core tenant-lock wait.
  -- Operation/audit timestamps retain their separate immutable transaction-time semantics.
  v_eligibility_at := clock_timestamp();
  IF v_request_row.request_revision <> (p_payload->>'expectedRequestRevision')::integer
     OR v_request_row.proposal_revision_resource_id <> (p_payload->'proposalRevisionRef'->>'resourceId')
     OR v_request_row.request_snapshot->'proposal'->'proposalRevisionRef' IS DISTINCT FROM p_payload->'proposalRevisionRef'
     OR v_request_row.status <> 'PENDING'
     OR (v_request_row.request_snapshot->'route'->>'status') <> 'PENDING'
     OR v_eligibility_at >= v_request_row.expires_at THEN
    RAISE EXCEPTION 'approval request CAS or currentness check failed' USING ERRCODE = '40001', CONSTRAINT = 'pa_request_cas';
  END IF;
  v_route := v_request_row.request_snapshot->'route';
  v_proposal := v_request_row.request_snapshot->'proposal';
  IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
     OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
     OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_proposal->'identity'->'counterpartyRef'->>'resourceId'
     OR p_payload->>'storefrontId' IS DISTINCT FROM v_proposal->'context'->>'storefrontId' THEN
    RAISE EXCEPTION 'approval decision target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_target_mismatch';
  END IF;
  v_current_level := (v_route->>'currentLevelOrder')::integer;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_route->'levels') AS levels(level)
    CROSS JOIN jsonb_array_elements(level->'candidates') AS candidates(candidate)
      WHERE (level->>'order')::integer = v_current_level
      AND candidate->>'principalId' = p_payload->'actor'->>'principalId'
      AND candidate->>'tenantId' = p_payload->'actor'->>'tenantId'
  ) THEN RAISE EXCEPTION 'approval actor is not eligible for the current route level' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_not_route_eligible'; END IF;
  IF EXISTS (
    SELECT 1 FROM approval_hierarchies h
    WHERE h.tenant_id = p_tenant_id AND h.legal_entity_id = p_legal_entity_id
      AND h.hierarchy_resource_id = v_route->'hierarchyRef'->>'resourceId'
      AND h.revision = (v_route->>'hierarchyRevision')::integer
      AND h.self_approval_policy = 'DENY'
      AND v_proposal->'identity'->'buyer'->>'principalId' = p_payload->'actor'->>'principalId'
      AND v_proposal->'identity'->'buyer'->>'tenantId' = p_payload->'actor'->>'tenantId'
  ) THEN RAISE EXCEPTION 'self approval is denied' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_self_approval'; END IF;
  v_status := CASE WHEN v_kind = 'RETURN' THEN 'RETURNED' WHEN v_kind = 'REJECT' THEN 'REJECTED' ELSE 'PENDING' END;
  IF v_kind = 'APPROVE' THEN
    SELECT min((level->>'order')::integer) INTO v_next FROM jsonb_array_elements(v_route->'levels') AS levels(level)
      WHERE (level->>'order')::integer > v_current_level AND level->>'completedBy' IS NULL;
    SELECT jsonb_agg(
      CASE WHEN (level->>'order')::integer = v_current_level
        THEN level || jsonb_build_object('completedBy', p_payload->'actor', 'completedAt', v_operation_at)
        ELSE level END ORDER BY (level->>'order')::integer
    ) INTO v_levels FROM jsonb_array_elements(v_route->'levels') AS levels(level);
    v_status := CASE WHEN v_next IS NULL THEN 'APPROVED' ELSE 'PENDING' END;
    v_route := v_route || jsonb_build_object('levels', v_levels, 'currentLevelOrder', COALESCE(v_next, (v_route->>'currentLevelOrder')::integer), 'status', v_status);
  END IF;
  v_decision_ref := jsonb_build_object('moduleId', 'commerce.customer-context', 'resourceId', 'approval-decision:' || v_request_id || ':' || (v_request_row.request_revision + 1), 'resourceType', 'commerce.customer-context.approval-decision', 'tenantId', p_tenant_id);
  v_decision_bundle_hash := encode(sha256(convert_to(jsonb_build_object(
    'requestRef', v_request_row.request_snapshot->'requestRef',
    'proposalRevisionRef', v_proposal->'proposalRevisionRef',
    'hierarchyRef', v_route->'hierarchyRef',
    'hierarchyRevision', v_route->>'hierarchyRevision',
    'routeRef', v_route->'routeRef',
    'route', v_route,
    'decisionRef', v_decision_ref,
    'requestRevision', v_request_row.request_revision + 1
  )::text, 'UTF8')), 'hex');
  v_decision := jsonb_build_object('decisionRef', v_decision_ref, 'requestRef', v_request_row.request_snapshot->'requestRef', 'proposalRevisionRef', v_proposal->'proposalRevisionRef', 'actor', p_payload->'actor', 'kind', v_kind, 'levelOrder', v_current_level, 'reason', p_payload->'reason', 'recordedAt', v_operation_at, 'requestRevision', v_request_row.request_revision + 1, 'routeRef', v_route->'routeRef', 'hierarchyRef', v_route->'hierarchyRef', 'hierarchyRevision', (v_route->>'hierarchyRevision')::integer, 'decisionBundleHash', v_decision_bundle_hash, 'decisionBundleVersion', 'approval-decision-bundle.v1', 'idempotencyKey', v_idempotency);
  v_next_request := v_request_row.request_snapshot || jsonb_build_object('route', v_route, 'status', v_status, 'requestRevision', v_request_row.request_revision + 1, 'lastDecisionRef', v_decision_ref, 'decisionBundleHash', v_decision_bundle_hash, 'decisionBundleVersion', 'approval-decision-bundle.v1');
  IF v_kind IN ('RETURN', 'REJECT') THEN
    -- A returned or rejected request closes the immutable proposal lineage.
    -- The next attempt must create a new proposal revision; leaving the
    -- proposal CURRENT would let the deterministic request id be submitted
    -- again after its terminal request status no longer participates in the
    -- active-request uniqueness index.
    v_next_request := v_next_request || jsonb_build_object(
      'proposal', v_proposal || jsonb_build_object('state', 'SUPERSEDED'),
      'requiresNewProposal', true
    );
    UPDATE purchase_proposal_revisions
       SET state = 'SUPERSEDED',
           proposal_snapshot = proposal_snapshot || jsonb_build_object('state', 'SUPERSEDED')
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND proposal_revision_resource_id = v_proposal->'proposalRevisionRef'->>'resourceId'
       AND revision = (v_proposal->>'revision')::integer
       AND state = 'CURRENT';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval proposal lineage changed before terminal decision' USING ERRCODE = '40001', CONSTRAINT = 'pa_proposal_material';
    END IF;
  END IF;
  UPDATE purchase_approval_requests SET request_revision = request_revision + 1, request_snapshot = v_next_request, status = v_status, last_decision_resource_id = v_decision_ref->>'resourceId'
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id AND request_revision = (p_payload->>'expectedRequestRevision')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval request CAS lost' USING ERRCODE = '40001', CONSTRAINT = 'pa_request_cas'; END IF;
  INSERT INTO approval_decisions (
    tenant_id, legal_entity_id, decision_resource_id, request_resource_id, proposal_revision_resource_id,
    decision, level_order, reason, request_revision, idempotency_key, decision_snapshot,
    action_invocation_id, actor_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_decision_ref->>'resourceId', v_request_id, v_proposal->'proposalRevisionRef'->>'resourceId',
    v_kind, (v_decision->>'levelOrder')::integer, NULLIF(p_payload->>'reason', ''), v_request_row.request_revision + 1, v_idempotency,
    v_decision, NULLIF(p_payload->>'actionInvocationId', '')::uuid, (p_payload->'actor'->>'principalId')::uuid
  );
  RETURN QUERY SELECT jsonb_build_object('outcome', 'DECISION_RECORDED', 'decision', v_decision, 'request', v_next_request);
END;
$$;
