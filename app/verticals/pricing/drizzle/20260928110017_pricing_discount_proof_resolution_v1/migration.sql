-- #790/#797 durable Contractual Discount owner proofs over the shared Pricing proof ledger.
ALTER FUNCTION pricing.read_current_contractual_discount_set_v1(uuid, uuid, jsonb)
  RENAME TO read_current_contractual_discount_set_unproofed_v1;
REVOKE ALL ON FUNCTION pricing.read_current_contractual_discount_set_unproofed_v1(uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;

CREATE FUNCTION pricing.read_current_contractual_discount_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_effective_at timestamptz := (p_input ->> 'effectiveAt')::timestamptz;
  v_observed_at timestamptz;
  v_head record;
  v_members jsonb;
  v_next_boundary timestamptz;
  v_predicate_ref text;
  v_owner_root_ref text;
  v_owner_revision_ref text;
  v_verification_ref text := 'pricing:contractual-discount-set-proof:' || public.gen_random_uuid()::text;
  v_fact_proofs jsonb;
  v_authority jsonb;
  v_completeness jsonb;
  v_initialized boolean;
  v_generation integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Contractual Discount proof read scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR p_input #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RAISE EXCEPTION 'Contractual Discount proof predicate is invalid' USING ERRCODE = '22023';
  END IF;

  -- Writers take the exclusive form of this lock before advancing the set head.
  -- Holding its shared form makes the head, member schedules, and durable receipt
  -- one coherent owner observation even under READ COMMITTED.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'contractual-discount-set:' || p_tenant_id::text || ':' || p_legal_entity_id::text, 0
  ));
  v_observed_at := date_trunc('milliseconds', clock_timestamp());
  IF v_effective_at IS NULL OR v_effective_at > v_observed_at THEN
    RAISE EXCEPTION 'Contractual Discount proof predicate is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT head.contractual_discount_set_root_id,
         head.contractual_discount_set_revision_id,
         head.generation
    INTO v_head
    FROM pricing.contractual_discount_set_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id;
  v_initialized := FOUND;

  WITH matching_schedules AS (
    SELECT pricing.contractual_discount_schedule_at_v1(revision.schedule, v_effective_at) AS schedule
      FROM pricing.contractual_discounts AS discount
      JOIN pricing.contractual_discount_schedule_heads AS schedule_head
        ON schedule_head.tenant_id = discount.tenant_id
       AND schedule_head.legal_entity_id = discount.legal_entity_id
       AND schedule_head.discount_id = discount.discount_id
      JOIN pricing.contractual_discount_revisions AS revision
        ON revision.contractual_discount_revision_id = schedule_head.contractual_discount_revision_id
     WHERE discount.tenant_id = p_tenant_id
       AND discount.legal_entity_id = p_legal_entity_id
       AND discount.identity_key ->> 'family' = 'CONTRACTUAL_DISCOUNT'
       AND discount.identity_key ->> 'currencyCode' = p_input ->> 'currencyCode'
       AND pricing.canonicalize_management_json_v1(discount.identity_key -> 'commercialScope') =
           pricing.canonicalize_management_json_v1(p_input -> 'commercialScope')
       AND pricing.canonicalize_management_json_v1(discount.identity_key -> 'basis') =
           pricing.canonicalize_management_json_v1(p_input -> 'basis')
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_input -> 'audiences') AS audience(value)
          WHERE pricing.canonicalize_management_json_v1(value) =
                pricing.canonicalize_management_json_v1(discount.identity_key -> 'audience')
       )
  ), current_members AS (
    SELECT schedule -> 'current' AS member FROM matching_schedules WHERE schedule ? 'current'
  ), boundaries AS (
    SELECT (revision #>> '{effectivePeriod,effectiveFrom}')::timestamptz AS boundary
      FROM matching_schedules, LATERAL jsonb_array_elements(schedule -> 'revisions') AS revision
     WHERE (revision #>> '{effectivePeriod,effectiveFrom}')::timestamptz > v_effective_at
    UNION ALL
    SELECT (revision #>> '{effectivePeriod,effectiveTo}')::timestamptz
      FROM matching_schedules, LATERAL jsonb_array_elements(schedule -> 'revisions') AS revision
     WHERE revision #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb
       AND (revision #>> '{effectivePeriod,effectiveTo}')::timestamptz > v_effective_at
  )
  SELECT
    COALESCE((SELECT jsonb_agg(member ORDER BY member #>> '{definition,discountId}') FROM current_members), '[]'::jsonb),
    (SELECT min(boundary) FROM boundaries)
  INTO v_members, v_next_boundary;

  v_predicate_ref := pricing.contractual_discount_predicate_ref_v1(p_input);
  IF v_initialized THEN
    v_generation := v_head.generation;
    v_owner_root_ref := 'pricing:contractual-discount-set:' ||
      v_head.contractual_discount_set_root_id::text;
    v_owner_revision_ref := 'pricing:contractual-discount-set-revision:' ||
      v_head.contractual_discount_set_revision_id::text;
  ELSE
    -- A tenant/legal-entity with no Discount mutation has a real, observable empty
    -- owner set. Its explicit uninitialized authority becomes stale as soon as the
    -- first set head is created; no Action or stored mutation is fabricated.
    v_generation := 1;
    v_owner_root_ref := 'pricing:contractual-discount-set:uninitialized:' ||
      p_tenant_id::text || ':' || p_legal_entity_id::text;
    v_owner_revision_ref := 'pricing:contractual-discount-set-revision:uninitialized';
  END IF;
  v_completeness := jsonb_build_object(
    'observedAt', pricing.management_instant_v1(v_observed_at),
    'ownerRevision', v_owner_revision_ref,
    'scope', jsonb_build_object('kind', 'EXACT_PREDICATE', 'predicateRef', v_predicate_ref)
  );
  IF v_next_boundary IS NOT NULL THEN
    IF v_next_boundary <= v_observed_at THEN
      RAISE EXCEPTION 'Contractual Discount applicability changed before owner observation' USING ERRCODE = 'P0001';
    END IF;
    v_completeness := v_completeness || jsonb_build_object(
      'nextApplicabilityBoundary', pricing.management_instant_v1(v_next_boundary)
    );
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'factRef', member #>> '{definition,discountId}',
    'factRevisionRef', member #>> '{definition,revision,revisionId}',
    'verificationRef', 'pricing:contractual-discount-revision-proof:' ||
      (member #>> '{definition,revision,revisionId}')
  ) ORDER BY member #>> '{definition,discountId}'), '[]'::jsonb)
  INTO v_fact_proofs
  FROM jsonb_array_elements(v_members) AS member;

  v_authority := jsonb_build_object(
    'generation', v_generation,
    'observedAt', pricing.management_instant_v1(v_observed_at),
    'ownerRevision', v_owner_revision_ref,
    'ownerRootRef', v_owner_root_ref,
    'predicateRef', v_predicate_ref,
    'verificationRef', v_verification_ref,
    'verifiedAt', pricing.management_instant_v1(v_observed_at)
  );
  INSERT INTO pricing.material_evidence_proof_receipts (
    tenant_id, legal_entity_id, family, verification_ref, observed_at, effective_at,
    owner_root_ref, owner_set_revision_ref, predicate_ref, generation, current_facts, query
  ) VALUES (
    p_tenant_id, p_legal_entity_id, 'DISCOUNT', v_verification_ref, v_observed_at, v_effective_at,
    v_owner_root_ref, v_owner_revision_ref, v_predicate_ref, v_generation, v_fact_proofs, p_input
  );

  RETURN QUERY SELECT jsonb_build_object(
    'authority', v_authority,
    'completenessEvidence', v_completeness,
    'currentDiscounts', v_members,
    'factProofs', v_fact_proofs,
    'predicate', p_input
  );
END;
$function$;

CREATE FUNCTION pricing.resolve_contractual_discount_set_proof_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_receipt record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Contractual Discount proof resolution scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT receipt.* INTO STRICT v_receipt
    FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'DISCOUNT'
     AND receipt.verification_ref = p_input ->> 'verificationRef';

  RETURN QUERY SELECT jsonb_build_object(
    'authority', jsonb_build_object(
      'generation', v_receipt.generation,
      'observedAt', pricing.management_instant_v1(v_receipt.observed_at),
      'ownerRevision', v_receipt.owner_set_revision_ref,
      'ownerRootRef', v_receipt.owner_root_ref,
      'predicateRef', v_receipt.predicate_ref,
      'verificationRef', v_receipt.verification_ref,
      'verifiedAt', pricing.management_instant_v1(v_receipt.observed_at)
    ),
    'currentFacts', v_receipt.current_facts,
    'outcome', 'CONTRACTUAL_DISCOUNT_SET_PROOF_RESOLVED',
    'predicate', v_receipt.query
  );
EXCEPTION WHEN no_data_found OR too_many_rows THEN
  RAISE EXCEPTION 'Contractual Discount set proof is absent or ambiguous' USING ERRCODE = 'P0002';
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.verify_contractual_discount_set_generation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authority jsonb := p_input -> 'authority';
  v_predicate jsonb := p_input -> 'predicate';
  v_effective_at timestamptz := (p_input #>> '{predicate,effectiveAt}')::timestamptz;
  v_through timestamptz := (p_input ->> 'through')::timestamptz;
  v_receipt record;
  v_head record;
  v_current boolean := false;
  v_expected_predicate_ref text;
  v_next_boundary timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Contractual Discount generation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_predicate ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_predicate #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RAISE EXCEPTION 'Contractual Discount generation request is invalid' USING ERRCODE = '22023';
  END IF;
  v_expected_predicate_ref := pricing.contractual_discount_predicate_ref_v1(v_predicate);

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'contractual-discount-set:' || p_tenant_id::text || ':' || p_legal_entity_id::text, 0
  ));
  IF v_effective_at IS NULL
    OR v_through IS NULL
    OR v_effective_at > (v_authority ->> 'observedAt')::timestamptz
    OR v_through < (v_authority ->> 'observedAt')::timestamptz
    OR v_through > clock_timestamp()
  THEN
    RAISE EXCEPTION 'Contractual Discount generation request is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT receipt.* INTO v_receipt
    FROM pricing.material_evidence_proof_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.family = 'DISCOUNT'
     AND receipt.verification_ref = v_authority ->> 'verificationRef'
     AND receipt.observed_at = (v_authority ->> 'observedAt')::timestamptz
     AND receipt.effective_at = v_effective_at
     AND receipt.owner_root_ref = v_authority ->> 'ownerRootRef'
     AND receipt.owner_set_revision_ref = v_authority ->> 'ownerRevision'
     AND receipt.predicate_ref = v_expected_predicate_ref
     AND receipt.generation = (v_authority ->> 'generation')::integer
     AND pricing.canonicalize_management_json_v1(receipt.query) =
         pricing.canonicalize_management_json_v1(v_predicate);
  IF FOUND AND v_authority ->> 'verifiedAt' = v_authority ->> 'observedAt' THEN
    SELECT head.contractual_discount_set_root_id,
           head.contractual_discount_set_revision_id,
           head.generation
      INTO v_head
      FROM pricing.contractual_discount_set_heads AS head
     WHERE head.tenant_id = p_tenant_id
       AND head.legal_entity_id = p_legal_entity_id;
    IF FOUND THEN
      v_current := v_authority ->> 'ownerRootRef' = 'pricing:contractual-discount-set:' ||
          v_head.contractual_discount_set_root_id::text
        AND v_authority ->> 'ownerRevision' = 'pricing:contractual-discount-set-revision:' ||
          v_head.contractual_discount_set_revision_id::text
        AND (v_authority ->> 'generation')::integer = v_head.generation;
    ELSE
      v_current := v_authority ->> 'ownerRootRef' =
          'pricing:contractual-discount-set:uninitialized:' ||
            p_tenant_id::text || ':' || p_legal_entity_id::text
        AND v_authority ->> 'ownerRevision' =
          'pricing:contractual-discount-set-revision:uninitialized'
        AND (v_authority ->> 'generation')::integer = 1;
    END IF;
  END IF;

  IF v_current THEN
    WITH matching_revisions AS (
      SELECT revision.value
        FROM pricing.contractual_discounts AS discount
        JOIN pricing.contractual_discount_schedule_heads AS schedule_head
          ON schedule_head.tenant_id = discount.tenant_id
         AND schedule_head.legal_entity_id = discount.legal_entity_id
         AND schedule_head.discount_id = discount.discount_id
        JOIN pricing.contractual_discount_revisions AS stored
          ON stored.contractual_discount_revision_id = schedule_head.contractual_discount_revision_id
        CROSS JOIN LATERAL jsonb_array_elements(stored.schedule -> 'revisions') AS revision(value)
       WHERE discount.tenant_id = p_tenant_id
         AND discount.legal_entity_id = p_legal_entity_id
         AND discount.identity_key ->> 'family' = 'CONTRACTUAL_DISCOUNT'
         AND discount.identity_key ->> 'currencyCode' = v_predicate ->> 'currencyCode'
         AND pricing.canonicalize_management_json_v1(discount.identity_key -> 'commercialScope') =
             pricing.canonicalize_management_json_v1(v_predicate -> 'commercialScope')
         AND pricing.canonicalize_management_json_v1(discount.identity_key -> 'basis') =
             pricing.canonicalize_management_json_v1(v_predicate -> 'basis')
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_predicate -> 'audiences') AS audience(value)
            WHERE pricing.canonicalize_management_json_v1(audience.value) =
                  pricing.canonicalize_management_json_v1(discount.identity_key -> 'audience')
         )
    )
    SELECT min(boundary) INTO v_next_boundary FROM (
      SELECT (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz AS boundary
        FROM matching_revisions
       WHERE (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz > v_effective_at
      UNION ALL
      SELECT (value #>> '{effectivePeriod,effectiveTo}')::timestamptz
        FROM matching_revisions
       WHERE value #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb
         AND (value #>> '{effectivePeriod,effectiveTo}')::timestamptz > v_effective_at
    ) AS boundaries;
    IF v_next_boundary IS NOT NULL AND v_through >= v_next_boundary THEN
      v_current := false;
    END IF;
  END IF;

  IF v_current THEN
    RETURN QUERY SELECT jsonb_build_object(
      'authority', v_authority,
      'outcome', 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT',
      'verifiedThrough', pricing.management_instant_v1(v_through)
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CHANGED',
      'verifiedThrough', pricing.management_instant_v1(v_through)
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_current_contractual_discount_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.resolve_contractual_discount_set_proof_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.verify_contractual_discount_set_generation_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_current_contractual_discount_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.resolve_contractual_discount_set_proof_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_contractual_discount_set_generation_v1(uuid, uuid, jsonb) TO ontos_runtime;
