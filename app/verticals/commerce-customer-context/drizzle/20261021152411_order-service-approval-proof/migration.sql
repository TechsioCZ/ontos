-- Service-only projection of retained CCC proof facts. The admitted Order principal is
-- injected by the governed reader; the original buyer/issuer is never substituted.
CREATE FUNCTION "commerce_customer_context"."read_order_service_approval_proof"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_request purchase_approval_requests%ROWTYPE;
  v_proposal purchase_proposal_revisions%ROWTYPE;
  v_proof approval_revalidations%ROWTYPE;
  v_actor_principal_id uuid;
  v_recovery boolean := coalesce(p_payload->>'operation' = 'RECOVER_REVALIDATION', false);
  v_has_proof boolean;
  v_terminal_status text;
  v_observed_at timestamptz;
  v_original_proof jsonb := NULL;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
     OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR p_payload->'requestRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'requestRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
     OR p_payload->'requestRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.purchase-approval-request'
     OR coalesce(p_payload->'requestRef'->>'resourceId', '') = ''
     OR (NOT v_recovery AND (
       p_payload->'revalidationRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
       OR p_payload->'revalidationRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
       OR p_payload->'revalidationRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.approval-revalidation'
       OR coalesce(p_payload->'revalidationRef'->>'resourceId', '') = ''))
     OR (v_recovery AND (coalesce(p_payload->>'idempotencyKey', '') = ''
       OR length(p_payload->>'idempotencyKey') > 200
       OR coalesce(p_payload->>'commitmentCorrelationId', '') = ''
       OR length(p_payload->>'commitmentCorrelationId') > 200
       OR p_payload->'candidateRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
       OR p_payload->'candidateRef'->>'moduleId' IS DISTINCT FROM 'commerce.cart'
       OR p_payload->'candidateRef'->>'resourceType' IS DISTINCT FROM 'commerce.cart.final-cart-candidate'
       OR coalesce(p_payload->'candidateRef'->>'resourceId', '') = ''
       OR coalesce(p_payload->>'candidateHash', '') !~ '^[a-f0-9]{64}$'))
     OR NOT pg_input_is_valid(coalesce(p_payload->>'actorPrincipalId', ''), 'uuid')
     OR p_payload->'finalBinding'->'attemptRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'finalBinding'->'attemptRef'->>'moduleId' IS DISTINCT FROM 'commerce.order'
     OR p_payload->'finalBinding'->'attemptRef'->>'resourceType' IS DISTINCT FROM 'commerce.order.commitment-attempt'
     OR coalesce(p_payload->'finalBinding'->'attemptRef'->>'resourceId', '') = ''
     OR p_payload->'finalBinding'->'bundleRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'finalBinding'->'bundleRef'->>'moduleId' IS DISTINCT FROM 'commerce.order'
     OR p_payload->'finalBinding'->'bundleRef'->>'resourceType' IS DISTINCT FROM 'commerce.order.acceptance-bundle'
     OR coalesce(p_payload->'finalBinding'->'bundleRef'->>'resourceId', '') = ''
     OR coalesce(p_payload->'finalBinding'->>'bundleHash', '') !~ '^[a-f0-9]{64}$'
     OR coalesce(p_payload->'finalBinding'->>'bundleVersion', '') = '' THEN
    RAISE EXCEPTION 'verified Order service proof scope is invalid'
      USING ERRCODE = '42501', CONSTRAINT = 'pa_order_service_proof_scope';
  END IF;
  v_actor_principal_id := (p_payload->>'actorPrincipalId')::uuid;
  SELECT * INTO v_request FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND request_resource_id = p_payload->'requestRef'->>'resourceId'
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_proposal FROM purchase_proposal_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND proposal_revision_resource_id = v_request.proposal_revision_resource_id
     AND revision = (v_request.request_snapshot->'proposal'->>'revision')::integer
   FOR SHARE;
  IF NOT FOUND
     OR v_proposal.proposal_snapshot->'context'->>'sellingLegalEntityId' IS DISTINCT FROM p_legal_entity_id::text
     OR v_proposal.canonical_hash IS DISTINCT FROM v_request.request_snapshot->'proposal'->>'canonicalHash' THEN
    RETURN;
  END IF;
  IF v_recovery THEN
    -- This unique original intent is selected first. A mismatching retained intent
    -- is an explicit conflict, never absence permitting a replacement proof.
    SELECT * INTO v_proof FROM approval_revalidations
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND idempotency_key = p_payload->>'idempotencyKey'
     FOR SHARE;
    v_has_proof := FOUND;
    IF v_has_proof AND (v_proof.request_resource_id IS DISTINCT FROM v_request.request_resource_id
       OR v_proof.proposal_revision_resource_id IS DISTINCT FROM v_proposal.proposal_revision_resource_id
       OR v_proof.proposal_hash IS DISTINCT FROM v_proposal.canonical_hash
       OR v_proof.actor_principal_id IS DISTINCT FROM v_actor_principal_id
       OR v_proof.evidence->>'actorPrincipalId' IS DISTINCT FROM v_actor_principal_id::text
       OR v_proof.evidence->>'commitmentCorrelationId' IS DISTINCT FROM p_payload->>'commitmentCorrelationId'
       OR v_proof.evidence->'finalBindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding') THEN
      RETURN QUERY SELECT jsonb_build_object('recovery', 'CONFLICT');
      RETURN;
    END IF;
    IF v_has_proof THEN
      v_original_proof := jsonb_build_object(
        'checkedAt', v_proof.checked_at, 'validUntil', v_proof.valid_until,
        'status', v_proof.status, 'evidence', v_proof.evidence,
        'proposalRevisionRef', v_proposal.proposal_snapshot->'proposalRevisionRef',
        'requestRef', v_request.request_snapshot->'requestRef',
        'revalidationRef', jsonb_build_object('moduleId', 'commerce.customer-context',
          'resourceType', 'commerce.customer-context.approval-revalidation',
          'resourceId', v_proof.revalidation_resource_id, 'tenantId', p_tenant_id::text)
      );
    END IF;
    -- A terminal request is an owner lifecycle fact, not a network timeout and
    -- not an assertion about another owner's Order. Read time follows both locks.
    v_observed_at := clock_timestamp();
    v_terminal_status := CASE
      WHEN v_request.status IN ('CANCELLED', 'EXPIRED', 'SUPERSEDED', 'REJECTED', 'RETURNED') THEN v_request.status
      WHEN v_request.status = 'APPROVED' AND (v_request.request_snapshot->>'expiresAt')::timestamptz <= v_observed_at THEN 'EXPIRED'
      ELSE NULL END;
    IF v_terminal_status IS NOT NULL THEN
      RETURN QUERY SELECT jsonb_build_object('recovery', 'REQUEST_TERMINAL', 'witness', jsonb_build_object(
        'requestRef', v_request.request_snapshot->'requestRef',
        'idempotencyKey', p_payload->>'idempotencyKey',
        'commitmentCorrelationId', p_payload->>'commitmentCorrelationId',
        'finalBinding', p_payload->'finalBinding',
        'candidateRef', p_payload->'candidateRef', 'candidateHash', p_payload->>'candidateHash',
        'terminalStatus', v_terminal_status, 'request', v_request.request_snapshot,
        'originalProof', v_original_proof, 'observedAt', v_observed_at
      ));
      RETURN;
    END IF;
    IF NOT v_has_proof THEN
      RETURN QUERY SELECT jsonb_build_object('recovery', 'NOT_FOUND');
      RETURN;
    END IF;
    IF v_proof.status IS DISTINCT FROM 'APPROVAL_VALID'
       -- The owner request revision is the version of the entire retained route
       -- snapshot: decision and reroute writers increment it atomically. Recovery
       -- never substitutes an equally-named route from a later request revision.
       OR v_proof.evidence->>'requestRevision' IS DISTINCT FROM v_request.request_revision::text
       OR v_proof.evidence->>'requestRevision' IS DISTINCT FROM v_request.request_snapshot->>'requestRevision'
       OR v_request.request_snapshot->'route'->'routeRef'->>'resourceId' IS DISTINCT FROM v_request.route_resource_id
       OR v_request.request_snapshot->>'status' IS DISTINCT FROM 'APPROVED'
       OR v_proof.evidence->'routeRef' IS DISTINCT FROM v_request.request_snapshot->'route'->'routeRef'
       OR v_proof.evidence->'hierarchyRef' IS DISTINCT FROM v_request.request_snapshot->'route'->'hierarchyRef'
       OR v_proof.evidence->'decisionRef' IS DISTINCT FROM v_request.request_snapshot->'lastDecisionRef'
       OR v_request.request_snapshot->'route'->>'status' IS DISTINCT FROM 'APPROVED'
       OR v_proof.evidence->>'decisionBundleHash' IS DISTINCT FROM v_request.request_snapshot->>'decisionBundleHash'
       OR v_proof.evidence->>'decisionBundleVersion' IS DISTINCT FROM v_request.request_snapshot->>'decisionBundleVersion' THEN
      RETURN QUERY SELECT jsonb_build_object('recovery', 'CONFLICT');
      RETURN;
    END IF;
    -- Retain the exact originally-issued proof. Expiry is not renewal and a
    -- successful historical read never makes the proof currently usable.
    RETURN QUERY SELECT jsonb_build_object('recovery', 'FOUND', 'result', jsonb_build_object(
      'outcome', 'APPROVAL_VALID', 'revalidation', jsonb_build_object(
        'approvedRoute', v_request.request_snapshot->'route',
        'committedOrderRef', NULL,
        'checkedAt', v_proof.checked_at, 'validUntil', v_proof.valid_until,
        'status', v_proof.status, 'evidence', v_proof.evidence,
        'proposalRevisionRef', v_proposal.proposal_snapshot->'proposalRevisionRef',
        'requestRef', v_request.request_snapshot->'requestRef',
        'revalidationRef', jsonb_build_object('moduleId', 'commerce.customer-context',
          'resourceType', 'commerce.customer-context.approval-revalidation',
          'resourceId', v_proof.revalidation_resource_id, 'tenantId', p_tenant_id::text)
      )
    ));
    RETURN;
  END IF;
  SELECT * INTO v_proof FROM approval_revalidations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND revalidation_resource_id = p_payload->'revalidationRef'->>'resourceId'
     AND request_resource_id = v_request.request_resource_id
     AND proposal_revision_resource_id = v_proposal.proposal_revision_resource_id
     AND proposal_hash = v_proposal.canonical_hash
     AND actor_principal_id IN (v_actor_principal_id, v_proposal.buyer_principal_id)
     AND evidence->>'actorPrincipalId' = actor_principal_id::text
     AND evidence->'finalBindingEvidence'->'binding' = p_payload->'finalBinding'
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'request', v_request.request_snapshot,
    'proposal', v_proposal.proposal_snapshot,
    'proofActorPrincipalId', v_proof.actor_principal_id::text,
    'proof', jsonb_build_object(
      'checkedAt', v_proof.checked_at, 'validUntil', v_proof.valid_until,
      'status', v_proof.status, 'evidence', v_proof.evidence,
      'proposalRevisionRef', v_proposal.proposal_snapshot->'proposalRevisionRef',
      'requestRef', v_request.request_snapshot->'requestRef',
      'revalidationRef', jsonb_build_object('moduleId', 'commerce.customer-context',
        'resourceType', 'commerce.customer-context.approval-revalidation',
        'resourceId', v_proof.revalidation_resource_id, 'tenantId', p_tenant_id::text)
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_order_service_approval_proof"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_order_service_approval_proof"(uuid, uuid, jsonb) TO ontos_runtime;
