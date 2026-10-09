-- #790 Pricing-owned complete Current Quantity Tier set authority.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

ALTER TABLE pricing.quantity_tier_set_roots FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_set_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_set_heads FORCE ROW LEVEL SECURITY;

WITH missing_roots AS (
  INSERT INTO pricing.quantity_tier_set_roots (
    quantity_tier_set_root_id,
    tenant_id,
    legal_entity_id,
    price_id,
    created_by_action_invocation_id,
    created_at
  )
  SELECT pg_catalog.gen_random_uuid(),
         price.tenant_id,
         price.legal_entity_id,
         price.price_id,
         price.created_by_action_invocation_id,
         price.created_at
    FROM pricing.prices AS price
  ON CONFLICT (tenant_id, legal_entity_id, price_id) DO NOTHING
  RETURNING tenant_id, legal_entity_id, price_id, quantity_tier_set_root_id,
            created_by_action_invocation_id, created_at
), all_roots AS (
  SELECT inserted.tenant_id,
         inserted.legal_entity_id,
         inserted.price_id,
         inserted.quantity_tier_set_root_id,
         inserted.created_by_action_invocation_id,
         inserted.created_at
    FROM missing_roots AS inserted
  UNION ALL
  SELECT existing.tenant_id,
         existing.legal_entity_id,
         existing.price_id,
         existing.quantity_tier_set_root_id,
         existing.created_by_action_invocation_id,
         existing.created_at
    FROM pricing.quantity_tier_set_roots AS existing
   WHERE NOT EXISTS (
     SELECT 1
       FROM missing_roots AS inserted
      WHERE inserted.tenant_id = existing.tenant_id
        AND inserted.legal_entity_id = existing.legal_entity_id
        AND inserted.price_id = existing.price_id
   )
), initial_revisions AS (
  INSERT INTO pricing.quantity_tier_set_revisions (
    quantity_tier_set_revision_id,
    tenant_id,
    legal_entity_id,
    price_id,
    quantity_tier_set_root_id,
    generation,
    previous_quantity_tier_set_revision_id,
    action_invocation_id,
    mutation_kind,
    recorded_at
  )
  SELECT pg_catalog.gen_random_uuid(),
         root.tenant_id,
         root.legal_entity_id,
         root.price_id,
         root.quantity_tier_set_root_id,
         1,
         NULL,
         root.created_by_action_invocation_id,
         'PRICE_CREATED',
         root.created_at
    FROM all_roots AS root
   WHERE NOT EXISTS (
     SELECT 1
       FROM pricing.quantity_tier_set_revisions AS revision
      WHERE revision.tenant_id = root.tenant_id
        AND revision.legal_entity_id = root.legal_entity_id
        AND revision.quantity_tier_set_root_id = root.quantity_tier_set_root_id
   )
  RETURNING tenant_id, legal_entity_id, price_id, quantity_tier_set_root_id,
            quantity_tier_set_revision_id, generation
)
INSERT INTO pricing.quantity_tier_set_heads (
  tenant_id,
  legal_entity_id,
  price_id,
  quantity_tier_set_root_id,
  quantity_tier_set_revision_id,
  generation
)
SELECT revision.tenant_id,
       revision.legal_entity_id,
       revision.price_id,
       revision.quantity_tier_set_root_id,
       revision.quantity_tier_set_revision_id,
       revision.generation
  FROM initial_revisions AS revision
 WHERE revision.generation = 1
ON CONFLICT (tenant_id, legal_entity_id, price_id) DO NOTHING;

