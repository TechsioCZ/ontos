-- #1279: bind independently produced exact material evidence to candidate-set authority.
-- Preserve set/root/generation/fact identity, RLS, existing receipts and all currentness gates.
CREATE OR REPLACE FUNCTION pricing.read_exact_price_candidate_set_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_observed timestamptz := statement_timestamp();
  v_observed_text text := to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_at timestamptz := (p_input ->> 'effectiveAt')::timestamptz;
  v_payload jsonb;
  v_authority jsonb;
  v_lookup jsonb;
  v_candidate jsonb;
  v_count integer;
  v_facts jsonb;
  v_record pricing.material_evidence_proof_receipts%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN RAISE EXCEPTION 'Exact Price proof scope mismatch' USING ERRCODE = '42501'; END IF;
  -- Both STABLE producers use this one SELECT snapshot. A separate SELECT for each
  -- producer could observe a concurrent owner write between the two statements.
  SELECT candidate.payload, exact_lookup.payload INTO STRICT v_payload, v_lookup
    FROM pricing.read_exact_price_candidate_set_unobserved_v1(p_tenant_id, p_legal_entity_id, p_input) AS candidate
    CROSS JOIN pricing.lookup_exact_current_price_v2(p_tenant_id, p_legal_entity_id, p_input) AS exact_lookup;
  IF v_at IS NULL OR v_at > v_observed THEN
    RAISE EXCEPTION 'Exact Price requested instant follows owner observation' USING ERRCODE = '22023';
  END IF;
  IF v_payload ->> 'outcome' <> 'EXACT_PRICE_CANDIDATE_SET_CURRENT' THEN
    RETURN QUERY SELECT v_payload;
    RETURN;
  END IF;
  v_count := jsonb_array_length(v_payload #> '{candidateSet,candidates}');
  v_candidate := v_payload #> '{candidateSet,candidates,0}';
  IF v_lookup -> 'request' IS DISTINCT FROM p_input
    OR NOT (
      (v_count = 0 AND v_lookup ->> '_tag' = 'ABSENT')
      OR (v_count = 1 AND v_lookup ->> '_tag' = 'FOUND'
        AND v_candidate -> 'priceRef' = v_lookup -> 'priceRef'
        AND v_candidate -> 'priceRevision' = v_lookup -> 'priceRevision')
    )
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'effectiveAt', p_input ->> 'effectiveAt', 'exactKey', p_input -> 'exactKey',
      'outcome', 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
      'reason', 'Exact Price native readers disagree on the complete Current state');
    RETURN;
  END IF;
  -- This exact material revision is distinct from the set generation/revision below.
  -- Its observation is the same statement time as this issued candidate receipt.
  v_payload := jsonb_set(v_payload, '{lookupEvidence}', v_lookup -> 'evidence', true);
  IF v_payload #>> '{authority,nextApplicabilityBoundary}' IS NOT NULL
    AND (v_payload #>> '{authority,nextApplicabilityBoundary}')::timestamptz <= v_observed
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'effectiveAt', p_input ->> 'effectiveAt', 'exactKey', p_input -> 'exactKey',
      'outcome', 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
      'reason', 'Exact Price applicability changed before owner observation');
    RETURN;
  END IF;
  v_payload := jsonb_set(v_payload, '{authority,observedAt}', to_jsonb(v_observed_text));
  v_authority := v_payload -> 'authority';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'factRef', candidate.value #>> '{priceRef,resourceId}',
    'factRevisionRef', candidate.value #>> '{priceRevision,revisionId}',
    'verificationRef', v_authority ->> 'verificationRef')
    ORDER BY candidate.value #>> '{priceRef,resourceId}',
             candidate.value #>> '{priceRevision,revisionId}'), '[]'::jsonb)
    INTO v_facts
    FROM jsonb_array_elements(v_payload #> '{candidateSet,candidates}') AS candidate(value);
  v_payload := jsonb_set(v_payload, '{factProofs}', v_facts, true);
  INSERT INTO pricing.material_evidence_proof_receipts (
    tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at,
    owner_root_ref, owner_set_revision_ref, predicate_ref, generation, current_facts, query
  ) VALUES (
    p_tenant_id, p_legal_entity_id, 'PRICE', v_authority ->> 'verificationRef',
    v_observed_text::timestamptz, v_at, v_authority ->> 'ownerRootRef',
    v_authority ->> 'ownerRevision', v_authority ->> 'predicateRef',
    (v_authority ->> 'generation')::integer, v_facts, p_input
  ) ON CONFLICT (tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at) DO NOTHING;
  SELECT * INTO v_record FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'PRICE'
     AND receipt.verification_ref = v_authority ->> 'verificationRef'
     AND receipt.observed_at = v_observed_text::timestamptz
     AND receipt.effective_at = v_at;
  IF NOT FOUND OR v_record.current_facts <> v_facts OR v_record.query <> p_input
    OR v_record.owner_root_ref <> v_authority ->> 'ownerRootRef'
    OR v_record.owner_set_revision_ref <> v_authority ->> 'ownerRevision'
    OR v_record.predicate_ref <> v_authority ->> 'predicateRef'
    OR v_record.generation <> (v_authority ->> 'generation')::integer
  THEN RAISE EXCEPTION 'Exact Price proof receipt conflicts with owner read' USING ERRCODE = '23514'; END IF;
  RETURN QUERY SELECT v_payload;
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_exact_price_candidate_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_exact_price_candidate_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
