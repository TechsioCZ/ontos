-- Purchasing Approval is an owner-owned, transaction-bound aggregate.  The application may only
-- call these routines through Core's scoped-routine allowlist; raw table grants remain revoked.

ALTER TABLE "commerce_customer_context"."purchase_approval_requests"
  ADD COLUMN IF NOT EXISTS "committed_order_ref" jsonb,
  ADD COLUMN IF NOT EXISTS "consumption_commitment_id" text;
ALTER TABLE "commerce_customer_context"."purchase_approval_requests"
  DROP CONSTRAINT IF EXISTS "ccc_approval_requests_consumed_ck";
ALTER TABLE "commerce_customer_context"."purchase_approval_requests"
  ADD CONSTRAINT "ccc_approval_requests_consumed_ck"
  CHECK (("status" = 'CONSUMED' and "consumed_at" is not null and "committed_order_ref" is not null and "consumption_commitment_id" is not null) or ("status" <> 'CONSUMED' and "consumed_at" is null and "committed_order_ref" is null and "consumption_commitment_id" is null));
CREATE UNIQUE INDEX IF NOT EXISTS "ccc_approval_requests_active_proposal_uk"
  ON "commerce_customer_context"."purchase_approval_requests"
  (tenant_id, legal_entity_id, proposal_revision_resource_id)
  WHERE status IN ('PENDING', 'APPROVED');

-- Currentness reads the owner-held immutable proposal snapshot in the same
-- scoped transaction as evaluation.  Callers cannot supply a proposal body or
-- source vector to this routine; only the stable proposal resource id is an
-- input and the CURRENT row is authoritative.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_current_purchase_proposal_revision"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_proposal purchase_proposal_revisions%ROWTYPE;
  v_resource_id text := p_payload->>'proposalRevisionResourceId';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR v_resource_id IS NULL OR btrim(v_resource_id) = '' THEN
    RAISE EXCEPTION 'verified operation scope or proposal reference is invalid'
      USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  SELECT * INTO v_proposal
    FROM purchase_proposal_revisions
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND proposal_revision_resource_id = v_resource_id
     AND state = 'CURRENT'
   FOR SHARE;
  IF NOT FOUND OR v_proposal.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'current purchase proposal revision is unavailable'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_currentness_not_found';
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'proposal', v_proposal.proposal_snapshot,
    'sourceRevisions', v_proposal.source_revision_vector
  );
END;
$$;