CREATE FUNCTION pricing.ensure_quantity_tier_set_authority_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_root_id uuid := pg_catalog.gen_random_uuid();
  v_revision_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  INSERT INTO pricing.quantity_tier_set_roots (
    quantity_tier_set_root_id,
    tenant_id,
    legal_entity_id,
    price_id,
    created_by_action_invocation_id,
    created_at
  ) VALUES (
    v_root_id,
    NEW.tenant_id,
    NEW.legal_entity_id,
    NEW.price_id,
    NEW.created_by_action_invocation_id,
    NEW.created_at
  );
  INSERT INTO pricing.quantity_tier_set_revisions (
    quantity_tier_set_revision_id,
    tenant_id,
    legal_entity_id,
    price_id,
    quantity_tier_set_root_id,
    generation,
    previous_quantity_tier_set_revision_id,
    action_invocation_id,
    mutation_kind,
    recorded_at
  ) VALUES (
    v_revision_id,
    NEW.tenant_id,
    NEW.legal_entity_id,
    NEW.price_id,
    v_root_id,
    1,
    NULL,
    NEW.created_by_action_invocation_id,
    'PRICE_CREATED',
    NEW.created_at
  );
  INSERT INTO pricing.quantity_tier_set_heads (
    tenant_id,
    legal_entity_id,
    price_id,
    quantity_tier_set_root_id,
    quantity_tier_set_revision_id,
    generation
  ) VALUES (
    NEW.tenant_id,
    NEW.legal_entity_id,
    NEW.price_id,
    v_root_id,
    v_revision_id,
    1
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_prices_quantity_tier_set_authority_v1
AFTER INSERT ON pricing.prices
FOR EACH ROW EXECUTE FUNCTION pricing.ensure_quantity_tier_set_authority_v1();

CREATE FUNCTION pricing.guard_quantity_tier_set_head_advance_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.price_id IS DISTINCT FROM OLD.price_id
    OR NEW.quantity_tier_set_root_id IS DISTINCT FROM OLD.quantity_tier_set_root_id
    OR NEW.quantity_tier_set_head_id IS DISTINCT FROM OLD.quantity_tier_set_head_id
    OR NEW.generation <> OLD.generation + 1
    OR NOT EXISTS (
      SELECT 1
        FROM pricing.quantity_tier_set_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.price_id = OLD.price_id
         AND revision.quantity_tier_set_root_id = OLD.quantity_tier_set_root_id
         AND revision.quantity_tier_set_revision_id = NEW.quantity_tier_set_revision_id
         AND revision.generation = NEW.generation
         AND revision.previous_quantity_tier_set_revision_id = OLD.quantity_tier_set_revision_id
    )
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set generation must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_quantity_tier_set_heads_monotonic_v1
BEFORE UPDATE ON pricing.quantity_tier_set_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_quantity_tier_set_head_advance_v1();

CREATE FUNCTION pricing.advance_quantity_tier_set_generation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid,
  p_action_invocation_id uuid,
  p_mutation_kind text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_head record;
  v_revision_id uuid := pg_catalog.gen_random_uuid();
  v_updated_count integer;
BEGIN
  IF p_mutation_kind NOT IN ('TIER_DEFINED', 'TIER_REVISED') THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set mutation kind is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT head.quantity_tier_set_head_id,
         head.quantity_tier_set_root_id,
         head.quantity_tier_set_revision_id,
         head.generation
    INTO v_head
    FROM pricing.quantity_tier_set_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = p_price_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set authority is missing' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO pricing.quantity_tier_set_revisions (
    quantity_tier_set_revision_id,
    tenant_id,
    legal_entity_id,
    price_id,
    quantity_tier_set_root_id,
    generation,
    previous_quantity_tier_set_revision_id,
    action_invocation_id,
    mutation_kind
  ) VALUES (
    v_revision_id,
    p_tenant_id,
    p_legal_entity_id,
    p_price_id,
    v_head.quantity_tier_set_root_id,
    v_head.generation + 1,
    v_head.quantity_tier_set_revision_id,
    p_action_invocation_id,
    p_mutation_kind
  );
  UPDATE pricing.quantity_tier_set_heads
     SET quantity_tier_set_revision_id = v_revision_id,
         generation = v_head.generation + 1
   WHERE quantity_tier_set_head_id = v_head.quantity_tier_set_head_id
     AND quantity_tier_set_revision_id = v_head.quantity_tier_set_revision_id
     AND generation = v_head.generation;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set generation CAS failed' USING ERRCODE = '40001';
  END IF;
END;
$function$;

