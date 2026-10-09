-- The owner issues an immutable receipt at its original Current read. The
-- caller's opaque reference is only a lookup key; no part of it is parsed.
CREATE TABLE pricing.material_evidence_proof_receipts (
  material_evidence_proof_receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  family text NOT NULL,
  verification_ref text NOT NULL,
  observed_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  owner_root_ref text NOT NULL,
  owner_set_revision_ref text NOT NULL,
  predicate_ref text NOT NULL,
  generation integer NOT NULL,
  current_facts jsonb NOT NULL,
  query jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pricing_material_proof_receipt_identity_uk UNIQUE
    (tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at),
  CONSTRAINT pricing_material_proof_receipt_family_ck CHECK
    (family IN ('PRICE', 'COMMERCIAL_FEE', 'ZERO_FLOOR', 'QUANTITY_TIER', 'DISCOUNT', 'CURRENCY_SUPPORT')),
  CONSTRAINT pricing_material_proof_receipt_generation_ck CHECK (generation >= 0),
  CONSTRAINT pricing_material_proof_receipt_temporal_ck CHECK
    (effective_at <= observed_at AND observed_at <= recorded_at),
  CONSTRAINT pricing_material_proof_receipt_facts_ck CHECK (jsonb_typeof(current_facts) = 'array'),
  CONSTRAINT pricing_material_proof_receipt_query_ck CHECK (jsonb_typeof(query) = 'object'),
  CONSTRAINT pricing_material_proof_receipt_refs_ck CHECK (
    length(verification_ref) > 0 AND length(owner_root_ref) > 0
    AND length(owner_set_revision_ref) > 0 AND length(predicate_ref) > 0)
);
ALTER TABLE pricing.material_evidence_proof_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.material_evidence_proof_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_material_proof_receipts_scope_select
  ON pricing.material_evidence_proof_receipts FOR SELECT TO PUBLIC
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_material_proof_receipts_scope_insert
  ON pricing.material_evidence_proof_receipts FOR INSERT TO PUBLIC
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_material_proof_receipts_scope_update
  ON pricing.material_evidence_proof_receipts FOR UPDATE TO PUBLIC
  USING (false) WITH CHECK (false);
CREATE POLICY pricing_material_proof_receipts_scope_delete
  ON pricing.material_evidence_proof_receipts FOR DELETE TO PUBLIC
  USING (false);
REVOKE ALL ON TABLE pricing.material_evidence_proof_receipts FROM PUBLIC, ontos_runtime;

-- Price and Fee used to report the requested effective instant as observedAt.
-- The public wrappers now issue a receipt and report this statement's DB time.
ALTER FUNCTION pricing.read_exact_price_candidate_set_v1(uuid, uuid, jsonb)
  RENAME TO read_exact_price_candidate_set_unobserved_v1;