-- Revalidation currentness is read from every owner snapshot participating in the approval.  The
-- Action may provide only the stable request identity; proposal, route, decision, and source
-- facts are selected under the same scoped transaction and are never copied from caller claims.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_current_purchase_approval_revalidation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_request_row purchase_approval_requests%ROWTYPE;
  v_proposal_row purchase_proposal_revisions%ROWTYPE;
  v_route_row approval_routes%ROWTYPE;
  v_decision_row approval_decisions%ROWTYPE;
  v_request_id text := p_payload->'requestRef'->>'resourceId';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR v_request_id IS NULL OR btrim(v_request_id) = '' THEN
    RAISE EXCEPTION 'verified operation scope or approval request reference is invalid'
      USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;

  SELECT * INTO v_request_row
    FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND request_resource_id = v_request_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current approval request is unavailable'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_currentness_not_found';
  END IF;

  SELECT * INTO v_proposal_row
    FROM purchase_proposal_revisions
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND proposal_revision_resource_id = v_request_row.proposal_revision_resource_id
     AND revision = (v_request_row.request_snapshot->'proposal'->>'revision')::integer
     AND state IN ('CURRENT', 'CONSUMED')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'captured purchase proposal is unavailable'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_currentness_not_found';
  END IF;

  SELECT * INTO v_route_row
    FROM approval_routes
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND route_resource_id = v_request_row.route_resource_id
     AND request_resource_id = v_request_row.request_resource_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current approval route is unavailable'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_currentness_not_found';
  END IF;

  IF v_request_row.last_decision_resource_id IS NULL THEN
    RAISE EXCEPTION 'current approval decision is unavailable'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_currentness_not_found';
  END IF;
  SELECT * INTO v_decision_row
    FROM approval_decisions
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND decision_resource_id = v_request_row.last_decision_resource_id
     AND request_resource_id = v_request_row.request_resource_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current approval decision is unavailable'
      USING ERRCODE = 'P0001', CONSTRAINT = 'pa_currentness_not_found';
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    'request', v_request_row.request_snapshot,
    'proposal', v_proposal_row.proposal_snapshot,
    'route', v_route_row.route_snapshot,
    'decision', v_decision_row.decision_snapshot,
    'sourceRevisions', v_proposal_row.source_revision_vector
  );
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."create_purchase_proposal_revision"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_proposal jsonb := p_payload->'proposal';
  v_existing jsonb;
  v_idempotency text := p_payload->>'idempotencyKey';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  SELECT proposal_snapshot INTO v_existing
    FROM purchase_proposal_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency
   FOR SHARE;
  IF FOUND THEN
    IF v_existing IS DISTINCT FROM v_proposal THEN
      RAISE EXCEPTION 'approval proposal idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_proposal_idem';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ALREADY_EXISTS', 'proposal', v_existing);
    RETURN;
  END IF;

  IF jsonb_typeof(v_proposal) <> 'object'
     OR v_proposal->>'canonicalHash' !~ '^[a-f0-9]{64}$'
     OR v_proposal->>'state' <> 'CURRENT'
     OR v_proposal->>'approvalEvaluation' <> 'APPROVAL_REQUIRED'
     OR v_proposal->'proposalRevisionRef'->>'tenantId' <> p_tenant_id::text
     OR v_proposal->'context'->>'tenantId' <> p_tenant_id::text
     OR v_proposal->'context'->>'sellingLegalEntityId' <> p_legal_entity_id::text
     OR v_proposal->'identity'->'buyer'->>'tenantId' <> p_tenant_id::text
     OR v_proposal->'identity'->'buyer'->>'principalId' <> p_payload->>'actorPrincipalId'
     OR v_proposal->'identity'->'counterpartyRef'->>'moduleId' <> 'party.registry'
     OR v_proposal->'identity'->'counterpartyRef'->>'resourceType' <> 'party.registry.counterparty'
     OR v_proposal->'identity'->'counterpartyRef'->>'tenantId' <> p_tenant_id::text
     OR v_proposal->'identity'->'profileRef'->>'tenantId' <> p_tenant_id::text
     OR v_proposal->'sourceCart'->'cartRef'->>'moduleId' <> 'commerce.cart'
     OR v_proposal->'sourceCart'->'cartRef'->>'resourceType' <> 'commerce.cart.cart'
     OR v_proposal->'sourceCart'->'cartRef'->>'tenantId' <> p_tenant_id::text
     OR btrim(coalesce(v_proposal->'sourceCart'->>'revision', '')) = ''
     OR v_proposal->'hierarchyInputs'->>'storefrontId' <> v_proposal->'context'->>'storefrontId'
     OR v_proposal->'hierarchyInputs'->'counterpartyRef' IS DISTINCT FROM v_proposal->'identity'->'counterpartyRef'
     OR v_proposal->'hierarchyInputs'->'purchaseValue'->>'amount' IS DISTINCT FROM v_proposal->'purchaseValue'->'monetaryAmount'->>'amount'
     OR v_proposal->'hierarchyInputs'->'purchaseValue'->>'currency' IS DISTINCT FROM v_proposal->'purchaseValue'->'monetaryAmount'->>'currency'
     OR (p_payload->'verifiedEvidence'->>'buyerPermission') <> 'ALLOWED'
     OR (p_payload->'verifiedEvidence'->>'profileState') <> 'ACTIVE'
     OR (p_payload->'verifiedEvidence'->>'proposalCurrent') <> 'true'
     OR jsonb_typeof(p_payload->'verifiedEvidence'->'sourceRevisions') <> 'array'
     OR (SELECT count(*) FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source)
         WHERE source->>'source' = 'purchase-proposal') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source)
         WHERE source->>'source' = 'purchasing-profile') <> 1
     OR (SELECT count(DISTINCT source->>'source') FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source)) < 6
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source) WHERE source->>'source' = 'counterparty-policy')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source) WHERE source->>'source' = 'customer-commerce-policy')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source) WHERE source->>'source' = 'principal-override')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source) WHERE source->>'source' = 'storefront-context')
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source)
       WHERE source->>'source' = 'purchase-proposal'
         AND source->>'revision' = v_proposal->'purchaseValue'->>'sourceRevision'
     )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_payload->'verifiedEvidence'->'sourceRevisions') AS sources(source)
       WHERE source->>'source' = 'purchasing-profile'
     )
     OR (v_proposal->>'expiresAt')::timestamptz <= now() THEN
    RAISE EXCEPTION 'approval proposal evidence is not current' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_proposal_not_current';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM purchase_proposal_revisions
    WHERE tenant_id = p_tenant_id
      AND legal_entity_id = p_legal_entity_id
      AND proposal_revision_resource_id = v_proposal->'proposalRevisionRef'->>'resourceId'
      AND state = 'CURRENT'
  ) THEN
    RAISE EXCEPTION 'approval proposal lineage already has a current revision' USING ERRCODE = '23505', CONSTRAINT = 'pa_proposal_lineage';
  END IF;

  INSERT INTO purchase_proposal_revisions (
    tenant_id, legal_entity_id, proposal_revision_resource_id, revision, idempotency_key,
    proposal_sequence, buyer_principal_id, counterparty_resource_ref, profile_resource_ref,
    storefront_id, proposal_snapshot, source_revision_vector, canonicalization_version,
    canonical_hash, state, approval_evaluation, expires_at, action_invocation_id,
    actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_proposal->'proposalRevisionRef'->>'resourceId',
    (v_proposal->>'revision')::integer, v_idempotency, (v_proposal->>'proposalSequence')::integer,
    (v_proposal->'identity'->'buyer'->>'principalId')::uuid,
    v_proposal->'identity'->'counterpartyRef'->>'resourceId',
    v_proposal->'identity'->'profileRef'->>'resourceId', v_proposal->'context'->>'storefrontId',
    v_proposal, p_payload->'verifiedEvidence'->'sourceRevisions',
    v_proposal->>'canonicalizationVersion', v_proposal->>'canonicalHash', v_proposal->>'state',
    v_proposal->>'approvalEvaluation', (v_proposal->>'expiresAt')::timestamptz,
    NULLIF(p_payload->>'actionInvocationId', '')::uuid,
    (p_payload->>'actorPrincipalId')::uuid, NULLIF(p_payload->>'reason', '')
  );
  RETURN QUERY SELECT jsonb_build_object('outcome', 'CREATED', 'proposal', v_proposal);
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."create_approval_hierarchy"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_hierarchy jsonb := p_payload->'hierarchy';
  v_existing jsonb;
  v_idempotency text := p_payload->>'idempotencyKey';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  SELECT hierarchy_snapshot INTO v_existing
    FROM approval_hierarchies
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency
   FOR SHARE;
  IF FOUND THEN
    IF v_existing IS DISTINCT FROM v_hierarchy THEN
      RAISE EXCEPTION 'approval hierarchy idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_hierarchy_idem';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ALREADY_EXISTS', 'hierarchy', v_existing);
    RETURN;
  END IF;
  IF jsonb_typeof(v_hierarchy) <> 'object'
     OR jsonb_typeof(v_hierarchy->'levels') <> 'array'
     OR COALESCE(jsonb_array_length(v_hierarchy->'levels'), 0) < 1
     OR v_hierarchy->'hierarchyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR v_hierarchy->'selector'->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR v_hierarchy->'selector'->'counterpartyRef'->>'moduleId' <> 'party.registry'
     OR v_hierarchy->'selector'->'counterpartyRef'->>'resourceType' <> 'party.registry.counterparty'
     OR v_hierarchy->'selector'->'counterpartyRef'->>'resourceId' IS NULL
     OR v_hierarchy->'ownerPrincipal'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR v_hierarchy->>'state' <> 'ACTIVE'
     OR v_hierarchy->'selector'->'minimumPurchaseValue'->>'amount' IS NULL
     OR v_hierarchy->'selector'->'minimumPurchaseValue'->>'currency' IS NULL
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_hierarchy->'levels') AS levels(level)
       WHERE jsonb_typeof(level->'eligiblePrincipals') <> 'array'
          OR level->>'completionRule' IS DISTINCT FROM 'ONE_APPROVER'
          OR jsonb_array_length(CASE WHEN jsonb_typeof(level->'eligiblePrincipals') = 'array'
                                     THEN level->'eligiblePrincipals' ELSE '[]'::jsonb END) = 0
          OR (level->>'order') !~ '^[1-9][0-9]*$'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(level->'eligiblePrincipals') = 'array'
                   THEN level->'eligiblePrincipals' ELSE '[]'::jsonb END
            ) AS principals(principal)
            WHERE principal->>'tenantId' IS DISTINCT FROM p_tenant_id::text
          )
     )
     OR EXISTS (
       SELECT 1
       FROM generate_series(1, jsonb_array_length(v_hierarchy->'levels')) AS expected(order_no)
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(v_hierarchy->'levels') AS levels(level)
         WHERE CASE WHEN level->>'order' ~ '^[1-9][0-9]*$'
                    THEN (level->>'order')::integer ELSE -1 END = expected.order_no
       )
     )
     OR (
       SELECT count(DISTINCT level->>'order')
       FROM jsonb_array_elements(v_hierarchy->'levels') AS levels(level)
     ) <> jsonb_array_length(v_hierarchy->'levels') THEN
    RAISE EXCEPTION 'approval hierarchy has no ordered levels' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_hierarchy_invalid';
  END IF;
  INSERT INTO approval_hierarchies (
    tenant_id, legal_entity_id, hierarchy_resource_id, revision, idempotency_key,
    counterparty_resource_ref, storefront_id, minimum_amount, minimum_currency_code,
    maximum_amount, maximum_currency_code, hierarchy_snapshot, self_approval_policy,
    effective_from, effective_to, owner_principal_id, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_hierarchy->'hierarchyRef'->>'resourceId',
    (v_hierarchy->>'revision')::integer, v_idempotency,
    v_hierarchy->'selector'->'counterpartyRef'->>'resourceId',
    NULLIF(v_hierarchy->'selector'->>'storefrontId', ''),
    (v_hierarchy->'selector'->'minimumPurchaseValue'->>'amount')::numeric,
    v_hierarchy->'selector'->'minimumPurchaseValue'->>'currency',
    NULLIF(v_hierarchy->'selector'->'maximumPurchaseValue'->>'amount', '')::numeric,
    NULLIF(v_hierarchy->'selector'->'maximumPurchaseValue'->>'currency', ''),
    v_hierarchy, v_hierarchy->>'selfApprovalPolicy', (v_hierarchy->>'effectiveFrom')::timestamptz,
    NULLIF(v_hierarchy->>'effectiveTo', '')::timestamptz,
    (v_hierarchy->'ownerPrincipal'->>'principalId')::uuid,
    NULLIF(p_payload->>'actionInvocationId', '')::uuid,
    (p_payload->>'actorPrincipalId')::uuid, NULLIF(v_hierarchy->>'reason', '')
  );
  RETURN QUERY SELECT jsonb_build_object('outcome', 'CREATED', 'hierarchy', v_hierarchy);
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."submit_purchase_approval_request"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_proposal_row purchase_proposal_revisions%ROWTYPE;
  v_hierarchy_row approval_hierarchies%ROWTYPE;
  v_request jsonb;
  v_route jsonb;
  v_levels jsonb;
  v_existing jsonb;
  v_exact_count integer;
  v_generic_count integer;
  v_inserted integer;
  v_proposal_id text := p_payload->'proposalRevisionRef'->>'resourceId';
  v_proposal_revision integer;
  v_counterparty_id text := p_payload->'counterpartyRef'->>'resourceId';
  v_storefront_id text := p_payload->>'storefrontId';
  v_idempotency text := p_payload->>'idempotencyKey';
  v_request_id text;
  v_route_id text;
  v_operation_at timestamptz := now();
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  IF p_payload->>'proposalRevision' IS NULL
     OR p_payload->>'proposalRevision' !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'approval submission must bind a positive proposal revision' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_submit_revision';
  END IF;
  IF v_idempotency IS NULL OR btrim(v_idempotency) = '' THEN
    RAISE EXCEPTION 'approval submission requires an idempotency key' USING ERRCODE = '23505', CONSTRAINT = 'pa_request_idem';
  END IF;
  v_proposal_revision := (p_payload->>'proposalRevision')::integer;
  SELECT request_snapshot INTO v_existing
    FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency
   FOR SHARE;
  IF FOUND THEN
    IF v_existing->'proposal'->'proposalRevisionRef' IS DISTINCT FROM p_payload->'proposalRevisionRef' THEN
      RAISE EXCEPTION 'approval request idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_request_idem';
    END IF;
    IF v_existing->'proposal'->>'revision' IS DISTINCT FROM p_payload->>'proposalRevision' THEN
      RAISE EXCEPTION 'approval request idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_request_idem';
    END IF;
    IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM v_existing->'proposal'->'identity'->'counterpartyRef'->>'moduleId'
       OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM v_existing->'proposal'->'identity'->'counterpartyRef'->>'resourceType'
       OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM v_existing->'proposal'->'identity'->'counterpartyRef'->>'tenantId'
       OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_existing->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
       OR p_payload->>'storefrontId' IS DISTINCT FROM v_existing->'proposal'->'context'->>'storefrontId'
       OR p_payload->>'actorPrincipalId' IS DISTINCT FROM v_existing->'proposal'->'identity'->'buyer'->>'principalId' THEN
      RAISE EXCEPTION 'approval request target scope or buyer does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_target_mismatch';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ALREADY_SUBMITTED', 'request', v_existing);
    RETURN;
  END IF;

  SELECT * INTO v_proposal_row
   FROM purchase_proposal_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND proposal_revision_resource_id = v_proposal_id
     AND revision = v_proposal_revision
     AND state = 'CURRENT'
     AND approval_evaluation = 'APPROVAL_REQUIRED'
     AND jsonb_typeof(source_revision_vector) = 'array'
     AND (SELECT count(*) FROM jsonb_array_elements(source_revision_vector) AS sources(source)
          WHERE source->>'source' = 'purchase-proposal') = 1
     AND (SELECT count(*) FROM jsonb_array_elements(source_revision_vector) AS sources(source)
          WHERE source->>'source' = 'purchasing-profile') = 1
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(source_revision_vector) AS sources(source)
       WHERE source->>'source' = 'purchase-proposal'
         AND source->>'revision' = proposal_snapshot->'purchaseValue'->>'sourceRevision'
     )
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'requested purchase proposal revision is unavailable or not current' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_proposal_not_current';
  END IF;
  v_request_id := 'approval-request:' || v_proposal_id || ':' || v_proposal_row.revision;
  v_route_id := 'approval-route:' || v_proposal_id || ':' || v_proposal_row.revision;
  -- Locking the proposal above serializes concurrent submissions for one
  -- immutable revision.  Re-read the deterministic request identity after
  -- that lock so a different idempotency key becomes a typed conflict rather
  -- than leaking the raw request-resource unique violation.
  SELECT request_snapshot INTO v_existing
    FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND request_resource_id = v_request_id
   FOR SHARE;
  IF FOUND THEN
    IF v_existing->>'idempotencyKey' IS DISTINCT FROM v_idempotency THEN
      RAISE EXCEPTION 'approval request identity conflicts with an existing submission' USING ERRCODE = '23505', CONSTRAINT = 'pa_request_idem';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ALREADY_SUBMITTED', 'request', v_existing);
    RETURN;
  END IF;
  IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
     OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
     OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR v_counterparty_id IS DISTINCT FROM v_proposal_row.counterparty_resource_ref
     OR v_storefront_id IS DISTINCT FROM v_proposal_row.storefront_id
     OR p_payload->>'actorPrincipalId' IS DISTINCT FROM v_proposal_row.buyer_principal_id::text THEN
    RAISE EXCEPTION 'approval request target scope or buyer does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_target_mismatch';
  END IF;
  -- The proposal revision is authoritative.  The caller may carry a stale or
  -- malicious request-expiry hint, but it must never be able to extend or
  -- shorten the owner-recorded validity window.
  IF v_proposal_row.expires_at <= now() THEN
    RAISE EXCEPTION 'approval request validity window is invalid' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_request_expired';
  END IF;

  SELECT count(*) INTO v_exact_count FROM approval_hierarchies
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND counterparty_resource_ref = v_proposal_row.counterparty_resource_ref
     AND storefront_id = v_proposal_row.storefront_id
     AND hierarchy_snapshot->>'state' = 'ACTIVE'
     AND minimum_currency_code = v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'currency'
     AND minimum_amount <= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
     AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
     AND effective_from <= v_operation_at
     AND (effective_to IS NULL OR v_operation_at < effective_to);
  SELECT count(*) INTO v_generic_count FROM approval_hierarchies
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND counterparty_resource_ref = v_proposal_row.counterparty_resource_ref AND storefront_id IS NULL
     AND hierarchy_snapshot->>'state' = 'ACTIVE'
     AND minimum_currency_code = v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'currency'
     AND minimum_amount <= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
     AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
     AND effective_from <= v_operation_at
     AND (effective_to IS NULL OR v_operation_at < effective_to);
  IF v_exact_count = 0 AND v_generic_count = 0 THEN
    RAISE EXCEPTION 'approval hierarchy is not configured' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_hierarchy_missing';
  END IF;
  IF v_exact_count > 1 OR (v_exact_count = 0 AND v_generic_count > 1) THEN
    RAISE EXCEPTION 'approval hierarchy is not unambiguous' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_hierarchy_ambiguous';
  END IF;
  IF v_exact_count = 1 THEN
    SELECT * INTO v_hierarchy_row FROM approval_hierarchies
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND counterparty_resource_ref = v_proposal_row.counterparty_resource_ref AND storefront_id = v_proposal_row.storefront_id
       AND hierarchy_snapshot->>'state' = 'ACTIVE'
       AND minimum_currency_code = v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'currency'
       AND minimum_amount <= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
       AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
       AND effective_from <= v_operation_at
       AND (effective_to IS NULL OR v_operation_at < effective_to)
     ORDER BY revision DESC LIMIT 1;
  ELSE
    SELECT * INTO v_hierarchy_row FROM approval_hierarchies
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND counterparty_resource_ref = v_proposal_row.counterparty_resource_ref AND storefront_id IS NULL
       AND hierarchy_snapshot->>'state' = 'ACTIVE'
       AND minimum_currency_code = v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'currency'
       AND minimum_amount <= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
       AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal_row.proposal_snapshot->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
       AND effective_from <= v_operation_at
       AND (effective_to IS NULL OR v_operation_at < effective_to)
     ORDER BY revision DESC LIMIT 1;
  END IF;
  SELECT jsonb_agg(
    jsonb_build_object('levelId', level->>'levelId', 'order', (level->>'order')::integer,
      'completionRule', level->>'completionRule',
      'candidates', level->'eligiblePrincipals', 'completedBy', NULL, 'completedAt', NULL)
    ORDER BY (level->>'order')::integer
  ) INTO v_levels FROM jsonb_array_elements(v_hierarchy_row.hierarchy_snapshot->'levels') AS levels(level);
  IF v_levels IS NULL OR jsonb_array_length(v_levels) = 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_hierarchy_row.hierarchy_snapshot->'levels') AS levels(level)
       CROSS JOIN jsonb_array_elements(
         CASE WHEN jsonb_typeof(level->'eligiblePrincipals') = 'array'
              THEN level->'eligiblePrincipals' ELSE '[]'::jsonb END
       ) AS principals(principal)
       WHERE principal->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_hierarchy_row.hierarchy_snapshot->'levels') AS levels(level)
       WHERE level->>'completionRule' IS DISTINCT FROM 'ONE_APPROVER'
     ) THEN
    RAISE EXCEPTION 'approval hierarchy has no eligible route levels' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_route_empty';
  END IF;
  v_route := jsonb_build_object(
    'routeRef', jsonb_build_object('moduleId', 'commerce.customer-context', 'resourceId', v_route_id,
      'resourceType', 'commerce.customer-context.approval-route', 'tenantId', p_tenant_id),
    'requestRef', jsonb_build_object('moduleId', 'commerce.customer-context', 'resourceId', v_request_id,
      'resourceType', 'commerce.customer-context.purchase-approval-request', 'tenantId', p_tenant_id),
    'proposalRevisionRef', v_proposal_row.proposal_snapshot->'proposalRevisionRef',
    'hierarchyRef', v_hierarchy_row.hierarchy_snapshot->'hierarchyRef', 'hierarchyRevision', v_hierarchy_row.revision,
    'levels', v_levels, 'currentLevelOrder', 1, 'status', 'PENDING',
    'capturedAt', v_operation_at, 'rerouteReason', NULL
  );
  v_request := jsonb_build_object(
    'requestRef', v_route->'requestRef', 'proposal', v_proposal_row.proposal_snapshot, 'route', v_route,
    'status', 'PENDING', 'submittedAt', v_operation_at,
    'expiresAt', to_jsonb(v_proposal_row.expires_at), 'idempotencyKey', v_idempotency, 'requestRevision', 1,
    'consumedAt', NULL, 'committedOrderRef', NULL, 'consumptionCommitmentId', NULL,
    'decisionBundleHash', NULL, 'decisionBundleVersion', NULL, 'lastDecisionRef', NULL
  );
  INSERT INTO approval_routes (
    tenant_id, legal_entity_id, route_resource_id, request_resource_id, proposal_revision_resource_id,
    hierarchy_resource_id, hierarchy_revision, idempotency_key, route_snapshot, current_level_order,
    status, captured_at, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_route_id, v_request_id, v_proposal_id,
    v_hierarchy_row.hierarchy_resource_id, v_hierarchy_row.revision, v_idempotency, v_route, 1, 'PENDING',
    v_operation_at,
    NULLIF(p_payload->>'actionInvocationId', '')::uuid,
    (p_payload->>'actorPrincipalId')::uuid, 'SUBMIT'
  ) ON CONFLICT (tenant_id, legal_entity_id, route_resource_id) DO NOTHING;
  INSERT INTO purchase_approval_requests (
    tenant_id, legal_entity_id, request_resource_id, proposal_revision_resource_id, route_resource_id,
    request_revision, request_snapshot, status, idempotency_key, submitted_at, expires_at,
    action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_request_id, v_proposal_id, v_route_id, 1, v_request, 'PENDING', v_idempotency,
    v_operation_at,
    v_proposal_row.expires_at,
    NULLIF(p_payload->>'actionInvocationId', '')::uuid,
    (p_payload->>'actorPrincipalId')::uuid, 'SUBMIT'
  ) ON CONFLICT (tenant_id, legal_entity_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  SELECT request_snapshot INTO v_existing FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency;
  RETURN QUERY SELECT jsonb_build_object('outcome', CASE WHEN v_inserted = 1 THEN 'SUBMITTED' ELSE 'ALREADY_SUBMITTED' END, 'request', COALESCE(v_existing, v_request));
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."decide_purchase_approval_request"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
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
  IF v_request_row.request_revision <> (p_payload->>'expectedRequestRevision')::integer
     OR v_request_row.proposal_revision_resource_id <> (p_payload->'proposalRevisionRef'->>'resourceId')
     OR v_request_row.request_snapshot->'proposal'->'proposalRevisionRef' IS DISTINCT FROM p_payload->'proposalRevisionRef'
     OR v_request_row.status <> 'PENDING'
     OR (v_request_row.request_snapshot->'route'->>'status') <> 'PENDING'
     OR now() >= v_request_row.expires_at THEN
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

CREATE OR REPLACE FUNCTION "commerce_customer_context"."reroute_purchase_approval_request"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_request_row purchase_approval_requests%ROWTYPE;
  v_existing_route approval_routes%ROWTYPE;
  v_current_route_row approval_routes%ROWTYPE;
  v_hierarchy_row approval_hierarchies%ROWTYPE;
  v_proposal jsonb;
  v_route jsonb;
  v_levels jsonb;
  v_request jsonb;
  v_exact_count integer;
  v_generic_count integer;
  v_reroute_required boolean := false;
  v_reroute_reason text;
  v_request_id text := p_payload->'requestRef'->>'resourceId';
  v_idempotency text := p_payload->>'idempotencyKey';
  v_operation_at timestamptz := now();
  v_route_id text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope' USING ERRCODE = '42501', CONSTRAINT = 'pa_scope';
  END IF;
  -- Reroute idempotency belongs to the route command, not to the original
  -- submit request.  Looking up the request idempotency key here made a
  -- replay look successful before a route was persisted and made a concurrent
  -- reroute either duplicate the route or fail its CAS unpredictably.
  SELECT * INTO v_existing_route FROM approval_routes
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency
   FOR SHARE;
  IF FOUND THEN
    IF v_existing_route.request_resource_id IS DISTINCT FROM v_request_id
       OR v_existing_route.reroute_reason IS DISTINCT FROM NULLIF(p_payload->>'reason', '')
       OR v_existing_route.route_snapshot->'requestRef' IS DISTINCT FROM p_payload->'requestRef' THEN
      RAISE EXCEPTION 'approval reroute idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_reroute_idem';
    END IF;
    SELECT request_snapshot INTO v_request FROM purchase_approval_requests
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval reroute request snapshot is unavailable' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_snapshot_missing';
    END IF;
    IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
       OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
       OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
       OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_request->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
       OR p_payload->>'storefrontId' IS DISTINCT FROM v_request->'proposal'->'context'->>'storefrontId' THEN
      RAISE EXCEPTION 'approval reroute target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_reroute_target';
    END IF;
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', CASE WHEN v_existing_route.status = 'REROUTE_REQUIRED' THEN 'REROUTE_REQUIRED' ELSE 'REROUTED' END,
      'request', v_request, 'route', v_request->'route'
    );
    RETURN;
  END IF;
  SELECT * INTO v_request_row FROM purchase_approval_requests
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request cannot be rerouted at the expected revision' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_cas';
  END IF;
  -- Re-check after taking the request lock.  A concurrent first attempt can
  -- have committed its route while this transaction was waiting on the row.
  SELECT * INTO v_existing_route FROM approval_routes
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND idempotency_key = v_idempotency
   FOR SHARE;
  IF FOUND THEN
    IF v_existing_route.request_resource_id IS DISTINCT FROM v_request_id
       OR v_existing_route.reroute_reason IS DISTINCT FROM NULLIF(p_payload->>'reason', '')
       OR v_existing_route.route_snapshot->'requestRef' IS DISTINCT FROM p_payload->'requestRef' THEN
      RAISE EXCEPTION 'approval reroute idempotency conflict' USING ERRCODE = '23505', CONSTRAINT = 'pa_reroute_idem';
    END IF;
    IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
       OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
       OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
       OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
       OR p_payload->>'storefrontId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'context'->>'storefrontId' THEN
      RAISE EXCEPTION 'approval reroute target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_reroute_target';
    END IF;
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', CASE WHEN v_existing_route.status = 'REROUTE_REQUIRED' THEN 'REROUTE_REQUIRED' ELSE 'REROUTED' END,
      'request', v_request_row.request_snapshot, 'route', v_request_row.request_snapshot->'route'
    );
    RETURN;
  END IF;
  -- Expiry is checked while the request row is locked and before any route
  -- lookup or route mutation.  An expired request cannot be revived by a
  -- reroute, even when its captured route still says PENDING.
  IF v_request_row.expires_at <= v_operation_at THEN
    RAISE EXCEPTION 'approval request validity window has expired' USING ERRCODE = 'P0001', CONSTRAINT = 'pa_request_expired';
  END IF;
  IF p_payload->'counterpartyRef'->>'moduleId' IS DISTINCT FROM 'party.registry'
     OR p_payload->'counterpartyRef'->>'resourceType' IS DISTINCT FROM 'party.registry.counterparty'
     OR p_payload->'counterpartyRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_payload->'counterpartyRef'->>'resourceId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'identity'->'counterpartyRef'->>'resourceId'
     OR p_payload->>'storefrontId' IS DISTINCT FROM v_request_row.request_snapshot->'proposal'->'context'->>'storefrontId' THEN
    RAISE EXCEPTION 'approval reroute target scope does not match the persisted proposal' USING ERRCODE = '42501', CONSTRAINT = 'pa_reroute_target';
  END IF;
  IF v_request_row.status <> 'PENDING'
     OR v_request_row.request_revision <> (p_payload->>'expectedRequestRevision')::integer
     OR v_request_row.request_snapshot->'route'->>'status' NOT IN ('PENDING', 'REROUTE_REQUIRED') THEN
    RAISE EXCEPTION 'approval request cannot be rerouted at the expected revision' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_cas';
  END IF;
  v_proposal := v_request_row.request_snapshot->'proposal';
  SELECT * INTO v_current_route_row FROM approval_routes
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND route_resource_id = v_request_row.route_resource_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request route snapshot is unavailable' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_snapshot_missing';
  END IF;
  -- A reroute is a new owner-resolved route, never a reset of the old route's
  -- levels. Prefer the exact Storefront hierarchy; fall back to exactly one
  -- Counterparty-wide hierarchy, and fail closed on ambiguity.
  SELECT count(*) INTO v_exact_count FROM approval_hierarchies
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND counterparty_resource_ref = v_proposal->'identity'->'counterpartyRef'->>'resourceId'
     AND storefront_id = v_proposal->'context'->>'storefrontId'
     AND hierarchy_snapshot->>'state' = 'ACTIVE'
     AND minimum_currency_code = v_proposal->'purchaseValue'->'monetaryAmount'->>'currency'
     AND minimum_amount <= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
     AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
     AND effective_from <= v_operation_at
     AND (effective_to IS NULL OR v_operation_at < effective_to);
  SELECT count(*) INTO v_generic_count FROM approval_hierarchies
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND counterparty_resource_ref = v_proposal->'identity'->'counterpartyRef'->>'resourceId'
     AND storefront_id IS NULL
     AND hierarchy_snapshot->>'state' = 'ACTIVE'
     AND minimum_currency_code = v_proposal->'purchaseValue'->'monetaryAmount'->>'currency'
     AND minimum_amount <= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
     AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
     AND effective_from <= v_operation_at
     AND (effective_to IS NULL OR v_operation_at < effective_to);
  IF v_exact_count = 0 AND v_generic_count = 0 THEN
    v_reroute_required := true;
    v_reroute_reason := 'NO_CURRENT_HIERARCHY';
  ELSIF v_exact_count > 1 OR (v_exact_count = 0 AND v_generic_count > 1) THEN
    v_reroute_required := true;
    v_reroute_reason := 'AMBIGUOUS_CURRENT_HIERARCHY';
  END IF;
  -- REROUTE_REQUIRED is a committed owner outcome, not an exception: the old route is
  -- superseded and the request points at a durable marker so a retry can continue from the
  -- next request revision instead of rolling the marker back with a raised exception.
  IF v_reroute_required THEN
    v_route_id := 'approval-route:' || v_request_id || ':reroute-required:' || (v_request_row.request_revision + 1);
    v_route := v_request_row.request_snapshot->'route' || jsonb_build_object(
      'routeRef', jsonb_build_object(
        'moduleId', 'commerce.customer-context',
        'resourceId', v_route_id,
        'resourceType', 'commerce.customer-context.approval-route',
        'tenantId', p_tenant_id
      ),
      'status', 'REROUTE_REQUIRED',
      'capturedAt', v_operation_at,
      'rerouteReason', p_payload->>'reason'
    );
    v_request := v_request_row.request_snapshot || jsonb_build_object(
      'route', v_route,
      'requestRevision', v_request_row.request_revision + 1,
      'status', 'PENDING'
    );
    INSERT INTO approval_routes (
      tenant_id, legal_entity_id, route_resource_id, request_resource_id, proposal_revision_resource_id,
      hierarchy_resource_id, hierarchy_revision, idempotency_key, route_snapshot, current_level_order,
      status, captured_at, reroute_reason, action_invocation_id, actor_principal_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_route_id, v_request_id, v_current_route_row.proposal_revision_resource_id,
      v_current_route_row.hierarchy_resource_id, v_current_route_row.hierarchy_revision, v_idempotency,
      v_route, v_current_route_row.current_level_order, 'REROUTE_REQUIRED', v_operation_at,
      p_payload->>'reason', NULLIF(p_payload->>'actionInvocationId', '')::uuid,
      (p_payload->>'actorPrincipalId')::uuid, v_reroute_reason
    );
    UPDATE approval_routes
       SET status = 'SUPERSEDED',
           route_snapshot = route_snapshot || jsonb_build_object('status', 'SUPERSEDED', 'rerouteReason', p_payload->>'reason'),
           reroute_reason = p_payload->>'reason', reason = 'SUPERSEDED'
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND route_resource_id = v_current_route_row.route_resource_id;
    UPDATE purchase_approval_requests
       SET request_revision = request_revision + 1,
           request_snapshot = v_request,
           route_resource_id = v_route_id
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND request_resource_id = v_request_id
       AND request_revision = (p_payload->>'expectedRequestRevision')::integer;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval request reroute CAS lost' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_cas';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'REROUTE_REQUIRED', 'request', v_request, 'route', v_route);
    RETURN;
  END IF;
  IF v_exact_count = 1 THEN
    SELECT * INTO v_hierarchy_row FROM approval_hierarchies
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND counterparty_resource_ref = v_proposal->'identity'->'counterpartyRef'->>'resourceId'
       AND storefront_id = v_proposal->'context'->>'storefrontId'
       AND hierarchy_snapshot->>'state' = 'ACTIVE'
       AND minimum_currency_code = v_proposal->'purchaseValue'->'monetaryAmount'->>'currency'
       AND minimum_amount <= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
       AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
       AND effective_from <= v_operation_at
       AND (effective_to IS NULL OR v_operation_at < effective_to)
     ORDER BY revision DESC LIMIT 1;
  ELSE
    SELECT * INTO v_hierarchy_row FROM approval_hierarchies
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND counterparty_resource_ref = v_proposal->'identity'->'counterpartyRef'->>'resourceId'
       AND storefront_id IS NULL
       AND hierarchy_snapshot->>'state' = 'ACTIVE'
       AND minimum_currency_code = v_proposal->'purchaseValue'->'monetaryAmount'->>'currency'
       AND minimum_amount <= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric
       AND (maximum_amount IS NULL OR maximum_amount >= (v_proposal->'purchaseValue'->'monetaryAmount'->>'amount')::numeric)
       AND effective_from <= v_operation_at
       AND (effective_to IS NULL OR v_operation_at < effective_to)
     ORDER BY revision DESC LIMIT 1;
  END IF;
  SELECT jsonb_agg(
    jsonb_build_object('levelId', level->>'levelId', 'order', (level->>'order')::integer,
      'completionRule', level->>'completionRule',
      'candidates', level->'eligiblePrincipals', 'completedBy', NULL, 'completedAt', NULL)
    ORDER BY (level->>'order')::integer
  ) INTO v_levels FROM jsonb_array_elements(v_hierarchy_row.hierarchy_snapshot->'levels') AS levels(level);
  IF v_levels IS NULL OR jsonb_array_length(v_levels) = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_hierarchy_row.hierarchy_snapshot->'levels') AS levels(level)
       CROSS JOIN jsonb_array_elements(
         CASE WHEN jsonb_typeof(level->'eligiblePrincipals') = 'array'
              THEN level->'eligiblePrincipals' ELSE '[]'::jsonb END
       ) AS principals(principal)
       WHERE principal->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_hierarchy_row.hierarchy_snapshot->'levels') AS levels(level)
       WHERE level->>'completionRule' IS DISTINCT FROM 'ONE_APPROVER'
     ) THEN
    v_route_id := 'approval-route:' || v_request_id || ':reroute-required:' || (v_request_row.request_revision + 1);
    v_route := v_request_row.request_snapshot->'route' || jsonb_build_object(
      'routeRef', jsonb_build_object(
        'moduleId', 'commerce.customer-context',
        'resourceId', v_route_id,
        'resourceType', 'commerce.customer-context.approval-route',
        'tenantId', p_tenant_id
      ),
      'status', 'REROUTE_REQUIRED',
      'capturedAt', v_operation_at,
      'rerouteReason', p_payload->>'reason'
    );
    v_request := v_request_row.request_snapshot || jsonb_build_object(
      'route', v_route,
      'requestRevision', v_request_row.request_revision + 1,
      'status', 'PENDING'
    );
    INSERT INTO approval_routes (
      tenant_id, legal_entity_id, route_resource_id, request_resource_id, proposal_revision_resource_id,
      hierarchy_resource_id, hierarchy_revision, idempotency_key, route_snapshot, current_level_order,
      status, captured_at, reroute_reason, action_invocation_id, actor_principal_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_route_id, v_request_id, v_current_route_row.proposal_revision_resource_id,
      v_current_route_row.hierarchy_resource_id, v_current_route_row.hierarchy_revision, v_idempotency,
      v_route, v_current_route_row.current_level_order, 'REROUTE_REQUIRED', v_operation_at,
      p_payload->>'reason', NULLIF(p_payload->>'actionInvocationId', '')::uuid,
      (p_payload->>'actorPrincipalId')::uuid, 'NO_ELIGIBLE_ROUTE'
    );
    UPDATE approval_routes
       SET status = 'SUPERSEDED',
           route_snapshot = route_snapshot || jsonb_build_object('status', 'SUPERSEDED', 'rerouteReason', p_payload->>'reason'),
           reroute_reason = p_payload->>'reason', reason = 'SUPERSEDED'
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND route_resource_id = v_current_route_row.route_resource_id;
    UPDATE purchase_approval_requests
       SET request_revision = request_revision + 1,
           request_snapshot = v_request,
           route_resource_id = v_route_id
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND request_resource_id = v_request_id
       AND request_revision = (p_payload->>'expectedRequestRevision')::integer;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval request reroute CAS lost' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_cas';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'REROUTE_REQUIRED', 'request', v_request, 'route', v_route);
    RETURN;
  END IF;
  v_route_id := 'approval-route:' || v_request_id || ':reroute:' || (v_request_row.request_revision + 1);
  v_route := v_request_row.request_snapshot->'route';
  v_route := v_route || jsonb_build_object(
    'routeRef', jsonb_build_object('moduleId', 'commerce.customer-context', 'resourceId', v_route_id, 'resourceType', 'commerce.customer-context.approval-route', 'tenantId', p_tenant_id),
    'hierarchyRef', v_hierarchy_row.hierarchy_snapshot->'hierarchyRef',
    'hierarchyRevision', v_hierarchy_row.revision,
    'proposalRevisionRef', v_proposal->'proposalRevisionRef',
    'levels', v_levels, 'currentLevelOrder', 1, 'status', 'PENDING', 'capturedAt', v_operation_at, 'rerouteReason', p_payload->>'reason'
  );
  v_request := v_request_row.request_snapshot || jsonb_build_object('route', v_route, 'requestRevision', v_request_row.request_revision + 1, 'status', 'PENDING');
  INSERT INTO approval_routes (
    tenant_id, legal_entity_id, route_resource_id, request_resource_id, proposal_revision_resource_id,
    hierarchy_resource_id, hierarchy_revision, idempotency_key, route_snapshot, current_level_order,
    status, captured_at, reroute_reason, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_route_id, v_request_id, v_request->'proposal'->'proposalRevisionRef'->>'resourceId',
    v_route->'hierarchyRef'->>'resourceId', (v_route->>'hierarchyRevision')::integer, v_idempotency, v_route, 1, 'PENDING',
    v_operation_at, p_payload->>'reason', NULLIF(p_payload->>'actionInvocationId', '')::uuid,
    (p_payload->>'actorPrincipalId')::uuid, p_payload->>'reason'
  );
  UPDATE approval_routes
     SET status = 'SUPERSEDED',
         route_snapshot = route_snapshot || jsonb_build_object('status', 'SUPERSEDED', 'rerouteReason', p_payload->>'reason'),
         reroute_reason = p_payload->>'reason', reason = 'SUPERSEDED'
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND route_resource_id = v_current_route_row.route_resource_id;
  UPDATE purchase_approval_requests SET request_revision = request_revision + 1, request_snapshot = v_request, route_resource_id = v_route_id
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND request_resource_id = v_request_id AND request_revision = (p_payload->>'expectedRequestRevision')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval request reroute CAS lost' USING ERRCODE = '40001', CONSTRAINT = 'pa_reroute_cas'; END IF;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'REROUTED', 'request', v_request, 'route', v_route);
END;
$$;

