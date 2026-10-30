-- An uninitialized ZERO_FLOOR scope has no Authorization. The receipted Current-set read initializes the empty set
-- through the owner's own routine instead of failing, so a first Pricing decision does not need an unrelated mutation.
-- The receipted read is SECURITY DEFINER; it needs EXECUTE on the otherwise runtime-revoked owner routine.
DO $grant$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION pricing.ensure_zero_floor_set_v1(uuid,uuid,text) TO %I', current_user);
END
$grant$;

CREATE OR REPLACE FUNCTION pricing.read_current_zero_floor_authorization_set_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_payload jsonb;
  v_authority jsonb;
  v_facts jsonb;
  v_record pricing.material_evidence_proof_receipts%ROWTYPE;
  v_observed timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN RAISE EXCEPTION 'Zero Floor proof scope mismatch' USING ERRCODE = '42501'; END IF;
  -- A scope that never had a ZERO_FLOOR mutation holds no Authorization. Its first Current-set read initializes
  -- the empty set at generation 1 (idempotent, same owner routine the mutations use), so the first Pricing
  -- decision is not blocked on an unrelated mutation.
  PERFORM pricing.ensure_zero_floor_set_v1(
    p_tenant_id, p_legal_entity_id, 'internal:zero-floor-read-initialize:' || gen_random_uuid()::text);
  SELECT prior.payload INTO v_payload
    FROM pricing.read_current_zero_floor_authorization_set_unreceipted_v1(
      p_tenant_id, p_legal_entity_id, p_input) AS prior;
  IF v_payload ->> 'outcome' <> 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT' THEN
    RETURN QUERY SELECT v_payload;
    RETURN;
  END IF;
  v_authority := v_payload -> 'authority';
  v_observed := (v_authority ->> 'observedAt')::timestamptz;
  IF v_observed IS NULL OR (p_input #>> '{query,effectiveAt}')::timestamptz > v_observed THEN
    RAISE EXCEPTION 'Zero Floor owner observation is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'factRef', auth.value ->> 'authorizationRef',
    'factRevisionRef', auth.value ->> 'authorizationRevision',
    'verificationRef', v_authority ->> 'verificationRef')
    ORDER BY auth.value ->> 'authorizationRef', auth.value ->> 'authorizationRevision'), '[]'::jsonb)
    INTO v_facts
    FROM jsonb_array_elements(v_payload #> '{authorizationSet,authorizations}') AS auth(value);
  v_payload := jsonb_set(v_payload, '{factProofs}', v_facts, true);
  INSERT INTO pricing.material_evidence_proof_receipts (
    tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at,
    owner_root_ref, owner_set_revision_ref, predicate_ref, generation, current_facts, query
  ) VALUES (
    p_tenant_id, p_legal_entity_id, 'ZERO_FLOOR', v_authority ->> 'verificationRef',
    v_observed, (p_input #>> '{query,effectiveAt}')::timestamptz,
    v_authority ->> 'ownerRootRef', v_authority ->> 'ownerRevision',
    v_authority ->> 'predicateRef', (v_authority ->> 'generation')::integer,
    v_facts, p_input -> 'query'
  ) ON CONFLICT (tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at) DO NOTHING;
  SELECT * INTO v_record FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'ZERO_FLOOR'
     AND receipt.verification_ref = v_authority ->> 'verificationRef'
     AND receipt.observed_at = v_observed
     AND receipt.effective_at = (p_input #>> '{query,effectiveAt}')::timestamptz;
  IF NOT FOUND OR v_record.current_facts <> v_facts OR v_record.query <> p_input -> 'query'
    OR v_record.owner_root_ref <> v_authority ->> 'ownerRootRef'
    OR v_record.owner_set_revision_ref <> v_authority ->> 'ownerRevision'
    OR v_record.predicate_ref <> v_authority ->> 'predicateRef'
    OR v_record.generation <> (v_authority ->> 'generation')::integer
  THEN RAISE EXCEPTION 'Zero Floor proof receipt conflicts with owner read' USING ERRCODE = '23514'; END IF;
  RETURN QUERY SELECT v_payload;
END;
$function$;
