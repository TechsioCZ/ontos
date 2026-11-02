-- Exact historical recovery uses the original unique scoped intent, never the latest proof.
-- The existing governed owner reader verifies the actual retained buyer scope before
-- a conflict may be disclosed. No expiry check renews or invalidates an immutable past result.
CREATE FUNCTION "commerce_customer_context"."recover_buyer_approval_revalidation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_proof approval_revalidations%ROWTYPE;
  v_retained jsonb;
  v_missing jsonb := jsonb_build_object('operation', 'RECOVER_REVALIDATION', 'recovery', 'NOT_FOUND');
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
     OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR p_payload->'requestRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'requestRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
     OR p_payload->'requestRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.purchase-approval-request'
     OR coalesce(p_payload->'requestRef'->>'resourceId', '') = ''
     OR p_payload->>'operation' IS DISTINCT FROM 'RECOVER_REVALIDATION'
     OR NOT pg_input_is_valid(coalesce(p_payload->>'actorPrincipalId', ''), 'uuid')
     OR coalesce(p_payload->>'idempotencyKey', '') = ''
     OR length(p_payload->>'idempotencyKey') > 200
     OR coalesce(p_payload->>'commitmentCorrelationId', '') = ''
     OR length(p_payload->>'commitmentCorrelationId') > 200 THEN
    RAISE EXCEPTION 'verified buyer approval recovery scope is invalid'
      USING ERRCODE = '42501', CONSTRAINT = 'pa_buyer_recovery_scope';
  END IF;
  SELECT * INTO v_proof FROM approval_revalidations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND idempotency_key = p_payload->>'idempotencyKey'
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_missing;
    RETURN;
  END IF;
  -- Authorize the ACTUAL retained request. An authorized caller for a different
  -- Counterparty/request must not learn that a foreign original intent exists.
  SELECT evidence.result INTO v_retained
    FROM read_order_commitment_approval_evidence(p_tenant_id, p_legal_entity_id,
      p_payload || jsonb_build_object('operation', 'LOAD_PROPOSAL', 'requestRef',
        jsonb_build_object('moduleId', 'commerce.customer-context',
          'resourceType', 'commerce.customer-context.purchase-approval-request',
          'resourceId', v_proof.request_resource_id, 'tenantId', p_tenant_id::text))) evidence;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_missing;
    RETURN;
  END IF;
  IF v_retained->'request'->'requestRef' IS DISTINCT FROM p_payload->'requestRef'
     OR v_proof.proposal_revision_resource_id IS DISTINCT FROM v_retained->'proposal'->'proposalRevisionRef'->>'resourceId'
     OR v_proof.proposal_hash IS DISTINCT FROM v_retained->'proposal'->>'canonicalHash'
     OR v_proof.actor_principal_id::text IS DISTINCT FROM p_payload->>'actorPrincipalId'
     OR v_proof.evidence->>'actorPrincipalId' IS DISTINCT FROM v_proof.actor_principal_id::text
     OR v_proof.evidence->>'commitmentCorrelationId' IS DISTINCT FROM p_payload->>'commitmentCorrelationId'
     OR v_proof.evidence->'finalBindingEvidence'->'binding' IS DISTINCT FROM p_payload->'finalBinding' THEN
    RETURN QUERY SELECT jsonb_build_object('recovery', 'CONFLICT');
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'operation', 'RECOVER_REVALIDATION', 'recovery', 'FOUND',
    'request', v_retained->'request', 'proposal', v_retained->'proposal',
    'result', jsonb_build_object('outcome', 'APPROVAL_VALID', 'revalidation', jsonb_build_object(
      'approvedRoute', v_retained->'request'->'route', 'committedOrderRef', NULL,
      'checkedAt', v_proof.checked_at, 'validUntil', v_proof.valid_until,
      'status', v_proof.status, 'evidence', v_proof.evidence,
      'proposalRevisionRef', v_retained->'proposal'->'proposalRevisionRef',
      'requestRef', v_retained->'request'->'requestRef',
      'revalidationRef', jsonb_build_object('moduleId', 'commerce.customer-context',
        'resourceType', 'commerce.customer-context.approval-revalidation',
        'resourceId', v_proof.revalidation_resource_id, 'tenantId', p_tenant_id::text)
    ))
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."recover_buyer_approval_revalidation"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."recover_buyer_approval_revalidation"(uuid, uuid, jsonb) TO ontos_runtime;