CREATE OR REPLACE FUNCTION "commerce_customer_context"."revalidate_purchase_approval"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
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
  v_now timestamptz := clock_timestamp();
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
   FOR SHARE;
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
  -- checkedAt/validUntil are owner evidence supplied by the caller, but the routine's
  -- server clock is authoritative for accepting and replaying that evidence.
  v_now := clock_timestamp();
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
  v_ref := jsonb_build_object('moduleId','commerce.customer-context','resourceId','approval-revalidation:' || v_request_id || ':' || v_request_row.request_revision,'resourceType','commerce.customer-context.approval-revalidation','tenantId',p_tenant_id);
  v_revalidation := jsonb_build_object('revalidationRef', v_ref, 'requestRef', v_request_row.request_snapshot->'requestRef', 'proposalRevisionRef', v_request_row.request_snapshot->'proposal'->'proposalRevisionRef', 'approvedRoute', v_request_row.request_snapshot->'route', 'checkedAt', v_checked_at, 'validUntil', v_valid_until, 'status', v_status, 'committedOrderRef', v_request_row.request_snapshot->'committedOrderRef', 'evidence', jsonb_build_object('proposalHash', p_payload->>'expectedProposalHash', 'decisionBundleHash', p_payload->>'decisionBundleHash', 'decisionBundleVersion', p_payload->>'decisionBundleVersion', 'decisionRef', p_payload->'decisionRef', 'hierarchyRef', p_payload->'hierarchyRef', 'routeRef', p_payload->'routeRef', 'sourceRevisions', p_payload->'sourceRevisions', 'commitmentCorrelationId', p_payload->>'commitmentCorrelationId', 'buyerPermission', p_payload->>'buyerPermission', 'profileState', v_profile_state, 'policyRouteCurrent', v_route_current));
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
SET search_path = pg_catalog, commerce_customer_context
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
    'consumptionEvidence', v_consumption_evidence
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

