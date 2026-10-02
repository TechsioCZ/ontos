-- Tier Current-set authority is issued as an opaque, durable owner receipt.
-- The public reader retains the exact proof on the set carried through selection.
ALTER FUNCTION pricing.read_current_quantity_tier_set_v1(uuid, uuid, jsonb)
  RENAME TO read_current_quantity_tier_set_unreceipted_v1;
REVOKE ALL ON FUNCTION pricing.read_current_quantity_tier_set_unreceipted_v1(uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;

CREATE FUNCTION pricing.read_current_quantity_tier_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_payload jsonb;
  v_authority jsonb;
  v_facts jsonb;
  v_observed_at timestamptz := date_trunc('milliseconds', statement_timestamp());
  v_effective_at timestamptz;
  v_price_id uuid;
  v_verification_ref text := 'commerce.pricing.quantity-tier-set-proof:' || pg_catalog.gen_random_uuid()::text;
  v_receipt pricing.material_evidence_proof_receipts%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set receipt scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_price_id := (p_input #>> '{priceRef,resourceId}')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set receipt input is invalid' USING ERRCODE = '22023';
  END;
  IF pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR v_effective_at IS NULL OR v_effective_at > v_observed_at
    OR v_price_id IS NULL
    OR p_input -> 'priceRef' IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', v_price_id::text,
      'resourceType', 'commerce.pricing.price',
      'tenantId', p_tenant_id::text
    )
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set receipt input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT prior.payload
    INTO STRICT v_payload
    FROM pricing.read_current_quantity_tier_set_unreceipted_v1(
      p_tenant_id, p_legal_entity_id, p_input
    ) AS prior;
  IF v_payload ->> 'outcome' <> 'QUANTITY_TIER_SET_CURRENT' THEN
    RETURN QUERY SELECT v_payload;
    RETURN;
  END IF;

  IF v_payload #>> '{tierSet,completenessEvidence,nextApplicabilityBoundary}' IS NOT NULL
    AND (v_payload #>> '{tierSet,completenessEvidence,nextApplicabilityBoundary}')::timestamptz <= v_observed_at
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_AUTHORITY_UNAVAILABLE',
      'priceRef', p_input -> 'priceRef',
      'reason', 'Quantity Tier applicability changed before owner observation',
      'retryable', true
    );
    RETURN;
  END IF;

  v_authority := jsonb_build_object(
    'generation', (v_payload #>> '{authority,generation}')::integer,
    'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ownerRevision', v_payload #>> '{authority,ownerRevision}',
    'ownerRootRef', v_payload #>> '{authority,ownerRootRef}',
    'predicateRef', v_payload #>> '{authority,predicateRef}',
    'verificationRef', v_verification_ref
  );

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'factRef', revision.quantity_tier_id::text,
           'factRevisionRef', revision.quantity_tier_revision_id::text,
           'verificationRef', v_verification_ref
         ) ORDER BY revision.quantity_tier_id, revision.quantity_tier_revision_id), '[]'::jsonb)
    INTO v_facts
    FROM jsonb_array_elements(v_payload #> '{tierSet,currentTiers}') AS current_tier(value)
    JOIN pricing.quantity_tier_revisions AS revision
      ON revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.price_id = v_price_id
     AND revision.quantity_tier_revision_id =
       (current_tier.value #>> '{definition,revision,revisionId}')::uuid;

  IF jsonb_array_length(v_facts) <> jsonb_array_length(v_payload #> '{tierSet,currentTiers}') THEN
    RAISE EXCEPTION 'Pricing Quantity Tier proof facts are incomplete' USING ERRCODE = '23514';
  END IF;

  v_payload := jsonb_set(v_payload, '{authority}', v_authority);
  v_payload := jsonb_set(v_payload, '{tierSet,authority}', v_authority);
  v_payload := jsonb_set(v_payload, '{tierSet,factProofs}', v_facts);
  v_payload := jsonb_set(
    v_payload,
    '{tierSet,completenessEvidence,observedAt}',
    to_jsonb(to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  );

  INSERT INTO pricing.material_evidence_proof_receipts (
    tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at,
    owner_root_ref, owner_set_revision_ref, predicate_ref, generation, current_facts, query
  ) VALUES (
    p_tenant_id, p_legal_entity_id, 'QUANTITY_TIER', v_verification_ref,
    v_observed_at, v_effective_at,
    v_authority ->> 'ownerRootRef', v_authority ->> 'ownerRevision',
    v_authority ->> 'predicateRef', (v_authority ->> 'generation')::integer,
    v_facts, p_input
  );

  SELECT *
    INTO STRICT v_receipt
    FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'QUANTITY_TIER'
     AND receipt.verification_ref = v_verification_ref
     AND receipt.observed_at = v_observed_at;
  IF v_receipt.current_facts <> v_facts
    OR v_receipt.query <> p_input
    OR v_receipt.effective_at <> v_effective_at
    OR v_receipt.owner_root_ref <> v_authority ->> 'ownerRootRef'
    OR v_receipt.owner_set_revision_ref <> v_authority ->> 'ownerRevision'
    OR v_receipt.predicate_ref <> v_authority ->> 'predicateRef'
    OR v_receipt.generation <> (v_authority ->> 'generation')::integer
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier proof receipt conflicts with owner read' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT v_payload;
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.verify_quantity_tier_set_generation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_price_id uuid;
  v_root_id text := p_input ->> 'ownerRootRef';
  v_revision_id text := p_input ->> 'ownerRevision';
  v_generation integer;
  v_effective_at timestamptz;
  v_observed_at timestamptz;
  v_predicate_ref text := p_input ->> 'predicateRef';
  v_through timestamptz;
  v_verification_ref text := p_input ->> 'verificationRef';
  v_verified_at timestamptz := statement_timestamp();
  v_next_boundary timestamptz;
  v_head record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier generation verification scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_price_id := (p_input #>> '{priceRef,resourceId}')::uuid;
    v_generation := (p_input ->> 'generation')::integer;
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_observed_at := (p_input ->> 'observedAt')::timestamptz;
    v_through := (p_input ->> 'through')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Quantity Tier generation verification input is invalid' USING ERRCODE = '22023';
  END;
  IF pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR v_price_id IS NULL OR v_root_id IS NULL OR v_revision_id IS NULL
    OR v_generation IS NULL OR v_generation < 1
    OR v_effective_at IS NULL OR v_observed_at IS NULL OR v_through IS NULL
    OR v_through < v_observed_at
    OR v_predicate_ref IS NULL OR v_predicate_ref <> btrim(v_predicate_ref)
    OR length(v_predicate_ref) NOT BETWEEN 1 AND 1000
    OR pg_catalog.jsonb_typeof(p_input -> 'verificationRef') IS DISTINCT FROM 'string'
    OR v_verification_ref IS NULL OR v_verification_ref <> btrim(v_verification_ref)
    OR length(v_verification_ref) NOT BETWEEN 1 AND 1000
    OR p_input -> 'priceRef' IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', v_price_id::text,
      'resourceType', 'commerce.pricing.price',
      'tenantId', p_tenant_id::text
    )
    OR p_input IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'effectiveAt', p_input -> 'effectiveAt',
      'generation', p_input -> 'generation',
      'observedAt', p_input -> 'observedAt',
      'ownerRevision', p_input -> 'ownerRevision',
      'ownerRootRef', p_input -> 'ownerRootRef',
      'predicateRef', p_input -> 'predicateRef',
      'priceRef', p_input -> 'priceRef',
      'through', p_input -> 'through',
      'verificationRef', p_input -> 'verificationRef'
    )
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier generation verification input is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pricing.material_evidence_proof_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id
       AND receipt.legal_entity_id = p_legal_entity_id
       AND receipt.family = 'QUANTITY_TIER'
       AND receipt.verification_ref = v_verification_ref
       AND receipt.observed_at = v_observed_at
       AND receipt.effective_at = v_effective_at
       AND receipt.owner_root_ref = v_root_id
       AND receipt.owner_set_revision_ref = v_revision_id
       AND receipt.predicate_ref = v_predicate_ref
       AND receipt.generation = v_generation
       AND receipt.query = jsonb_build_object(
         'effectiveAt', p_input -> 'effectiveAt',
         'priceRef', p_input -> 'priceRef'
       )
  ) THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_GENERATION_UNVERIFIABLE',
      'reason', 'VERIFICATION_REFERENCE_MISMATCH',
      'verifiedAt', to_char(v_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  IF v_through > v_verified_at THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_GENERATION_UNVERIFIABLE',
      'reason', 'THROUGH_NOT_YET_OBSERVABLE',
      'verifiedAt', to_char(v_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  SELECT head.quantity_tier_set_root_id::text AS root_ref,
         head.quantity_tier_set_revision_id::text AS revision_ref,
         head.generation
    INTO v_head
    FROM pricing.quantity_tier_set_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = v_price_id;
  IF NOT FOUND OR v_head.root_ref IS DISTINCT FROM v_root_id
    OR v_head.revision_ref IS DISTINCT FROM v_revision_id
    OR v_head.generation IS DISTINCT FROM v_generation
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_GENERATION_CHANGED',
      'verifiedAt', to_char(v_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  SELECT min(boundary)
    INTO v_next_boundary
    FROM (
      SELECT entry.effective_from AS boundary
        FROM pricing.quantity_tiers AS tier
        JOIN pricing.quantity_tier_schedule_heads AS schedule_head
          ON schedule_head.tenant_id = tier.tenant_id
         AND schedule_head.legal_entity_id = tier.legal_entity_id
         AND schedule_head.price_id = tier.price_id
         AND schedule_head.quantity_tier_id = tier.quantity_tier_id
        JOIN pricing.quantity_tier_schedule_entries AS entry
          ON entry.tenant_id = schedule_head.tenant_id
         AND entry.legal_entity_id = schedule_head.legal_entity_id
         AND entry.price_id = schedule_head.price_id
         AND entry.quantity_tier_id = schedule_head.quantity_tier_id
         AND entry.quantity_tier_schedule_revision_id = schedule_head.quantity_tier_schedule_revision_id
       WHERE tier.tenant_id = p_tenant_id
         AND tier.legal_entity_id = p_legal_entity_id
         AND tier.price_id = v_price_id
         AND entry.effective_from > v_effective_at
      UNION ALL
      SELECT entry.effective_to AS boundary
        FROM pricing.quantity_tiers AS tier
        JOIN pricing.quantity_tier_schedule_heads AS schedule_head
          ON schedule_head.tenant_id = tier.tenant_id
         AND schedule_head.legal_entity_id = tier.legal_entity_id
         AND schedule_head.price_id = tier.price_id
         AND schedule_head.quantity_tier_id = tier.quantity_tier_id
        JOIN pricing.quantity_tier_schedule_entries AS entry
          ON entry.tenant_id = schedule_head.tenant_id
         AND entry.legal_entity_id = schedule_head.legal_entity_id
         AND entry.price_id = schedule_head.price_id
         AND entry.quantity_tier_id = schedule_head.quantity_tier_id
         AND entry.quantity_tier_schedule_revision_id = schedule_head.quantity_tier_schedule_revision_id
       WHERE tier.tenant_id = p_tenant_id
         AND tier.legal_entity_id = p_legal_entity_id
         AND tier.price_id = v_price_id
         AND entry.effective_to > v_effective_at
    ) AS boundaries;
  IF v_next_boundary IS NOT NULL AND v_through >= v_next_boundary THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_GENERATION_CHANGED',
      'verifiedAt', to_char(v_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'generation', v_generation,
    'outcome', 'QUANTITY_TIER_SET_GENERATION_CURRENT',
    'ownerRootRef', v_root_id,
    'ownerRevision', v_revision_id,
    'verificationRef', v_verification_ref,
    'verifiedAt', to_char(v_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'verifiedThrough', to_char(v_through AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

CREATE FUNCTION pricing.resolve_quantity_tier_set_proof_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_price_ref jsonb := p_input -> 'priceRef';
  v_price_id uuid;
  v_effective_at timestamptz;
  v_verification_ref text := p_input ->> 'verificationRef';
  v_receipt pricing.material_evidence_proof_receipts%ROWTYPE;
  v_authority jsonb;
  v_current_tiers jsonb;
  v_next_boundary timestamptz;
  v_completeness jsonb;
  v_tier_set jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier proof resolution scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_price_id := (v_price_ref ->> 'resourceId')::uuid;
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Quantity Tier proof resolution input is invalid' USING ERRCODE = '22023';
  END;
  IF pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR v_price_id IS NULL OR v_effective_at IS NULL
    OR pg_catalog.jsonb_typeof(p_input -> 'verificationRef') IS DISTINCT FROM 'string'
    OR v_verification_ref IS NULL OR v_verification_ref <> btrim(v_verification_ref)
    OR length(v_verification_ref) NOT BETWEEN 1 AND 1000
    OR v_price_ref IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', v_price_id::text,
      'resourceType', 'commerce.pricing.price',
      'tenantId', p_tenant_id::text
    )
    OR p_input IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'effectiveAt', p_input -> 'effectiveAt',
      'priceRef', v_price_ref,
      'verificationRef', p_input -> 'verificationRef'
    )
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier proof resolution input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_receipt
    FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'QUANTITY_TIER'
     AND receipt.verification_ref = v_verification_ref
     AND receipt.effective_at = v_effective_at
     AND receipt.query = jsonb_build_object('effectiveAt', p_input -> 'effectiveAt', 'priceRef', v_price_ref);
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_PROOF_ABSENT',
      'priceRef', v_price_ref,
      'verificationRef', v_verification_ref
    );
    RETURN;
  END IF;

  WITH fact AS (
    SELECT value,
           (value ->> 'factRef')::uuid AS quantity_tier_id,
           (value ->> 'factRevisionRef')::uuid AS quantity_tier_revision_id
      FROM jsonb_array_elements(v_receipt.current_facts)
  ), historical_schedule AS (
    SELECT fact.quantity_tier_id,
           fact.quantity_tier_revision_id,
           schedule.quantity_tier_schedule_revision_id
      FROM fact
      JOIN LATERAL (
        SELECT revision.quantity_tier_schedule_revision_id
          FROM pricing.quantity_tier_schedule_revisions AS revision
         WHERE revision.tenant_id = p_tenant_id
           AND revision.legal_entity_id = p_legal_entity_id
           AND revision.price_id = v_price_id
           AND revision.quantity_tier_id = fact.quantity_tier_id
           AND revision.recorded_at <= v_receipt.observed_at
         ORDER BY revision.schedule_revision DESC
         LIMIT 1
      ) AS schedule ON true
  )
  SELECT coalesce(jsonb_agg(
           pricing.scheduled_quantity_tier_revision_json_v1(
             p_tenant_id,
             p_legal_entity_id,
             historical.quantity_tier_id,
             historical.quantity_tier_revision_id,
             entry.effective_from,
             entry.effective_to
           ) ORDER BY tier.threshold_quantity, historical.quantity_tier_id
         ), '[]'::jsonb)
    INTO v_current_tiers
    FROM historical_schedule AS historical
    JOIN pricing.quantity_tier_schedule_entries AS entry
      ON entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = v_price_id
     AND entry.quantity_tier_id = historical.quantity_tier_id
     AND entry.quantity_tier_schedule_revision_id = historical.quantity_tier_schedule_revision_id
     AND entry.quantity_tier_revision_id = historical.quantity_tier_revision_id
     AND entry.effective_from <= v_effective_at
     AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
    JOIN pricing.quantity_tiers AS tier
      ON tier.tenant_id = entry.tenant_id
     AND tier.legal_entity_id = entry.legal_entity_id
     AND tier.price_id = entry.price_id
     AND tier.quantity_tier_id = entry.quantity_tier_id;

  IF jsonb_array_length(v_current_tiers) <> jsonb_array_length(v_receipt.current_facts) THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_SET_PROOF_ABSENT',
      'priceRef', v_price_ref,
      'verificationRef', v_verification_ref
    );
    RETURN;
  END IF;

  WITH historical_heads AS (
    SELECT tier.quantity_tier_id,
           schedule.quantity_tier_schedule_revision_id
      FROM pricing.quantity_tiers AS tier
      JOIN LATERAL (
        SELECT revision.quantity_tier_schedule_revision_id
          FROM pricing.quantity_tier_schedule_revisions AS revision
         WHERE revision.tenant_id = tier.tenant_id
           AND revision.legal_entity_id = tier.legal_entity_id
           AND revision.price_id = tier.price_id
           AND revision.quantity_tier_id = tier.quantity_tier_id
           AND revision.recorded_at <= v_receipt.observed_at
         ORDER BY revision.schedule_revision DESC
         LIMIT 1
      ) AS schedule ON true
     WHERE tier.tenant_id = p_tenant_id
       AND tier.legal_entity_id = p_legal_entity_id
       AND tier.price_id = v_price_id
       AND tier.created_at <= v_receipt.observed_at
  )
  SELECT min(boundary)
    INTO v_next_boundary
    FROM (
      SELECT entry.effective_from AS boundary
        FROM historical_heads AS head
        JOIN pricing.quantity_tier_schedule_entries AS entry
          ON entry.tenant_id = p_tenant_id
         AND entry.legal_entity_id = p_legal_entity_id
         AND entry.price_id = v_price_id
         AND entry.quantity_tier_id = head.quantity_tier_id
         AND entry.quantity_tier_schedule_revision_id = head.quantity_tier_schedule_revision_id
       WHERE entry.effective_from > v_effective_at
      UNION ALL
      SELECT entry.effective_to AS boundary
        FROM historical_heads AS head
        JOIN pricing.quantity_tier_schedule_entries AS entry
          ON entry.tenant_id = p_tenant_id
         AND entry.legal_entity_id = p_legal_entity_id
         AND entry.price_id = v_price_id
         AND entry.quantity_tier_id = head.quantity_tier_id
         AND entry.quantity_tier_schedule_revision_id = head.quantity_tier_schedule_revision_id
       WHERE entry.effective_to > v_effective_at
    ) AS boundaries;

  v_authority := jsonb_build_object(
    'generation', v_receipt.generation,
    'observedAt', to_char(v_receipt.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ownerRevision', v_receipt.owner_set_revision_ref,
    'ownerRootRef', v_receipt.owner_root_ref,
    'predicateRef', v_receipt.predicate_ref,
    'verificationRef', v_receipt.verification_ref
  );
  v_completeness := jsonb_strip_nulls(jsonb_build_object(
    'nextApplicabilityBoundary', CASE WHEN v_next_boundary IS NULL THEN NULL ELSE
      to_char(v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observedAt', to_char(v_receipt.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ownerRevision', v_receipt.owner_set_revision_ref,
    'scope', jsonb_build_object('kind', 'EXACT_PREDICATE', 'predicateRef', v_receipt.predicate_ref)
  ));
  v_tier_set := jsonb_build_object(
    'authority', v_authority,
    'completenessEvidence', v_completeness,
    'currentTiers', v_current_tiers,
    'factProofs', v_receipt.current_facts,
    'priceRef', v_price_ref
  );

  RETURN QUERY SELECT jsonb_build_object(
    'authority', v_authority,
    'currentFacts', v_receipt.current_facts,
    'outcome', 'QUANTITY_TIER_SET_PROOF_RESOLVED',
    'tierSet', v_tier_set
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_current_quantity_tier_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.verify_quantity_tier_set_generation_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.resolve_quantity_tier_set_proof_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_current_quantity_tier_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_quantity_tier_set_generation_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.resolve_quantity_tier_set_proof_v1(uuid, uuid, jsonb) TO ontos_runtime;
