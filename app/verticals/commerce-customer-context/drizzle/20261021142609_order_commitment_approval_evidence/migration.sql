-- This read cannot use runtime table grants: CCC deliberately exposes execute-only owner routines.
-- Return retained owner facts only; committed Order state remains the Order owner's authority.
CREATE FUNCTION "commerce_customer_context"."read_order_commitment_approval_evidence"(
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
  v_operation text := p_payload->>'operation';
  v_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR p_payload->'requestRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'requestRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
     OR p_payload->'requestRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.purchase-approval-request'
     OR coalesce(p_payload->'requestRef'->>'resourceId', '') = ''
     OR coalesce(p_payload->>'actorPrincipalId', '') = ''
     OR v_operation IS NULL OR v_operation NOT IN ('LOAD_PROPOSAL', 'VERIFY_PROOF') THEN
    RAISE EXCEPTION 'verified approval evidence scope is invalid'
      USING ERRCODE = '42501', CONSTRAINT = 'pa_order_evidence_scope';
  END IF;
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
     OR v_proposal.buyer_principal_id::text IS DISTINCT FROM p_payload->>'actorPrincipalId'
     OR v_proposal.proposal_snapshot->'identity'->'counterpartyRef' IS DISTINCT FROM p_payload->'counterpartyRef'
     OR v_proposal.storefront_id IS DISTINCT FROM p_payload->>'storefrontId'
     OR (p_payload->>'trustedStorefrontId' IS NOT NULL AND v_proposal.storefront_id IS DISTINCT FROM p_payload->>'trustedStorefrontId')
     OR v_proposal.proposal_snapshot->'context'->>'sellingLegalEntityId' IS DISTINCT FROM p_legal_entity_id::text
     OR v_proposal.canonical_hash IS DISTINCT FROM v_request.request_snapshot->'proposal'->>'canonicalHash' THEN
    RETURN;
  END IF;
  v_result := jsonb_build_object('operation', v_operation, 'request', v_request.request_snapshot, 'proposal', v_proposal.proposal_snapshot);
  IF v_operation = 'VERIFY_PROOF' THEN
    IF p_payload->'revalidationRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
       OR p_payload->'revalidationRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
       OR p_payload->'revalidationRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.approval-revalidation' THEN
      RETURN;
    END IF;
    SELECT * INTO v_proof FROM approval_revalidations
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND revalidation_resource_id = p_payload->'revalidationRef'->>'resourceId'
       AND request_resource_id = v_request.request_resource_id
       AND proposal_revision_resource_id = v_proposal.proposal_revision_resource_id
       AND proposal_hash = v_proposal.canonical_hash
       AND evidence->>'actorPrincipalId' = p_payload->>'actorPrincipalId'
       AND evidence->'finalBindingEvidence'->'binding' = p_payload->'finalBinding'
     FOR SHARE;
    IF NOT FOUND THEN RETURN; END IF;
    v_result := v_result || jsonb_build_object('proof', jsonb_build_object(
      'checkedAt', v_proof.checked_at, 'validUntil', v_proof.valid_until,
      'status', v_proof.status, 'evidence', v_proof.evidence,
      'proposalRevisionRef', v_proposal.proposal_snapshot->'proposalRevisionRef',
      'requestRef', v_request.request_snapshot->'requestRef',
      'revalidationRef', jsonb_build_object('moduleId', 'commerce.customer-context',
        'resourceType', 'commerce.customer-context.approval-revalidation',
        'resourceId', v_proof.revalidation_resource_id, 'tenantId', p_tenant_id::text)
    ));
  END IF;
  RETURN QUERY SELECT v_result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_order_commitment_approval_evidence"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_order_commitment_approval_evidence"(uuid, uuid, jsonb) TO ontos_runtime;