REVOKE ALL ON FUNCTION pricing.read_exact_price_candidate_set_unobserved_v1(uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;
CREATE FUNCTION pricing.read_exact_price_candidate_set_v1(
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
  v_facts jsonb;
  v_record pricing.material_evidence_proof_receipts%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN RAISE EXCEPTION 'Exact Price proof scope mismatch' USING ERRCODE = '42501'; END IF;
  SELECT prior.payload INTO v_payload
    FROM pricing.read_exact_price_candidate_set_unobserved_v1(p_tenant_id, p_legal_entity_id, p_input) AS prior;
  IF v_at IS NULL OR v_at > v_observed THEN
    RAISE EXCEPTION 'Exact Price requested instant follows owner observation' USING ERRCODE = '22023';
  END IF;
  IF v_payload ->> 'outcome' <> 'EXACT_PRICE_CANDIDATE_SET_CURRENT' THEN
    RETURN QUERY SELECT v_payload;
    RETURN;
  END IF;
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

ALTER FUNCTION pricing.read_current_commercial_fee_set_v1(uuid, uuid, jsonb)
  RENAME TO read_current_commercial_fee_set_unobserved_v1;
REVOKE ALL ON FUNCTION pricing.read_current_commercial_fee_set_unobserved_v1(uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;
CREATE FUNCTION pricing.read_current_commercial_fee_set_v1(
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
  v_facts jsonb;
  v_record pricing.material_evidence_proof_receipts%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN RAISE EXCEPTION 'Commercial Fee proof scope mismatch' USING ERRCODE = '42501'; END IF;
  SELECT prior.payload INTO v_payload
    FROM pricing.read_current_commercial_fee_set_unobserved_v1(p_tenant_id, p_legal_entity_id, p_input) AS prior;
  IF v_at IS NULL OR v_at > v_observed THEN
    RAISE EXCEPTION 'Commercial Fee requested instant follows owner observation' USING ERRCODE = '22023';
  END IF;
  IF v_payload ->> 'outcome' <> 'COMMERCIAL_FEE_SET_CURRENT' THEN
    RETURN QUERY SELECT v_payload;
    RETURN;
  END IF;
  IF v_payload #>> '{authority,nextApplicabilityBoundary}' IS NOT NULL
    AND (v_payload #>> '{authority,nextApplicabilityBoundary}')::timestamptz <= v_observed
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'COMMERCIAL_FEE_SET_UNVERIFIABLE',
      'reason', 'Commercial Fee applicability changed before owner observation');
    RETURN;
  END IF;
  v_payload := jsonb_set(v_payload, '{authority,observedAt}', to_jsonb(v_observed_text));
  v_payload := jsonb_set(v_payload, '{feeSet,observedAt}', to_jsonb(v_observed_text));
  v_payload := jsonb_set(v_payload, '{feeSet,completenessEvidence,observedAt}', to_jsonb(v_observed_text));
  v_payload := jsonb_set(v_payload, '{feeSet,currentnessEvidence,observedAt}', to_jsonb(v_observed_text));
  v_payload := jsonb_set(v_payload, '{feeSet,currentnessEvidence,revalidatedAt}', to_jsonb(v_observed_text));
  v_authority := v_payload -> 'authority';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'factRef', fee.value #>> '{definition,feeRef,resourceId}',
    'factRevisionRef', fee.value #>> '{definition,revision,revisionId}',
    'verificationRef', v_authority ->> 'verificationRef')
    ORDER BY fee.value #>> '{definition,feeRef,resourceId}',
             fee.value #>> '{definition,revision,revisionId}'), '[]'::jsonb)
    INTO v_facts FROM jsonb_array_elements(v_payload #> '{feeSet,fees}') AS fee(value);
  v_payload := jsonb_set(v_payload, '{factProofs}', v_facts, true);
  INSERT INTO pricing.material_evidence_proof_receipts (
    tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at,
    owner_root_ref, owner_set_revision_ref, predicate_ref, generation, current_facts, query
  ) VALUES (
    p_tenant_id, p_legal_entity_id, 'COMMERCIAL_FEE', v_authority ->> 'verificationRef',
    v_observed_text::timestamptz, v_at, v_authority ->> 'ownerRootRef',
    v_authority ->> 'ownerRevision', v_authority ->> 'predicateRef',
    (v_authority ->> 'generation')::integer, v_facts, p_input
  ) ON CONFLICT (tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at) DO NOTHING;
  SELECT * INTO v_record FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'COMMERCIAL_FEE'
     AND receipt.verification_ref = v_authority ->> 'verificationRef'
     AND receipt.observed_at = v_observed_text::timestamptz
     AND receipt.effective_at = v_at;
  IF NOT FOUND OR v_record.current_facts <> v_facts OR v_record.query <> p_input
    OR v_record.owner_root_ref <> v_authority ->> 'ownerRootRef'
    OR v_record.owner_set_revision_ref <> v_authority ->> 'ownerRevision'
    OR v_record.predicate_ref <> v_authority ->> 'predicateRef'
    OR v_record.generation <> (v_authority ->> 'generation')::integer
  THEN RAISE EXCEPTION 'Commercial Fee proof receipt conflicts with owner read' USING ERRCODE = '23514'; END IF;
  RETURN QUERY SELECT v_payload;
END;
$function$;

ALTER FUNCTION pricing.read_current_zero_floor_authorization_set_v1(uuid, uuid, jsonb)
  RENAME TO read_current_zero_floor_authorization_set_unreceipted_v1;
REVOKE ALL ON FUNCTION pricing.read_current_zero_floor_authorization_set_unreceipted_v1(uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;
CREATE FUNCTION pricing.read_current_zero_floor_authorization_set_v1(
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

CREATE FUNCTION pricing.resolve_material_proof_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_receipt pricing.material_evidence_proof_receipts%ROWTYPE;
  v_expected jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN RAISE EXCEPTION 'Pricing material proof scope mismatch' USING ERRCODE = '42501'; END IF;
  IF p_input ->> 'family' NOT IN ('PRICE', 'COMMERCIAL_FEE', 'ZERO_FLOOR')
    OR jsonb_typeof(p_input -> 'expectedFacts') <> 'array'
    OR jsonb_typeof(p_input -> 'query') <> 'object'
  THEN RAISE EXCEPTION 'Pricing material proof request is invalid' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_receipt FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = p_input ->> 'family'
     AND receipt.verification_ref = p_input ->> 'evidenceVerificationRef'
     AND receipt.observed_at = (p_input ->> 'evidenceObservedAt')::timestamptz
     AND receipt.owner_root_ref = p_input ->> 'ownerRootRef'
     AND receipt.owner_set_revision_ref = p_input ->> 'ownerSetRevisionRef'
     AND receipt.predicate_ref = p_input ->> 'predicateRef'
     AND receipt.query = p_input -> 'query'
     AND receipt.effective_at = (p_input #>> '{query,effectiveAt}')::timestamptz;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(jsonb_agg(fact.value ORDER BY
    fact.value ->> 'factRef', fact.value ->> 'factRevisionRef',
    fact.value ->> 'verificationRef'), '[]'::jsonb)
    INTO v_expected FROM jsonb_array_elements(p_input -> 'expectedFacts') AS fact(value);
  IF v_expected <> v_receipt.current_facts
    OR jsonb_array_length(v_expected) > 500
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_expected) AS fact(value)
       WHERE fact.value ->> 'verificationRef' <> v_receipt.verification_ref
    )
  THEN RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', 'PRICING_MATERIAL_PROOF_RESOLVED',
    'currentFacts', v_receipt.current_facts,
    'evidenceInvalidationGeneration', v_receipt.generation,
    'evidenceVerificationRef', v_receipt.verification_ref,
    'observedAt', to_char(v_receipt.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ownerRootRef', v_receipt.owner_root_ref,
    'ownerSetRevisionRef', v_receipt.owner_set_revision_ref,
    'predicateRef', v_receipt.predicate_ref);
END;
$function$;

REVOKE ALL ON FUNCTION pricing.resolve_material_proof_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_exact_price_candidate_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_commercial_fee_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_zero_floor_authorization_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.resolve_material_proof_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_exact_price_candidate_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_commercial_fee_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_zero_floor_authorization_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
