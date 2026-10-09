-- Currency Support evidence must identify the exact owner observation. A value
-- revision is durable state identity, but it is not a receipt for a particular
-- Current read. These append-only receipts retain the complete owner result.
CREATE TABLE pricing.currency_support_proof_receipts (
  currency_support_proof_receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  verification_ref text NOT NULL,
  predicate_ref text NOT NULL,
  currency_support_id uuid NOT NULL,
  currency_support_revision_id uuid NOT NULL,
  currency_support_schedule_revision_id uuid NOT NULL,
  generation integer NOT NULL,
  schedule_revision integer NOT NULL,
  pricing_revision text NOT NULL,
  supported_currencies jsonb NOT NULL,
  fact_proofs jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  next_applicability_boundary timestamptz,
  observed_at timestamptz NOT NULL,
  CONSTRAINT pricing_currency_support_proof_ref_uk UNIQUE (tenant_id, verification_ref),
  CONSTRAINT pricing_currency_support_proof_value_fk FOREIGN KEY (
    tenant_id, currency_support_id, currency_support_revision_id
  ) REFERENCES pricing.currency_support_value_revisions (
    tenant_id, currency_support_id, currency_support_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT pricing_currency_support_proof_schedule_fk FOREIGN KEY (
    tenant_id, currency_support_id, currency_support_schedule_revision_id
  ) REFERENCES pricing.currency_support_schedule_revisions (
    tenant_id, currency_support_id, currency_support_schedule_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT pricing_currency_support_proof_generation_ck CHECK (generation > 0),
  CONSTRAINT pricing_currency_support_proof_schedule_ck CHECK (schedule_revision > 0),
  CONSTRAINT pricing_currency_support_proof_ref_ck CHECK (
    verification_ref = btrim(verification_ref)
    AND length(verification_ref) BETWEEN 1 AND 300
  ),
  CONSTRAINT pricing_currency_support_proof_predicate_ck CHECK (
    predicate_ref = btrim(predicate_ref)
    AND length(predicate_ref) BETWEEN 1 AND 1000
  ),
  CONSTRAINT pricing_currency_support_proof_currencies_ck CHECK (
    jsonb_typeof(supported_currencies) = 'array'
    AND jsonb_array_length(supported_currencies) > 0
  ),
  CONSTRAINT pricing_currency_support_proof_facts_ck CHECK (
    jsonb_typeof(fact_proofs) = 'array' AND jsonb_array_length(fact_proofs) = 1
  ),
  CONSTRAINT pricing_currency_support_proof_period_ck CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT pricing_currency_support_proof_effective_ck CHECK (
    effective_from <= effective_at
    AND (effective_to IS NULL OR effective_at < effective_to)
    AND effective_at <= observed_at
  ),
  CONSTRAINT pricing_currency_support_proof_boundary_ck CHECK (
    next_applicability_boundary IS NULL OR next_applicability_boundary > observed_at
  )
);

ALTER TABLE pricing.currency_support_proof_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.currency_support_proof_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_currency_support_proof_tenant_select
  ON pricing.currency_support_proof_receipts FOR SELECT TO PUBLIC
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
CREATE POLICY pricing_currency_support_proof_tenant_insert
  ON pricing.currency_support_proof_receipts FOR INSERT TO PUBLIC
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
CREATE POLICY pricing_currency_support_proof_tenant_update
  ON pricing.currency_support_proof_receipts FOR UPDATE TO PUBLIC
  USING (false) WITH CHECK (false);
CREATE POLICY pricing_currency_support_proof_tenant_delete
  ON pricing.currency_support_proof_receipts FOR DELETE TO PUBLIC
  USING (false);

CREATE FUNCTION pricing.issue_tenant_currency_support_proof_v1(
  p_tenant_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_observed_at timestamptz := pg_catalog.clock_timestamp();
  v_effective_at timestamptz;
  v_expected_support_id uuid;
  v_expected_revision_id uuid;
  v_expected_generation integer;
  v_expected_schedule_revision integer;
  v_current record;
  v_verification_ref text;
  v_predicate_ref text;
  v_currencies text;
  v_fact_proofs jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support proof scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support proof input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_expected_support_id := (p_input ->> 'supportId')::uuid;
    v_expected_revision_id := (p_input ->> 'supportRevisionId')::uuid;
    v_expected_generation := (p_input ->> 'generation')::integer;
    v_expected_schedule_revision := (p_input ->> 'scheduleRevision')::integer;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Currency Support proof input is invalid' USING ERRCODE = '22023';
  END;
  IF v_effective_at IS NULL OR v_effective_at > v_observed_at
    OR v_expected_support_id IS NULL OR v_expected_revision_id IS NULL
    OR v_expected_generation IS NULL OR v_expected_generation < 1
    OR v_expected_schedule_revision IS NULL OR v_expected_schedule_revision < 1
    OR p_input <> pg_catalog.jsonb_build_object(
      'effectiveAt', p_input ->> 'effectiveAt',
      'generation', v_expected_generation,
      'scheduleRevision', v_expected_schedule_revision,
      'supportId', v_expected_support_id::text,
      'supportRevisionId', v_expected_revision_id::text
    )
  THEN
    RAISE EXCEPTION 'Pricing Currency Support proof input is invalid' USING ERRCODE = '22023';
  END IF;

  WITH current_candidates AS (
    SELECT head.currency_support_schedule_revision_id,
           revision.pricing_revision, revision.supported_currencies,
           entry.effective_from, entry.effective_to,
           count(*) OVER () AS candidate_count
      FROM pricing.currency_support_schedule_heads AS head
      JOIN pricing.currency_support_schedule_revisions AS schedule
        ON schedule.tenant_id = head.tenant_id
       AND schedule.currency_support_id = head.currency_support_id
       AND schedule.currency_support_schedule_revision_id = head.currency_support_schedule_revision_id
      JOIN pricing.currency_support_schedule_entries AS entry
        ON entry.tenant_id = head.tenant_id
       AND entry.currency_support_id = head.currency_support_id
       AND entry.currency_support_schedule_revision_id = head.currency_support_schedule_revision_id
      JOIN pricing.currency_support_value_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.currency_support_id = entry.currency_support_id
       AND revision.currency_support_revision_id = entry.currency_support_revision_id
     WHERE head.tenant_id = p_tenant_id
       AND head.currency_support_id = v_expected_support_id
       AND head.schedule_revision = v_expected_schedule_revision
       AND revision.currency_support_revision_id = v_expected_revision_id
       AND revision.generation = v_expected_generation
       AND entry.effective_from <= v_effective_at
       AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
       AND entry.effective_from <= v_observed_at
       AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to)
  )
  SELECT candidate.currency_support_schedule_revision_id,
         candidate.pricing_revision, candidate.supported_currencies,
         candidate.effective_from, candidate.effective_to
    INTO v_current
    FROM current_candidates AS candidate
   WHERE candidate.candidate_count = 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'observedAt', pg_catalog.to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', 'CURRENCY_SUPPORT_PROOF_STALE'
    );
    RETURN;
  END IF;

  SELECT pg_catalog.string_agg(value, ',' ORDER BY value)
    INTO v_currencies
    FROM pg_catalog.jsonb_array_elements_text(v_current.supported_currencies) AS currency(value);
  v_verification_ref := 'commerce.pricing.currency-support-proof:' || pg_catalog.gen_random_uuid()::text;
  v_predicate_ref := 'commerce.pricing.current-supported-currencies:' || p_tenant_id::text || ':' ||
    v_expected_support_id::text || ':' || v_expected_revision_id::text || ':' || v_currencies;
  v_fact_proofs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'factRef', v_expected_support_id::text,
    'factRevisionRef', v_expected_revision_id::text,
    'verificationRef', v_verification_ref
  ));

  INSERT INTO pricing.currency_support_proof_receipts (
    tenant_id, verification_ref, predicate_ref, currency_support_id,
    currency_support_revision_id, currency_support_schedule_revision_id,
    generation, schedule_revision, pricing_revision, supported_currencies, fact_proofs,
    effective_at, effective_from, effective_to, next_applicability_boundary, observed_at
  ) VALUES (
    p_tenant_id, v_verification_ref, v_predicate_ref, v_expected_support_id,
    v_expected_revision_id, v_current.currency_support_schedule_revision_id,
    v_expected_generation, v_expected_schedule_revision, v_current.pricing_revision,
    v_current.supported_currencies, v_fact_proofs, v_effective_at, v_current.effective_from,
    v_current.effective_to, v_current.effective_to, v_observed_at
  );

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'effectiveAt', pg_catalog.to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectivePeriod', pg_catalog.jsonb_build_object(
      'effectiveFrom', pg_catalog.to_char(v_current.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN v_current.effective_to IS NULL THEN NULL ELSE pg_catalog.to_char(
        v_current.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'factProofs', v_fact_proofs,
    'generation', v_expected_generation,
    'observedAt', pg_catalog.to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'outcome', 'CURRENCY_SUPPORT_PROOF_ISSUED',
    'predicateRef', v_predicate_ref,
    'pricingRevision', v_current.pricing_revision,
    'scheduleRevision', v_expected_schedule_revision,
    'supportedCurrencies', v_current.supported_currencies,
    'supportId', v_expected_support_id::text,
    'supportRevisionId', v_expected_revision_id::text,
    'tenantId', p_tenant_id::text,
    'verificationRef', v_verification_ref
  ) || CASE WHEN v_current.effective_to IS NULL THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object(
    'nextApplicabilityBoundary', pg_catalog.to_char(
      v_current.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  ) END;
END;
$function$;

CREATE FUNCTION pricing.resolve_tenant_currency_support_proof_v1(
  p_tenant_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_ref text := p_input ->> 'verificationRef';
  v_receipt record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support proof scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_input) <> 'object' OR v_ref IS NULL
    OR length(v_ref) > 300
    OR p_input <> pg_catalog.jsonb_build_object('verificationRef', v_ref)
  THEN
    RAISE EXCEPTION 'Pricing Currency Support proof lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT receipt.* INTO v_receipt
    FROM pricing.currency_support_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.verification_ref = v_ref;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'CURRENCY_SUPPORT_PROOF_UNKNOWN');
    RETURN;
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'effectiveAt', pg_catalog.to_char(v_receipt.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectivePeriod', pg_catalog.jsonb_build_object(
      'effectiveFrom', pg_catalog.to_char(v_receipt.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN v_receipt.effective_to IS NULL THEN NULL ELSE pg_catalog.to_char(
        v_receipt.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'factProofs', v_receipt.fact_proofs,
    'generation', v_receipt.generation,
    'observedAt', pg_catalog.to_char(v_receipt.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'outcome', 'CURRENCY_SUPPORT_PROOF_RESOLVED',
    'predicateRef', v_receipt.predicate_ref,
    'pricingRevision', v_receipt.pricing_revision,
    'scheduleRevision', v_receipt.schedule_revision,
    'supportedCurrencies', v_receipt.supported_currencies,
    'supportId', v_receipt.currency_support_id::text,
    'supportRevisionId', v_receipt.currency_support_revision_id::text,
    'tenantId', v_receipt.tenant_id::text,
    'verificationRef', v_receipt.verification_ref
  ) || CASE WHEN v_receipt.next_applicability_boundary IS NULL THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object(
    'nextApplicabilityBoundary', pg_catalog.to_char(
      v_receipt.next_applicability_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  ) END;
END;
$function$;

REVOKE ALL ON TABLE pricing.currency_support_proof_receipts FROM PUBLIC;
REVOKE ALL ON TABLE pricing.currency_support_proof_receipts FROM ontos_runtime;
REVOKE ALL ON FUNCTION pricing.issue_tenant_currency_support_proof_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.resolve_tenant_currency_support_proof_v1(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.issue_tenant_currency_support_proof_v1(uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.resolve_tenant_currency_support_proof_v1(uuid, jsonb) TO ontos_runtime;