-- The owner routines run as the table owner under forced RLS.  Runtime callers
-- receive only routine EXECUTE; direct table access remains unavailable.
ALTER TABLE "commerce_customer_context"."approval_decisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."approval_hierarchies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."approval_revalidations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."approval_routes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."purchase_approval_requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."purchase_proposal_revisions" FORCE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS "ccc_purchase_proposals_current_resource_uk"
  ON "commerce_customer_context"."purchase_proposal_revisions"
  (tenant_id, legal_entity_id, proposal_revision_resource_id)
  WHERE state = 'CURRENT';
-- A Cart revision is one immutable proposal lineage.  The resource id alone is not
-- sufficient because retries/new revisions may legitimately retain the same proposal
-- resource identity; this guard prevents two different proposal identities from both
-- claiming CURRENT for the same source Cart revision.
CREATE UNIQUE INDEX IF NOT EXISTS "ccc_purchase_proposals_current_cart_revision_uk"
  ON "commerce_customer_context"."purchase_proposal_revisions" (
    tenant_id,
    legal_entity_id,
    ((proposal_snapshot->'sourceCart'->'cartRef'->>'moduleId')),
    ((proposal_snapshot->'sourceCart'->'cartRef'->>'resourceType')),
    ((proposal_snapshot->'sourceCart'->'cartRef'->>'resourceId')),
    ((proposal_snapshot->'sourceCart'->'cartRef'->>'tenantId')),
    ((proposal_snapshot->'sourceCart'->>'revision'))
  )
  WHERE state = 'CURRENT';
REVOKE ALL ON TABLE
  "commerce_customer_context"."approval_decisions",
  "commerce_customer_context"."approval_hierarchies",
  "commerce_customer_context"."approval_revalidations",
  "commerce_customer_context"."approval_routes",
  "commerce_customer_context"."purchase_approval_requests",
  "commerce_customer_context"."purchase_proposal_revisions"
FROM PUBLIC, ontos_runtime;

REVOKE ALL ON FUNCTION "commerce_customer_context"."create_purchase_proposal_revision"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_current_purchase_proposal_revision"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_current_purchase_approval_revalidation"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."create_approval_hierarchy"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."submit_purchase_approval_request"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."decide_purchase_approval_request"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."reroute_purchase_approval_request"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."revalidate_purchase_approval"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION "commerce_customer_context"."consume_purchase_approval"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."create_purchase_proposal_revision"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_current_purchase_proposal_revision"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_current_purchase_approval_revalidation"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."create_approval_hierarchy"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."submit_purchase_approval_request"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."decide_purchase_approval_request"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reroute_purchase_approval_request"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."revalidate_purchase_approval"(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."consume_purchase_approval"(uuid, uuid, jsonb) TO ontos_runtime;