CREATE FUNCTION pricing.advance_quantity_tier_set_after_define_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM pricing.advance_quantity_tier_set_generation_v1(
    NEW.tenant_id,
    NEW.legal_entity_id,
    NEW.price_id,
    NEW.created_by_action_invocation_id,
    'TIER_DEFINED'
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_quantity_tiers_set_generation_v1
AFTER INSERT ON pricing.quantity_tiers
FOR EACH ROW EXECUTE FUNCTION pricing.advance_quantity_tier_set_after_define_v1();

CREATE FUNCTION pricing.advance_quantity_tier_set_after_revise_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_action_invocation_id uuid;
BEGIN
  IF NEW.quantity_tier_schedule_revision_id IS NOT DISTINCT FROM OLD.quantity_tier_schedule_revision_id THEN
    RETURN NEW;
  END IF;
  SELECT revision.action_invocation_id
    INTO STRICT v_action_invocation_id
    FROM pricing.quantity_tier_schedule_revisions AS revision
   WHERE revision.tenant_id = NEW.tenant_id
     AND revision.legal_entity_id = NEW.legal_entity_id
     AND revision.price_id = NEW.price_id
     AND revision.quantity_tier_id = NEW.quantity_tier_id
     AND revision.quantity_tier_schedule_revision_id = NEW.quantity_tier_schedule_revision_id;
  PERFORM pricing.advance_quantity_tier_set_generation_v1(
    NEW.tenant_id,
    NEW.legal_entity_id,
    NEW.price_id,
    v_action_invocation_id,
    'TIER_REVISED'
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_quantity_tier_schedule_heads_set_generation_v1
AFTER UPDATE OF quantity_tier_schedule_revision_id ON pricing.quantity_tier_schedule_heads
FOR EACH ROW EXECUTE FUNCTION pricing.advance_quantity_tier_set_after_revise_v1();

CREATE FUNCTION pricing.read_current_quantity_tier_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_price_ref jsonb := p_input -> 'priceRef';
  v_price_id uuid;
  v_effective_at timestamptz;
  v_head record;
  v_current_tiers jsonb;
  v_next_boundary timestamptz;
  v_observed_at text;
  v_predicate_ref text;
  v_completeness jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set read scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_price_id := (v_price_ref ->> 'resourceId')::uuid;
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set read input is invalid' USING ERRCODE = '22023';
  END;
  IF v_price_id IS NULL OR v_effective_at IS NULL
    OR v_price_ref ->> 'moduleId' <> 'commerce.pricing'
    OR v_price_ref ->> 'resourceType' <> 'commerce.pricing.price'
    OR v_price_ref ->> 'tenantId' <> p_tenant_id::text
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier set read input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT head.quantity_tier_set_root_id,
         head.quantity_tier_set_revision_id,
         head.generation
    INTO v_head
    FROM pricing.quantity_tier_set_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = v_price_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
        FROM pricing.prices AS price
       WHERE price.tenant_id = p_tenant_id
         AND price.legal_entity_id = p_legal_entity_id
         AND price.price_id = v_price_id
    ) THEN
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'QUANTITY_TIER_SET_AUTHORITY_UNAVAILABLE',
        'priceRef', v_price_ref,
        'reason', 'The exact Price exists without its required Quantity Tier set authority',
        'retryable', true
      );
    ELSE
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'QUANTITY_TIER_SET_PRICE_ABSENT',
        'priceRef', v_price_ref
      );
    END IF;
    RETURN;
  END IF;

  SELECT coalesce(
           jsonb_agg(
             pricing.scheduled_quantity_tier_revision_json_v1(
               p_tenant_id,
               p_legal_entity_id,
               tier.quantity_tier_id,
               entry.quantity_tier_revision_id,
               entry.effective_from,
               entry.effective_to
             ) ORDER BY tier.threshold_quantity, tier.quantity_tier_id
           ),
           '[]'::jsonb
         )
    INTO v_current_tiers
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
     AND entry.effective_from <= v_effective_at
     AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to);

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

  v_observed_at := to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_predicate_ref := 'commerce.pricing.current-quantity-tiers:' || v_price_id::text;
  v_completeness := jsonb_strip_nulls(jsonb_build_object(
    'nextApplicabilityBoundary', CASE WHEN v_next_boundary IS NULL THEN NULL ELSE
      to_char(v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observedAt', v_observed_at,
    'ownerRevision', v_head.quantity_tier_set_revision_id::text,
    'scope', jsonb_build_object('kind', 'EXACT_PREDICATE', 'predicateRef', v_predicate_ref)
  ));
  RETURN QUERY SELECT jsonb_build_object(
    'authority', jsonb_build_object(
      'generation', v_head.generation,
      'observedAt', v_observed_at,
      'ownerRootRef', v_head.quantity_tier_set_root_id::text,
      'ownerRevision', v_head.quantity_tier_set_revision_id::text,
      'predicateRef', v_predicate_ref,
      'verificationRef', 'commerce.pricing.quantity-tier-set-proof:' ||
        v_head.quantity_tier_set_root_id::text || ':' ||
        v_head.quantity_tier_set_revision_id::text || ':' || v_head.generation::text
    ),
    'outcome', 'QUANTITY_TIER_SET_CURRENT',
    'tierSet', jsonb_build_object(
      'completenessEvidence', v_completeness,
      'currentTiers', v_current_tiers,
      'priceRef', v_price_ref
    )
  );
END;
$function$;

CREATE FUNCTION pricing.verify_quantity_tier_set_generation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_price_id uuid;
  v_root_id uuid;
  v_revision_id uuid;
  v_generation integer;
  v_observed_at timestamptz;
  v_through timestamptz;
  v_verification_ref text;
  v_expected_verification_ref text;
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
    v_root_id := (p_input ->> 'ownerRootRef')::uuid;
    v_revision_id := (p_input ->> 'ownerRevision')::uuid;
    v_generation := (p_input ->> 'generation')::integer;
    v_observed_at := (p_input ->> 'observedAt')::timestamptz;
    v_through := (p_input ->> 'through')::timestamptz;
    v_verification_ref := p_input ->> 'verificationRef';
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Quantity Tier generation verification input is invalid' USING ERRCODE = '22023';
  END;
  IF v_price_id IS NULL OR v_root_id IS NULL OR v_revision_id IS NULL OR v_generation < 1
    OR v_observed_at IS NULL OR v_through < v_observed_at
    OR v_verification_ref IS NULL OR v_verification_ref <> btrim(v_verification_ref)
    OR p_input #>> '{priceRef,moduleId}' <> 'commerce.pricing'
    OR p_input #>> '{priceRef,resourceType}' <> 'commerce.pricing.price'
    OR p_input #>> '{priceRef,tenantId}' <> p_tenant_id::text
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier generation verification input is invalid' USING ERRCODE = '22023';
  END IF;
  v_expected_verification_ref := 'commerce.pricing.quantity-tier-set-proof:' ||
    v_root_id::text || ':' || v_revision_id::text || ':' || v_generation::text;
  IF v_verification_ref IS DISTINCT FROM v_expected_verification_ref THEN
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
  SELECT head.quantity_tier_set_root_id,
         head.quantity_tier_set_revision_id,
         head.generation
    INTO v_head
    FROM pricing.quantity_tier_set_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = v_price_id;
  IF NOT FOUND OR v_head.quantity_tier_set_root_id IS DISTINCT FROM v_root_id
    OR v_head.quantity_tier_set_revision_id IS DISTINCT FROM v_revision_id
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
         AND entry.effective_from > v_observed_at
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
         AND entry.effective_to > v_observed_at
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
    'ownerRootRef', v_root_id::text,
    'ownerRevision', v_revision_id::text,
    'verificationRef', v_verification_ref,
    'verifiedAt', to_char(v_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'verifiedThrough', to_char(v_through AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.ensure_quantity_tier_set_authority_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.guard_quantity_tier_set_head_advance_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.advance_quantity_tier_set_generation_v1(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.advance_quantity_tier_set_after_define_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.advance_quantity_tier_set_after_revise_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_quantity_tier_set_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.verify_quantity_tier_set_generation_v1(uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pricing.read_current_quantity_tier_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_quantity_tier_set_generation_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT SELECT, INSERT ON TABLE pricing.quantity_tier_set_roots,
  pricing.quantity_tier_set_revisions TO ontos_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.quantity_tier_set_heads TO ontos_runtime;
