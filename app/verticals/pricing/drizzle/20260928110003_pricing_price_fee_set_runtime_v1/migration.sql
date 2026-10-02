-- #797 complete-set authority for exact Price candidates and Commercial Fees.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pricing_management_routine_writer'
  ) THEN
    CREATE ROLE pricing_management_routine_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE pricing_management_routine_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$role$;

ALTER TABLE pricing.price_candidate_set_roots FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_candidate_set_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_candidate_set_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_set_roots FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_set_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_set_heads FORCE ROW LEVEL SECURITY;

-- Existing owner facts receive one persistent baseline. Reads never create these roots.
DO $migration$
DECLARE
  v_price record;
  v_root_id uuid;
  v_revision_id uuid;
  v_fee_root_id uuid;
  v_fee_revision_id uuid;
BEGIN
  FOR v_price IN
    SELECT price.* FROM pricing.prices AS price ORDER BY price.tenant_id, price.price_id
  LOOP
    INSERT INTO pricing.price_candidate_set_roots (
      price_candidate_set_root_id, tenant_id, legal_entity_id, catalog_selection,
      channel_id, market_id, currency_code, unit_ref, basis_quantity,
      price_group_selector, created_by_action_invocation_id, created_at
    ) VALUES (
      pg_catalog.gen_random_uuid(), v_price.tenant_id, v_price.legal_entity_id,
      v_price.catalog_selection, v_price.channel_id, v_price.market_id,
      v_price.currency_code, v_price.unit_ref, v_price.basis_quantity,
      v_price.price_group_selector, v_price.created_by_action_invocation_id, v_price.created_at
    )
    ON CONFLICT (tenant_id, catalog_selection, legal_entity_id, channel_id, market_id,
                 currency_code, unit_ref, basis_quantity, price_group_selector)
    DO NOTHING
    RETURNING price_candidate_set_root_id INTO v_root_id;

    IF v_root_id IS NOT NULL THEN
      v_revision_id := pg_catalog.gen_random_uuid();
      INSERT INTO pricing.price_candidate_set_revisions (
        price_candidate_set_revision_id, tenant_id, legal_entity_id,
        price_candidate_set_root_id, generation, previous_price_candidate_set_revision_id,
        action_invocation_id, mutation_kind, recorded_at
      ) VALUES (
        v_revision_id, v_price.tenant_id, v_price.legal_entity_id, v_root_id, 1, NULL,
        v_price.created_by_action_invocation_id, 'PRICE_DEFINED', v_price.created_at
      );
      INSERT INTO pricing.price_candidate_set_heads (
        tenant_id, legal_entity_id, price_candidate_set_root_id,
        price_candidate_set_revision_id, generation
      ) VALUES (v_price.tenant_id, v_price.legal_entity_id, v_root_id, v_revision_id, 1);
    END IF;

    v_root_id := NULL;
    IF v_price.channel_id IN ('B2C', 'B2B') THEN
      INSERT INTO pricing.fee_set_roots (
        fee_set_root_id, tenant_id, legal_entity_id, variant_ref, channel_id,
        market_id, currency_code, monetary_boundary, created_by_action_invocation_id, created_at
      ) VALUES (
        pg_catalog.gen_random_uuid(), v_price.tenant_id, v_price.legal_entity_id,
        v_price.catalog_selection -> 'variantRef', v_price.channel_id, v_price.market_id,
        v_price.currency_code, 'PRE_TAX', v_price.created_by_action_invocation_id, v_price.created_at
      )
      ON CONFLICT (tenant_id, legal_entity_id, variant_ref, channel_id, market_id,
                   currency_code, monetary_boundary)
      DO NOTHING
      RETURNING fee_set_root_id INTO v_fee_root_id;
      IF v_fee_root_id IS NOT NULL THEN
        v_fee_revision_id := pg_catalog.gen_random_uuid();
        INSERT INTO pricing.fee_set_revisions (
          fee_set_revision_id, tenant_id, legal_entity_id, fee_set_root_id, generation,
          previous_fee_set_revision_id, action_invocation_id, mutation_kind, recorded_at
        ) VALUES (
          v_fee_revision_id, v_price.tenant_id, v_price.legal_entity_id, v_fee_root_id, 1,
          NULL, v_price.created_by_action_invocation_id, 'PRICE_PREDICATE_INITIALIZED', v_price.created_at
        );
        INSERT INTO pricing.fee_set_heads (
          tenant_id, legal_entity_id, fee_set_root_id, fee_set_revision_id, generation
        ) VALUES (v_price.tenant_id, v_price.legal_entity_id, v_fee_root_id, v_fee_revision_id, 1);
      END IF;
    END IF;
    v_fee_root_id := NULL;
  END LOOP;

  FOR v_price IN
    SELECT fee.* FROM pricing.fees AS fee ORDER BY fee.tenant_id, fee.fee_id
  LOOP
    INSERT INTO pricing.fee_set_roots (
      fee_set_root_id, tenant_id, legal_entity_id, variant_ref, channel_id,
      market_id, currency_code, monetary_boundary, created_by_action_invocation_id, created_at
    ) VALUES (
      pg_catalog.gen_random_uuid(), v_price.tenant_id, v_price.legal_entity_id,
      v_price.variant_ref, v_price.channel_id, v_price.market_id, v_price.currency_code,
      v_price.monetary_boundary, v_price.created_by_action_invocation_id, v_price.created_at
    )
    ON CONFLICT (tenant_id, legal_entity_id, variant_ref, channel_id, market_id,
                 currency_code, monetary_boundary)
    DO NOTHING
    RETURNING fee_set_root_id INTO v_fee_root_id;
    IF v_fee_root_id IS NOT NULL THEN
      v_fee_revision_id := pg_catalog.gen_random_uuid();
      INSERT INTO pricing.fee_set_revisions (
        fee_set_revision_id, tenant_id, legal_entity_id, fee_set_root_id, generation,
        previous_fee_set_revision_id, action_invocation_id, mutation_kind, recorded_at
      ) VALUES (
        v_fee_revision_id, v_price.tenant_id, v_price.legal_entity_id, v_fee_root_id, 1,
        NULL, v_price.created_by_action_invocation_id, 'FEE_DEFINED', v_price.created_at
      );
      INSERT INTO pricing.fee_set_heads (
        tenant_id, legal_entity_id, fee_set_root_id, fee_set_revision_id, generation
      ) VALUES (v_price.tenant_id, v_price.legal_entity_id, v_fee_root_id, v_fee_revision_id, 1);
    END IF;
    v_fee_root_id := NULL;
  END LOOP;
END;
$migration$;

CREATE FUNCTION pricing.guard_price_candidate_set_head_advance_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.price_candidate_set_root_id IS DISTINCT FROM OLD.price_candidate_set_root_id
    OR NEW.price_candidate_set_head_id IS DISTINCT FROM OLD.price_candidate_set_head_id
    OR NEW.generation <> OLD.generation + 1
    OR NOT EXISTS (
      SELECT 1 FROM pricing.price_candidate_set_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.price_candidate_set_root_id = OLD.price_candidate_set_root_id
         AND revision.price_candidate_set_revision_id = NEW.price_candidate_set_revision_id
         AND revision.generation = NEW.generation
         AND revision.previous_price_candidate_set_revision_id = OLD.price_candidate_set_revision_id
    )
  THEN
    RAISE EXCEPTION 'Price candidate-set generation must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_price_candidate_set_heads_monotonic_v1
BEFORE UPDATE ON pricing.price_candidate_set_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_price_candidate_set_head_advance_v1();

CREATE FUNCTION pricing.guard_fee_set_head_advance_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.fee_set_root_id IS DISTINCT FROM OLD.fee_set_root_id
    OR NEW.fee_set_head_id IS DISTINCT FROM OLD.fee_set_head_id
    OR NEW.generation <> OLD.generation + 1
    OR NOT EXISTS (
      SELECT 1 FROM pricing.fee_set_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.fee_set_root_id = OLD.fee_set_root_id
         AND revision.fee_set_revision_id = NEW.fee_set_revision_id
         AND revision.generation = NEW.generation
         AND revision.previous_fee_set_revision_id = OLD.fee_set_revision_id
    )
  THEN
    RAISE EXCEPTION 'Commercial Fee set generation must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_fee_set_heads_monotonic_v1
BEFORE UPDATE ON pricing.fee_set_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_fee_set_head_advance_v1();

CREATE FUNCTION pricing.advance_price_candidate_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_price_id uuid,
  p_action_invocation_id uuid, p_mutation_kind text
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_head record;
  v_revision_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_mutation_kind NOT IN ('PRICE_SCHEDULE_CHANGED', 'PRICE_SOURCE_CHANGED') THEN
    RAISE EXCEPTION 'Price candidate-set mutation kind is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT head.* INTO v_head
    FROM pricing.price_candidate_set_heads AS head
    JOIN pricing.price_candidate_set_roots AS root
      ON root.tenant_id = head.tenant_id
     AND root.legal_entity_id = head.legal_entity_id
     AND root.price_candidate_set_root_id = head.price_candidate_set_root_id
    JOIN pricing.prices AS price
      ON price.tenant_id = root.tenant_id
     AND price.legal_entity_id = root.legal_entity_id
     AND price.catalog_selection = root.catalog_selection
     AND price.channel_id = root.channel_id
     AND price.market_id = root.market_id
     AND price.currency_code = root.currency_code
     AND price.unit_ref = root.unit_ref
     AND price.basis_quantity = root.basis_quantity
     AND price.price_group_selector = root.price_group_selector
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = p_price_id
   FOR UPDATE OF head;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Price candidate-set authority is missing' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.price_candidate_set_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.price_candidate_set_root_id = v_head.price_candidate_set_root_id
       AND revision.action_invocation_id = p_action_invocation_id
  ) THEN
    RETURN;
  END IF;
  INSERT INTO pricing.price_candidate_set_revisions (
    price_candidate_set_revision_id, tenant_id, legal_entity_id, price_candidate_set_root_id,
    generation, previous_price_candidate_set_revision_id, action_invocation_id, mutation_kind
  ) VALUES (
    v_revision_id, p_tenant_id, p_legal_entity_id, v_head.price_candidate_set_root_id,
    v_head.generation + 1, v_head.price_candidate_set_revision_id, p_action_invocation_id, p_mutation_kind
  );
  UPDATE pricing.price_candidate_set_heads
     SET price_candidate_set_revision_id = v_revision_id, generation = v_head.generation + 1
   WHERE price_candidate_set_head_id = v_head.price_candidate_set_head_id
     AND generation = v_head.generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Price candidate-set generation changed concurrently' USING ERRCODE = '40001';
  END IF;
END;
$function$;

CREATE FUNCTION pricing.advance_fee_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_fee_id uuid,
  p_action_invocation_id uuid, p_mutation_kind text
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_head record;
  v_revision_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_mutation_kind NOT IN ('FEE_DEFINED', 'FEE_SCHEDULE_CHANGED') THEN
    RAISE EXCEPTION 'Commercial Fee set mutation kind is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT head.* INTO v_head
    FROM pricing.fee_set_heads AS head
    JOIN pricing.fee_set_roots AS root
      ON root.tenant_id = head.tenant_id
     AND root.legal_entity_id = head.legal_entity_id
     AND root.fee_set_root_id = head.fee_set_root_id
    JOIN pricing.fees AS fee
      ON fee.tenant_id = root.tenant_id
     AND fee.legal_entity_id = root.legal_entity_id
     AND fee.variant_ref = root.variant_ref
     AND fee.channel_id = root.channel_id
     AND fee.market_id = root.market_id
     AND fee.currency_code = root.currency_code
     AND fee.monetary_boundary = root.monetary_boundary
   WHERE fee.tenant_id = p_tenant_id
     AND fee.legal_entity_id = p_legal_entity_id
     AND fee.fee_id = p_fee_id
   FOR UPDATE OF head;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commercial Fee set authority is missing' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.fee_set_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.fee_set_root_id = v_head.fee_set_root_id
       AND revision.action_invocation_id = p_action_invocation_id
  ) THEN
    RETURN;
  END IF;
  INSERT INTO pricing.fee_set_revisions (
    fee_set_revision_id, tenant_id, legal_entity_id, fee_set_root_id, generation,
    previous_fee_set_revision_id, action_invocation_id, mutation_kind
  ) VALUES (
    v_revision_id, p_tenant_id, p_legal_entity_id, v_head.fee_set_root_id,
    v_head.generation + 1, v_head.fee_set_revision_id, p_action_invocation_id, p_mutation_kind
  );
  UPDATE pricing.fee_set_heads
     SET fee_set_revision_id = v_revision_id, generation = v_head.generation + 1
   WHERE fee_set_head_id = v_head.fee_set_head_id
     AND generation = v_head.generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commercial Fee set generation changed concurrently' USING ERRCODE = '40001';
  END IF;
END;
$function$;

CREATE FUNCTION pricing.initialize_price_and_fee_set_authority_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_root_id uuid := pg_catalog.gen_random_uuid();
  v_revision_id uuid := pg_catalog.gen_random_uuid();
  v_fee_root_id uuid;
  v_fee_revision_id uuid;
BEGIN
  INSERT INTO pricing.price_candidate_set_roots (
    price_candidate_set_root_id, tenant_id, legal_entity_id, catalog_selection,
    channel_id, market_id, currency_code, unit_ref, basis_quantity,
    price_group_selector, created_by_action_invocation_id, created_at
  ) VALUES (
    v_root_id, NEW.tenant_id, NEW.legal_entity_id, NEW.catalog_selection,
    NEW.channel_id, NEW.market_id, NEW.currency_code, NEW.unit_ref, NEW.basis_quantity,
    NEW.price_group_selector, NEW.created_by_action_invocation_id, NEW.created_at
  );
  INSERT INTO pricing.price_candidate_set_revisions (
    price_candidate_set_revision_id, tenant_id, legal_entity_id, price_candidate_set_root_id,
    generation, previous_price_candidate_set_revision_id, action_invocation_id,
    mutation_kind, recorded_at
  ) VALUES (
    v_revision_id, NEW.tenant_id, NEW.legal_entity_id, v_root_id, 1, NULL,
    NEW.created_by_action_invocation_id, 'PRICE_DEFINED', NEW.created_at
  );
  INSERT INTO pricing.price_candidate_set_heads (
    tenant_id, legal_entity_id, price_candidate_set_root_id,
    price_candidate_set_revision_id, generation
  ) VALUES (NEW.tenant_id, NEW.legal_entity_id, v_root_id, v_revision_id, 1);

  IF NEW.channel_id IN ('B2C', 'B2B') THEN
    INSERT INTO pricing.fee_set_roots (
      fee_set_root_id, tenant_id, legal_entity_id, variant_ref, channel_id,
      market_id, currency_code, monetary_boundary, created_by_action_invocation_id, created_at
    ) VALUES (
      pg_catalog.gen_random_uuid(), NEW.tenant_id, NEW.legal_entity_id,
      NEW.catalog_selection -> 'variantRef', NEW.channel_id, NEW.market_id,
      NEW.currency_code, 'PRE_TAX', NEW.created_by_action_invocation_id, NEW.created_at
    )
    ON CONFLICT (tenant_id, legal_entity_id, variant_ref, channel_id, market_id,
                 currency_code, monetary_boundary)
    DO NOTHING
    RETURNING fee_set_root_id INTO v_fee_root_id;
    IF v_fee_root_id IS NOT NULL THEN
      v_fee_revision_id := pg_catalog.gen_random_uuid();
      INSERT INTO pricing.fee_set_revisions (
        fee_set_revision_id, tenant_id, legal_entity_id, fee_set_root_id, generation,
        previous_fee_set_revision_id, action_invocation_id, mutation_kind, recorded_at
      ) VALUES (
        v_fee_revision_id, NEW.tenant_id, NEW.legal_entity_id, v_fee_root_id, 1, NULL,
        NEW.created_by_action_invocation_id, 'PRICE_PREDICATE_INITIALIZED', NEW.created_at
      );
      INSERT INTO pricing.fee_set_heads (
        tenant_id, legal_entity_id, fee_set_root_id, fee_set_revision_id, generation
      ) VALUES (NEW.tenant_id, NEW.legal_entity_id, v_fee_root_id, v_fee_revision_id, 1);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_prices_candidate_and_fee_set_authority_v1
AFTER INSERT ON pricing.prices
FOR EACH ROW EXECUTE FUNCTION pricing.initialize_price_and_fee_set_authority_v1();

CREATE FUNCTION pricing.advance_price_candidate_set_after_schedule_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_action_invocation_id uuid;
BEGIN
  IF NEW.price_schedule_revision_id IS NOT DISTINCT FROM OLD.price_schedule_revision_id THEN
    RETURN NEW;
  END IF;
  SELECT revision.action_invocation_id INTO STRICT v_action_invocation_id
    FROM pricing.price_schedule_revisions AS revision
   WHERE revision.tenant_id = NEW.tenant_id
     AND revision.legal_entity_id = NEW.legal_entity_id
     AND revision.price_id = NEW.price_id
     AND revision.price_schedule_revision_id = NEW.price_schedule_revision_id;
  PERFORM pricing.advance_price_candidate_set_generation_v1(
    NEW.tenant_id, NEW.legal_entity_id, NEW.price_id,
    v_action_invocation_id, 'PRICE_SCHEDULE_CHANGED'
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_price_schedule_heads_candidate_set_v1
AFTER UPDATE OF price_schedule_revision_id ON pricing.price_schedule_heads
FOR EACH ROW EXECUTE FUNCTION pricing.advance_price_candidate_set_after_schedule_v1();

CREATE FUNCTION pricing.advance_price_candidate_set_after_source_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM pricing.advance_price_candidate_set_generation_v1(
    NEW.tenant_id, NEW.legal_entity_id, NEW.price_id,
    NEW.action_invocation_id, 'PRICE_SOURCE_CHANGED'
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_price_source_assertions_candidate_set_v1
AFTER INSERT ON pricing.price_source_assertions
FOR EACH ROW EXECUTE FUNCTION pricing.advance_price_candidate_set_after_source_v1();

CREATE FUNCTION pricing.initialize_or_advance_fee_set_after_define_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_root_id uuid;
  v_revision_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  INSERT INTO pricing.fee_set_roots (
    fee_set_root_id, tenant_id, legal_entity_id, variant_ref, channel_id,
    market_id, currency_code, monetary_boundary, created_by_action_invocation_id, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(), NEW.tenant_id, NEW.legal_entity_id, NEW.variant_ref,
    NEW.channel_id, NEW.market_id, NEW.currency_code, NEW.monetary_boundary,
    NEW.created_by_action_invocation_id, NEW.created_at
  )
  ON CONFLICT (tenant_id, legal_entity_id, variant_ref, channel_id, market_id,
               currency_code, monetary_boundary)
  DO NOTHING
  RETURNING fee_set_root_id INTO v_root_id;
  IF v_root_id IS NOT NULL THEN
    INSERT INTO pricing.fee_set_revisions (
      fee_set_revision_id, tenant_id, legal_entity_id, fee_set_root_id, generation,
      previous_fee_set_revision_id, action_invocation_id, mutation_kind, recorded_at
    ) VALUES (
      v_revision_id, NEW.tenant_id, NEW.legal_entity_id, v_root_id, 1, NULL,
      NEW.created_by_action_invocation_id, 'FEE_DEFINED', NEW.created_at
    );
    INSERT INTO pricing.fee_set_heads (
      tenant_id, legal_entity_id, fee_set_root_id, fee_set_revision_id, generation
    ) VALUES (NEW.tenant_id, NEW.legal_entity_id, v_root_id, v_revision_id, 1);
  ELSE
    PERFORM pricing.advance_fee_set_generation_v1(
      NEW.tenant_id, NEW.legal_entity_id, NEW.fee_id,
      NEW.created_by_action_invocation_id, 'FEE_DEFINED'
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_fees_set_authority_v1
AFTER INSERT ON pricing.fees
FOR EACH ROW EXECUTE FUNCTION pricing.initialize_or_advance_fee_set_after_define_v1();

CREATE FUNCTION pricing.advance_fee_set_after_schedule_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_action_invocation_id uuid;
BEGIN
  IF NEW.fee_schedule_revision_id IS NOT DISTINCT FROM OLD.fee_schedule_revision_id THEN
    RETURN NEW;
  END IF;
  SELECT revision.action_invocation_id INTO STRICT v_action_invocation_id
    FROM pricing.fee_schedule_revisions AS revision
   WHERE revision.tenant_id = NEW.tenant_id
     AND revision.legal_entity_id = NEW.legal_entity_id
     AND revision.fee_id = NEW.fee_id
     AND revision.fee_schedule_revision_id = NEW.fee_schedule_revision_id;
  PERFORM pricing.advance_fee_set_generation_v1(
    NEW.tenant_id, NEW.legal_entity_id, NEW.fee_id,
    v_action_invocation_id, 'FEE_SCHEDULE_CHANGED'
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_fee_schedule_heads_set_authority_v1
AFTER UPDATE OF fee_schedule_revision_id ON pricing.fee_schedule_heads
FOR EACH ROW EXECUTE FUNCTION pricing.advance_fee_set_after_schedule_v1();

CREATE FUNCTION pricing.read_exact_price_candidate_set_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_key jsonb := p_input -> 'exactKey';
  v_effective_at timestamptz;
  v_root record;
  v_head record;
  v_candidates jsonb := '[]'::jsonb;
  v_raw_count integer := 0;
  v_valid_count integer := 0;
  v_next_boundary timestamptz;
  v_observed_at text;
  v_authority jsonb;
  v_outcome text;
  v_matching_price_count integer;
  v_schedule_head_count integer;
  v_canonical_key jsonb;
  v_predicate_digest text;
  v_basis_quantity numeric;
  v_stored_basis_quantity numeric(38,9);
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Exact Price candidate-set scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_basis_quantity := (v_key #>> '{unitBasis,quantity}')::numeric;
    v_stored_basis_quantity := (v_key #>> '{unitBasis,quantity}')::numeric(38,9);
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Exact Price candidate-set input is invalid' USING ERRCODE = '22023';
  END;
  IF v_effective_at IS NULL OR v_basis_quantity<=0 OR v_basis_quantity<>v_stored_basis_quantity
    OR jsonb_typeof(v_key) <> 'object'
    OR v_key #>> '{catalogSelection,productRef,tenantId}' <> p_tenant_id::text
    OR v_key #>> '{catalogSelection,variantRef,tenantId}' <> p_tenant_id::text
    OR v_key #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
  THEN
    RAISE EXCEPTION 'Exact Price candidate-set input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT root.* INTO v_root
    FROM pricing.price_candidate_set_roots AS root
   WHERE root.tenant_id = p_tenant_id
     AND root.legal_entity_id = p_legal_entity_id
     AND root.catalog_selection = v_key -> 'catalogSelection'
     AND root.channel_id = v_key #>> '{commercialScope,channelId}'
     AND root.market_id = v_key #>> '{commercialScope,marketId}'
     AND root.currency_code = v_key ->> 'currencyCode'
     AND root.unit_ref = v_key #> '{unitBasis,unitRef}'
     AND root.basis_quantity = v_stored_basis_quantity
     AND root.price_group_selector = v_key -> 'priceGroupSelector';
  IF NOT FOUND THEN
    SELECT count(*)::integer INTO v_matching_price_count FROM pricing.prices AS price
     WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
       AND price.catalog_selection=v_key->'catalogSelection'
       AND price.channel_id=v_key#>>'{commercialScope,channelId}'
       AND price.market_id=v_key#>>'{commercialScope,marketId}'
       AND price.currency_code=v_key->>'currencyCode'
       AND price.unit_ref=v_key#>'{unitBasis,unitRef}'
       AND price.basis_quantity=v_stored_basis_quantity
       AND price.price_group_selector=v_key->'priceGroupSelector';
    IF v_matching_price_count > 0 THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'effectiveAt', p_input ->> 'effectiveAt', 'exactKey', v_key,
        'outcome', 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
        'reason', 'An exact Price exists without its persistent candidate-set authority'
      );
      RETURN;
    END IF;
    v_canonical_key := pg_catalog.jsonb_set(
      v_key, '{unitBasis,quantity}',
      pg_catalog.to_jsonb(v_stored_basis_quantity::text), false
    );
    v_predicate_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(v_canonical_key::text,'UTF8'),'sha256'),'hex');
    v_observed_at := pg_catalog.to_char(v_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_authority := pg_catalog.jsonb_build_object(
      'kind','VIRTUAL_EMPTY','generation',0,'observedAt',v_observed_at,
      'ownerRootRef','commerce.pricing.virtual-empty-price-set-root:' || v_predicate_digest,
      'ownerRevision','commerce.pricing.virtual-empty-price-set-revision:' || v_predicate_digest,
      'predicateRef','commerce.pricing.exact-price-candidates:' || v_predicate_digest,
      'verificationRef','commerce.pricing.virtual-empty-price-set-proof:' || v_predicate_digest
    );
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'authority',v_authority,
      'candidateSet',pg_catalog.jsonb_build_object(
        'candidates','[]'::jsonb,'effectiveAt',p_input->>'effectiveAt','exactKey',v_key),
      'outcome','EXACT_PRICE_CANDIDATE_SET_CURRENT'
    );
    RETURN;
  END IF;
  SELECT head.* INTO v_head FROM pricing.price_candidate_set_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_candidate_set_root_id = v_root.price_candidate_set_root_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'effectiveAt', p_input ->> 'effectiveAt', 'exactKey', v_key,
      'outcome', 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
      'reason', 'The persistent Price candidate-set root has no Current generation'
    );
    RETURN;
  END IF;
  SELECT count(*)::integer,
         count(schedule_head.price_schedule_head_id)::integer
    INTO v_matching_price_count, v_schedule_head_count
    FROM pricing.prices AS price
    LEFT JOIN pricing.price_schedule_heads AS schedule_head
      ON schedule_head.tenant_id=price.tenant_id
     AND schedule_head.legal_entity_id=price.legal_entity_id
     AND schedule_head.price_id=price.price_id
   WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
     AND price.catalog_selection=v_root.catalog_selection
     AND price.channel_id=v_root.channel_id AND price.market_id=v_root.market_id
     AND price.currency_code=v_root.currency_code AND price.unit_ref=v_root.unit_ref
     AND price.basis_quantity=v_root.basis_quantity
     AND price.price_group_selector=v_root.price_group_selector;
  IF v_matching_price_count=0 OR v_matching_price_count<>v_schedule_head_count THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'effectiveAt',p_input->>'effectiveAt','exactKey',v_key,
      'outcome','EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
      'reason','Persistent Price candidate-set authority is not bound to complete schedule heads');
    RETURN;
  END IF;

  WITH current_claimants AS (
    SELECT price.price_id, head.price_schedule_revision_id, head.schedule_revision,
           entry.price_revision_id, entry.effective_from, entry.effective_to,
           revision.revision_number, revision.amount, revision.currency_code,
           revision.monetary_boundary,
           count(assertion.source_assertion_id)::integer AS provenance_count,
           count(assertion.source_assertion_id) FILTER (
             WHERE assertion.source_authority_ref <> 'legacy:unverified:not-asserted'
               AND assertion.source_effective_at <= v_effective_at
               AND assertion.owner_business_effective_at <= v_effective_at
           )::integer AS usable_provenance_count,
           coalesce(pg_catalog.jsonb_agg(assertion.source_assertion_id::text ORDER BY assertion.source_assertion_id)
             FILTER (WHERE assertion.source_assertion_id IS NOT NULL), '[]'::jsonb) AS provenance_refs
      FROM pricing.prices AS price
      JOIN pricing.price_schedule_heads AS head
        ON head.tenant_id = price.tenant_id AND head.legal_entity_id = price.legal_entity_id
       AND head.price_id = price.price_id
      JOIN pricing.price_schedule_entries AS entry
        ON entry.tenant_id = head.tenant_id AND entry.legal_entity_id = head.legal_entity_id
       AND entry.price_id = head.price_id
       AND entry.price_schedule_revision_id = head.price_schedule_revision_id
      JOIN pricing.price_revisions AS revision
        ON revision.tenant_id = entry.tenant_id AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.price_id = entry.price_id AND revision.price_revision_id = entry.price_revision_id
      LEFT JOIN pricing.price_source_assertions AS assertion
        ON assertion.tenant_id = revision.tenant_id AND assertion.legal_entity_id = revision.legal_entity_id
       AND assertion.price_id = revision.price_id AND assertion.price_revision_id = revision.price_revision_id
     WHERE price.tenant_id = p_tenant_id AND price.legal_entity_id = p_legal_entity_id
       AND price.catalog_selection = v_root.catalog_selection
       AND price.channel_id = v_root.channel_id AND price.market_id = v_root.market_id
       AND price.currency_code = v_root.currency_code AND price.unit_ref = v_root.unit_ref
       AND price.basis_quantity = v_root.basis_quantity
       AND price.price_group_selector = v_root.price_group_selector
       AND entry.effective_from <= v_effective_at
       AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
     GROUP BY price.price_id, head.price_schedule_revision_id, head.schedule_revision,
              entry.price_revision_id, entry.effective_from, entry.effective_to,
              revision.revision_number, revision.amount, revision.currency_code,
              revision.monetary_boundary
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE claimant.provenance_count > 0
             AND claimant.provenance_count = claimant.usable_provenance_count
             AND claimant.currency_code = v_root.currency_code
             AND claimant.monetary_boundary = 'PRE_TAX' AND claimant.amount >= 0
         )::integer,
         coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'effectivePeriod', pg_catalog.jsonb_build_object(
             'effectiveFrom', pg_catalog.to_char(claimant.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'effectiveTo', CASE WHEN claimant.effective_to IS NULL THEN NULL ELSE
               pg_catalog.to_char(claimant.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END),
           'exactKey', v_key,
           'priceRef', pg_catalog.jsonb_build_object('moduleId','commerce.pricing','resourceId',claimant.price_id::text,
             'resourceType','commerce.pricing.price','tenantId',p_tenant_id::text),
           'priceRevision', pg_catalog.jsonb_build_object(
             'effectiveFrom', pg_catalog.to_char(claimant.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'monetaryAmount', pg_catalog.jsonb_build_object('amount',claimant.amount::text,'currencyCode',claimant.currency_code),
             'monetaryBoundary', claimant.monetary_boundary, 'revision', claimant.revision_number,
             'revisionId', claimant.price_revision_id::text),
           'priceScheduleRevisionId', claimant.price_schedule_revision_id::text,
           'provenanceRefs', claimant.provenance_refs, 'scheduleRevision', claimant.schedule_revision
         ) ORDER BY claimant.price_id, claimant.price_revision_id) FILTER (
           WHERE claimant.provenance_count > 0
             AND claimant.provenance_count = claimant.usable_provenance_count
             AND claimant.currency_code = v_root.currency_code
             AND claimant.monetary_boundary = 'PRE_TAX' AND claimant.amount >= 0
         ), '[]'::jsonb)
    INTO v_raw_count, v_valid_count, v_candidates
    FROM current_claimants AS claimant;

  IF v_raw_count <> v_valid_count THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'effectiveAt', p_input ->> 'effectiveAt', 'exactKey', v_key,
      'outcome', 'EXACT_PRICE_CANDIDATE_SET_UNVERIFIABLE',
      'reason', 'At least one Current Price claimant lacks complete usable source evidence'
    );
    RETURN;
  END IF;

  SELECT min(boundary) INTO v_next_boundary FROM (
    SELECT entry.effective_from AS boundary
      FROM pricing.prices AS price
      JOIN pricing.price_schedule_heads AS head ON head.tenant_id=price.tenant_id AND head.legal_entity_id=price.legal_entity_id AND head.price_id=price.price_id
      JOIN pricing.price_schedule_entries AS entry ON entry.tenant_id=head.tenant_id AND entry.legal_entity_id=head.legal_entity_id AND entry.price_id=head.price_id AND entry.price_schedule_revision_id=head.price_schedule_revision_id
     WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
       AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
       AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
       AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
       AND price.price_group_selector=v_root.price_group_selector AND entry.effective_from > v_effective_at
    UNION ALL
    SELECT entry.effective_to
      FROM pricing.prices AS price
      JOIN pricing.price_schedule_heads AS head ON head.tenant_id=price.tenant_id AND head.legal_entity_id=price.legal_entity_id AND head.price_id=price.price_id
      JOIN pricing.price_schedule_entries AS entry ON entry.tenant_id=head.tenant_id AND entry.legal_entity_id=head.legal_entity_id AND entry.price_id=head.price_id AND entry.price_schedule_revision_id=head.price_schedule_revision_id
     WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
       AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
       AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
       AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
       AND price.price_group_selector=v_root.price_group_selector AND entry.effective_to > v_effective_at
    UNION ALL
    SELECT assertion.owner_business_effective_at
      FROM pricing.prices AS price
      JOIN pricing.price_source_assertions AS assertion ON assertion.tenant_id=price.tenant_id AND assertion.legal_entity_id=price.legal_entity_id AND assertion.price_id=price.price_id
     WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
       AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
       AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
       AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
       AND price.price_group_selector=v_root.price_group_selector
       AND assertion.owner_business_effective_at > v_effective_at
  ) AS boundaries;

  v_observed_at := pg_catalog.to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_authority := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'kind', 'PERSISTENT',
    'generation', v_head.generation,
    'nextApplicabilityBoundary', CASE WHEN v_next_boundary IS NULL THEN NULL ELSE
      pg_catalog.to_char(v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observedAt', v_observed_at,
    'ownerRootRef', v_root.price_candidate_set_root_id::text,
    'ownerRevision', v_head.price_candidate_set_revision_id::text,
    'predicateRef', 'commerce.pricing.exact-price-candidates:' || v_root.price_candidate_set_root_id::text,
    'verificationRef', 'commerce.pricing.exact-price-candidate-set-proof:' ||
      v_root.price_candidate_set_root_id::text || ':' || v_head.price_candidate_set_revision_id::text || ':' || v_head.generation::text
  ));
  v_outcome := CASE WHEN v_valid_count > 1 THEN 'EXACT_PRICE_CANDIDATE_SET_CONFLICT'
                    ELSE 'EXACT_PRICE_CANDIDATE_SET_CURRENT' END;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'authority', v_authority,
    'candidateSet', pg_catalog.jsonb_build_object('candidates',v_candidates,'effectiveAt',p_input->>'effectiveAt','exactKey',v_key),
    'outcome', v_outcome
  );
END;
$function$;

CREATE FUNCTION pricing.verify_exact_price_candidate_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_key jsonb := p_input -> 'exactKey';
  v_authority jsonb := p_input -> 'authority';
  v_through timestamptz;
  v_observed_at timestamptz;
  v_next_boundary timestamptz;
  v_root record;
  v_head record;
  v_head_found boolean := false;
  v_current boolean := false;
  v_root_count integer := 0;
  v_price_count integer := 0;
  v_actual_next_boundary timestamptz;
  v_effective_at timestamptz;
  v_canonical_key jsonb;
  v_predicate_digest text;
  v_basis_quantity numeric;
  v_stored_basis_quantity numeric(38,9);
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Exact Price candidate-set verification scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_through := (p_input ->> 'through')::timestamptz;
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_observed_at := (v_authority ->> 'observedAt')::timestamptz;
    v_next_boundary := (v_authority ->> 'nextApplicabilityBoundary')::timestamptz;
    v_basis_quantity := (v_key#>>'{unitBasis,quantity}')::numeric;
    v_stored_basis_quantity := (v_key#>>'{unitBasis,quantity}')::numeric(38,9);
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Exact Price candidate-set verification input is invalid' USING ERRCODE = '22023';
  END;
  IF v_basis_quantity<=0 OR v_basis_quantity<>v_stored_basis_quantity OR v_observed_at<>v_effective_at
    OR v_through < v_observed_at OR v_through > pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'Exact Price candidate-set verification interval is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_authority->>'kind' = 'VIRTUAL_EMPTY' THEN
    v_canonical_key := pg_catalog.jsonb_set(
      v_key, '{unitBasis,quantity}',
      pg_catalog.to_jsonb(v_stored_basis_quantity::text), false
    );
    v_predicate_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(v_canonical_key::text,'UTF8'),'sha256'),'hex');
    SELECT count(*)::integer INTO v_root_count FROM pricing.price_candidate_set_roots AS root
     WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
       AND root.catalog_selection=v_key->'catalogSelection'
       AND root.channel_id=v_key#>>'{commercialScope,channelId}' AND root.market_id=v_key#>>'{commercialScope,marketId}'
       AND root.currency_code=v_key->>'currencyCode' AND root.unit_ref=v_key#>'{unitBasis,unitRef}'
       AND root.basis_quantity=v_stored_basis_quantity
       AND root.price_group_selector=v_key->'priceGroupSelector';
    SELECT count(*)::integer INTO v_price_count FROM pricing.prices AS price
     WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
       AND price.catalog_selection=v_key->'catalogSelection'
       AND price.channel_id=v_key#>>'{commercialScope,channelId}' AND price.market_id=v_key#>>'{commercialScope,marketId}'
       AND price.currency_code=v_key->>'currencyCode' AND price.unit_ref=v_key#>'{unitBasis,unitRef}'
       AND price.basis_quantity=v_stored_basis_quantity
       AND price.price_group_selector=v_key->'priceGroupSelector';
    v_current := v_root_count=0 AND v_price_count=0
      AND v_authority->>'ownerRootRef'='commerce.pricing.virtual-empty-price-set-root:' || v_predicate_digest
      AND v_authority->>'ownerRevision'='commerce.pricing.virtual-empty-price-set-revision:' || v_predicate_digest
      AND v_authority->>'predicateRef'='commerce.pricing.exact-price-candidates:' || v_predicate_digest
      AND v_authority->>'verificationRef'='commerce.pricing.virtual-empty-price-set-proof:' || v_predicate_digest
      AND (v_next_boundary IS NULL OR v_through<v_next_boundary);
  ELSE
  SELECT root.* INTO v_root FROM pricing.price_candidate_set_roots AS root
   WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
     AND root.catalog_selection=v_key->'catalogSelection'
     AND root.channel_id=v_key#>>'{commercialScope,channelId}' AND root.market_id=v_key#>>'{commercialScope,marketId}'
     AND root.currency_code=v_key->>'currencyCode' AND root.unit_ref=v_key#>'{unitBasis,unitRef}'
     AND root.basis_quantity=v_stored_basis_quantity
     AND root.price_group_selector=v_key->'priceGroupSelector';
  IF FOUND THEN
    SELECT head.* INTO v_head FROM pricing.price_candidate_set_heads AS head
     WHERE head.tenant_id=p_tenant_id AND head.legal_entity_id=p_legal_entity_id
       AND head.price_candidate_set_root_id=v_root.price_candidate_set_root_id;
    v_head_found := FOUND;
    SELECT min(boundary) INTO v_actual_next_boundary FROM (
      SELECT entry.effective_from AS boundary
        FROM pricing.prices AS price
        JOIN pricing.price_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=price.tenant_id AND schedule_head.legal_entity_id=price.legal_entity_id
         AND schedule_head.price_id=price.price_id
        JOIN pricing.price_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.price_id=schedule_head.price_id
         AND entry.price_schedule_revision_id=schedule_head.price_schedule_revision_id
       WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
         AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
         AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
         AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
         AND price.price_group_selector=v_root.price_group_selector AND entry.effective_from>v_effective_at
      UNION ALL
      SELECT entry.effective_to
        FROM pricing.prices AS price
        JOIN pricing.price_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=price.tenant_id AND schedule_head.legal_entity_id=price.legal_entity_id
         AND schedule_head.price_id=price.price_id
        JOIN pricing.price_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.price_id=schedule_head.price_id
         AND entry.price_schedule_revision_id=schedule_head.price_schedule_revision_id
       WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
         AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
         AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
         AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
         AND price.price_group_selector=v_root.price_group_selector AND entry.effective_to>v_effective_at
      UNION ALL
      SELECT assertion.owner_business_effective_at
        FROM pricing.prices AS price
        JOIN pricing.price_source_assertions AS assertion
          ON assertion.tenant_id=price.tenant_id AND assertion.legal_entity_id=price.legal_entity_id
         AND assertion.price_id=price.price_id
       WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
         AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
         AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
         AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
         AND price.price_group_selector=v_root.price_group_selector
         AND assertion.owner_business_effective_at>v_effective_at
    ) AS boundaries;
    v_current := v_head_found
      AND v_root.price_candidate_set_root_id::text = v_authority->>'ownerRootRef'
      AND v_head.price_candidate_set_revision_id::text = v_authority->>'ownerRevision'
      AND v_head.generation = (v_authority->>'generation')::integer
      AND v_authority->>'predicateRef'='commerce.pricing.exact-price-candidates:' || v_root.price_candidate_set_root_id::text
      AND v_authority->>'verificationRef'='commerce.pricing.exact-price-candidate-set-proof:' ||
        v_root.price_candidate_set_root_id::text || ':' || v_head.price_candidate_set_revision_id::text || ':' || v_head.generation::text
      AND v_next_boundary IS NOT DISTINCT FROM v_actual_next_boundary
      AND (v_next_boundary IS NULL OR v_through < v_next_boundary);
  END IF;
  END IF;
  IF v_current IS NOT TRUE THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome','EXACT_PRICE_CANDIDATE_SET_GENERATION_CHANGED',
      'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    RETURN;
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'authority',v_authority,'outcome','EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT',
    'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$function$;

CREATE FUNCTION pricing.encode_uri_component_v1(p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_bytes bytea := pg_catalog.convert_to(p_value, 'UTF8');
  v_index integer;
  v_byte integer;
  v_result text := '';
  v_character text;
BEGIN
  FOR v_index IN 0..pg_catalog.length(v_bytes)-1 LOOP
    v_byte := pg_catalog.get_byte(v_bytes, v_index);
    v_character := chr(v_byte);
    IF (v_byte BETWEEN 48 AND 57) OR (v_byte BETWEEN 65 AND 90) OR (v_byte BETWEEN 97 AND 122)
      OR v_character IN ('-', '_', '.', '!', '~', '*', '''', '(', ')')
    THEN
      v_result := v_result || v_character;
    ELSE
      v_result := v_result || '%' || pg_catalog.upper(pg_catalog.lpad(pg_catalog.to_hex(v_byte), 2, '0'));
    END IF;
  END LOOP;
  RETURN v_result;
END;
$function$;

CREATE FUNCTION pricing.read_current_commercial_fee_set_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_variant_ref jsonb := p_input #> '{target,variantRef}';
  v_effective_at timestamptz;
  v_root record;
  v_head record;
  v_fees jsonb := '[]'::jsonb;
  v_fee_count integer := 0;
  v_distinct_identity_count integer := 0;
  v_conflict_ids jsonb := '[]'::jsonb;
  v_next_boundary timestamptz;
  v_observed_at text;
  v_predicate_ref text;
  v_authority jsonb;
  v_completeness jsonb;
  v_matching_fee_count integer;
  v_schedule_head_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commercial Fee set scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Commercial Fee set input is invalid' USING ERRCODE = '22023';
  END;
  IF v_effective_at IS NULL OR jsonb_typeof(v_variant_ref) <> 'object'
    OR v_variant_ref ->> 'tenantId' <> p_tenant_id::text
    OR p_input #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
  THEN
    RAISE EXCEPTION 'Commercial Fee set input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT root.* INTO v_root FROM pricing.fee_set_roots AS root
   WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
     AND root.variant_ref=v_variant_ref
     AND root.channel_id=p_input#>>'{commercialScope,channelId}'
     AND root.market_id=p_input#>>'{commercialScope,marketId}'
     AND root.currency_code=p_input->>'currencyCode'
     AND root.monetary_boundary='PRE_TAX';
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome','COMMERCIAL_FEE_SET_MISSING');
    RETURN;
  END IF;
  SELECT head.* INTO v_head FROM pricing.fee_set_heads AS head
   WHERE head.tenant_id=p_tenant_id AND head.legal_entity_id=p_legal_entity_id
     AND head.fee_set_root_id=v_root.fee_set_root_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome','COMMERCIAL_FEE_SET_UNVERIFIABLE',
      'reason','The persistent Commercial Fee set root has no Current generation');
    RETURN;
  END IF;
  SELECT count(*)::integer, count(schedule_head.fee_schedule_head_id)::integer
    INTO v_matching_fee_count, v_schedule_head_count
    FROM pricing.fees AS fee
    LEFT JOIN pricing.fee_schedule_heads AS schedule_head
      ON schedule_head.tenant_id=fee.tenant_id
     AND schedule_head.legal_entity_id=fee.legal_entity_id
     AND schedule_head.fee_id=fee.fee_id
   WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
     AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
     AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
     AND fee.monetary_boundary=v_root.monetary_boundary;
  IF v_matching_fee_count<>v_schedule_head_count THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome','COMMERCIAL_FEE_SET_UNVERIFIABLE',
      'reason','Persistent Commercial Fee set authority is not bound to complete schedule heads');
    RETURN;
  END IF;

  WITH current_fees AS (
    SELECT fee.fee_id, entry.fee_revision_id, entry.effective_from, entry.effective_to,
           pricing.fee_identity_json_v1(p_tenant_id,p_legal_entity_id,fee.fee_id) AS identity,
           pricing.scheduled_fee_revision_json_v1(
             p_tenant_id,p_legal_entity_id,fee.fee_id,entry.fee_revision_id,
             entry.effective_from,entry.effective_to
           ) AS scheduled
      FROM pricing.fees AS fee
      JOIN pricing.fee_schedule_heads AS schedule_head
        ON schedule_head.tenant_id=fee.tenant_id AND schedule_head.legal_entity_id=fee.legal_entity_id
       AND schedule_head.fee_id=fee.fee_id
      JOIN pricing.fee_schedule_entries AS entry
        ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
       AND entry.fee_id=schedule_head.fee_id
       AND entry.fee_schedule_revision_id=schedule_head.fee_schedule_revision_id
     WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
       AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
       AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
       AND fee.monetary_boundary=v_root.monetary_boundary
       AND entry.effective_from <= v_effective_at
       AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
  )
  SELECT count(*)::integer, count(DISTINCT identity)::integer,
         coalesce(pg_catalog.jsonb_agg(scheduled ORDER BY identity::text, fee_id, fee_revision_id),'[]'::jsonb),
         coalesce(pg_catalog.jsonb_agg(fee_revision_id::text ORDER BY fee_revision_id)
           FILTER (WHERE identity IN (
             SELECT grouped.identity FROM current_fees AS grouped
              GROUP BY grouped.identity HAVING count(*) > 1
           )), '[]'::jsonb)
    INTO v_fee_count, v_distinct_identity_count, v_fees, v_conflict_ids
    FROM current_fees;

  IF v_fee_count <> v_distinct_identity_count THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'candidateRevisionIds',v_conflict_ids,'outcome','COMMERCIAL_FEE_SET_CONFLICT');
    RETURN;
  END IF;

  SELECT min(boundary) INTO v_next_boundary FROM (
    SELECT entry.effective_from AS boundary
      FROM pricing.fees AS fee
      JOIN pricing.fee_schedule_heads AS head ON head.tenant_id=fee.tenant_id AND head.legal_entity_id=fee.legal_entity_id AND head.fee_id=fee.fee_id
      JOIN pricing.fee_schedule_entries AS entry ON entry.tenant_id=head.tenant_id AND entry.legal_entity_id=head.legal_entity_id AND entry.fee_id=head.fee_id AND entry.fee_schedule_revision_id=head.fee_schedule_revision_id
     WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
       AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
       AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
       AND fee.monetary_boundary=v_root.monetary_boundary AND entry.effective_from > v_effective_at
    UNION ALL
    SELECT entry.effective_to
      FROM pricing.fees AS fee
      JOIN pricing.fee_schedule_heads AS head ON head.tenant_id=fee.tenant_id AND head.legal_entity_id=fee.legal_entity_id AND head.fee_id=fee.fee_id
      JOIN pricing.fee_schedule_entries AS entry ON entry.tenant_id=head.tenant_id AND entry.legal_entity_id=head.legal_entity_id AND entry.fee_id=head.fee_id AND entry.fee_schedule_revision_id=head.fee_schedule_revision_id
     WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
       AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
       AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
       AND fee.monetary_boundary=v_root.monetary_boundary AND entry.effective_to > v_effective_at
  ) AS boundaries;

  v_observed_at := pg_catalog.to_char(v_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_predicate_ref := 'pricing-commercial-fee-current-set:v1:' ||
    pricing.encode_uri_component_v1(v_variant_ref->>'tenantId') || ':' ||
    pricing.encode_uri_component_v1(v_variant_ref->>'moduleId') || ':' ||
    pricing.encode_uri_component_v1(v_variant_ref->>'resourceType') || ':' ||
    pricing.encode_uri_component_v1(v_variant_ref->>'resourceId') || ':' ||
    pricing.encode_uri_component_v1(p_legal_entity_id::text) || ':' ||
    pricing.encode_uri_component_v1(v_root.channel_id) || ':' ||
    pricing.encode_uri_component_v1(v_root.market_id) || ':' ||
    pricing.encode_uri_component_v1(v_root.currency_code);
  v_authority := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'generation',v_head.generation,
    'nextApplicabilityBoundary',CASE WHEN v_next_boundary IS NULL THEN NULL ELSE
      pg_catalog.to_char(v_next_boundary AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observedAt',v_observed_at,'ownerRootRef',v_root.fee_set_root_id::text,
    'ownerRevision',v_head.fee_set_revision_id::text,'predicateRef',v_predicate_ref,
    'verificationRef','commerce.pricing.commercial-fee-set-proof:' || v_root.fee_set_root_id::text || ':' ||
      v_head.fee_set_revision_id::text || ':' || v_head.generation::text));
  v_completeness := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'nextApplicabilityBoundary',CASE WHEN v_next_boundary IS NULL THEN NULL ELSE
      pg_catalog.to_char(v_next_boundary AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observedAt',v_observed_at,'ownerRevision',v_head.fee_set_revision_id::text,
    'scope',pg_catalog.jsonb_build_object('kind','EXACT_PREDICATE','predicateRef',v_predicate_ref)));
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'authority',v_authority,'outcome','COMMERCIAL_FEE_SET_CURRENT',
    'feeSet',pg_catalog.jsonb_build_object(
      'commercialScope',p_input->'commercialScope','completenessEvidence',v_completeness,
      'currencyCode',v_root.currency_code,
      'currentnessEvidence',pg_catalog.jsonb_build_object(
        'observedAt',v_observed_at,'ownerRevision',v_head.fee_set_revision_id::text,
        'predicateRef',v_predicate_ref,'revalidatedAt',v_observed_at,
        'verificationMode','OWNER_CURRENT_SET_REVALIDATED'),
      'fees',v_fees,'observedAt',v_observed_at,'target',p_input->'target'));
END;
$function$;

CREATE FUNCTION pricing.verify_commercial_fee_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authority jsonb := p_input->'authority';
  v_variant_ref jsonb := p_input#>'{target,variantRef}';
  v_through timestamptz;
  v_effective_at timestamptz;
  v_observed_at timestamptz;
  v_next_boundary timestamptz;
  v_actual_next_boundary timestamptz;
  v_predicate_ref text;
  v_root record;
  v_head record;
  v_head_found boolean := false;
  v_current boolean := false;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commercial Fee set verification scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_through := (p_input->>'through')::timestamptz;
    v_effective_at := (p_input->>'effectiveAt')::timestamptz;
    v_observed_at := (v_authority->>'observedAt')::timestamptz;
    v_next_boundary := (v_authority->>'nextApplicabilityBoundary')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Commercial Fee set verification input is invalid' USING ERRCODE = '22023';
  END;
  IF v_observed_at<>v_effective_at OR v_through < v_observed_at
    OR v_through > pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'Commercial Fee set verification interval is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT root.* INTO v_root FROM pricing.fee_set_roots AS root
   WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
     AND root.variant_ref=v_variant_ref
     AND root.channel_id=p_input#>>'{commercialScope,channelId}'
     AND root.market_id=p_input#>>'{commercialScope,marketId}'
     AND root.currency_code=p_input->>'currencyCode' AND root.monetary_boundary='PRE_TAX';
  IF FOUND THEN
    SELECT head.* INTO v_head FROM pricing.fee_set_heads AS head
     WHERE head.tenant_id=p_tenant_id AND head.legal_entity_id=p_legal_entity_id
       AND head.fee_set_root_id=v_root.fee_set_root_id;
    v_head_found := FOUND;
    SELECT min(boundary) INTO v_actual_next_boundary FROM (
      SELECT entry.effective_from AS boundary
        FROM pricing.fees AS fee
        JOIN pricing.fee_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=fee.tenant_id AND schedule_head.legal_entity_id=fee.legal_entity_id
         AND schedule_head.fee_id=fee.fee_id
        JOIN pricing.fee_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.fee_id=schedule_head.fee_id
         AND entry.fee_schedule_revision_id=schedule_head.fee_schedule_revision_id
       WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
         AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
         AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
         AND fee.monetary_boundary=v_root.monetary_boundary AND entry.effective_from>v_effective_at
      UNION ALL
      SELECT entry.effective_to
        FROM pricing.fees AS fee
        JOIN pricing.fee_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=fee.tenant_id AND schedule_head.legal_entity_id=fee.legal_entity_id
         AND schedule_head.fee_id=fee.fee_id
        JOIN pricing.fee_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.fee_id=schedule_head.fee_id
         AND entry.fee_schedule_revision_id=schedule_head.fee_schedule_revision_id
       WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
         AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
         AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
         AND fee.monetary_boundary=v_root.monetary_boundary AND entry.effective_to>v_effective_at
    ) AS boundaries;
    v_predicate_ref := 'pricing-commercial-fee-current-set:v1:' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'tenantId') || ':' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'moduleId') || ':' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'resourceType') || ':' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'resourceId') || ':' ||
      pricing.encode_uri_component_v1(p_legal_entity_id::text) || ':' ||
      pricing.encode_uri_component_v1(v_root.channel_id) || ':' ||
      pricing.encode_uri_component_v1(v_root.market_id) || ':' ||
      pricing.encode_uri_component_v1(v_root.currency_code);
    v_current := v_head_found AND v_root.fee_set_root_id::text=v_authority->>'ownerRootRef'
      AND v_head.fee_set_revision_id::text=v_authority->>'ownerRevision'
      AND v_head.generation=(v_authority->>'generation')::integer
      AND v_authority->>'predicateRef'=v_predicate_ref
      AND v_authority->>'verificationRef'='commerce.pricing.commercial-fee-set-proof:' ||
        v_root.fee_set_root_id::text || ':' || v_head.fee_set_revision_id::text || ':' || v_head.generation::text
      AND v_next_boundary IS NOT DISTINCT FROM v_actual_next_boundary
      AND (v_next_boundary IS NULL OR v_through < v_next_boundary);
  END IF;
  IF v_current IS NOT TRUE THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome','COMMERCIAL_FEE_SET_GENERATION_CHANGED',
      'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    RETURN;
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'authority',v_authority,'outcome','COMMERCIAL_FEE_SET_GENERATION_CURRENT',
    'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$function$;

REVOKE ALL ON FUNCTION pricing.guard_price_candidate_set_head_advance_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.guard_fee_set_head_advance_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_price_candidate_set_generation_v1(uuid,uuid,uuid,uuid,text)
  FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_fee_set_generation_v1(uuid,uuid,uuid,uuid,text)
  FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.initialize_price_and_fee_set_authority_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_price_candidate_set_after_schedule_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_price_candidate_set_after_source_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.initialize_or_advance_fee_set_after_define_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_fee_set_after_schedule_v1() FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.encode_uri_component_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_exact_price_candidate_set_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.verify_exact_price_candidate_set_generation_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_commercial_fee_set_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.verify_commercial_fee_set_generation_v1(uuid,uuid,jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pricing.read_exact_price_candidate_set_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_exact_price_candidate_set_generation_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_commercial_fee_set_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_commercial_fee_set_generation_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.encode_uri_component_v1(text) TO ontos_runtime;

ALTER POLICY pricing_price_candidate_set_roots_scope_select
  ON pricing.price_candidate_set_roots TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_candidate_set_roots_scope_insert
  ON pricing.price_candidate_set_roots TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_candidate_set_revisions_scope_select
  ON pricing.price_candidate_set_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_candidate_set_revisions_scope_insert
  ON pricing.price_candidate_set_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_candidate_set_heads_scope_select
  ON pricing.price_candidate_set_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_candidate_set_heads_scope_insert
  ON pricing.price_candidate_set_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_candidate_set_heads_scope_update
  ON pricing.price_candidate_set_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_roots_scope_select
  ON pricing.fee_set_roots TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_roots_scope_insert
  ON pricing.fee_set_roots TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_revisions_scope_select
  ON pricing.fee_set_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_revisions_scope_insert
  ON pricing.fee_set_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_heads_scope_select
  ON pricing.fee_set_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_heads_scope_insert
  ON pricing.fee_set_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_set_heads_scope_update
  ON pricing.fee_set_heads TO ontos_runtime, pricing_management_routine_writer;

GRANT USAGE ON SCHEMA pricing TO pricing_management_routine_writer;
GRANT SELECT, INSERT ON TABLE pricing.price_candidate_set_roots,
  pricing.price_candidate_set_revisions, pricing.fee_set_roots, pricing.fee_set_revisions
  TO pricing_management_routine_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.price_candidate_set_heads,
  pricing.fee_set_heads TO pricing_management_routine_writer;

GRANT EXECUTE ON FUNCTION pricing.guard_price_candidate_set_head_advance_v1(),
  pricing.guard_fee_set_head_advance_v1(),
  pricing.advance_price_candidate_set_generation_v1(uuid,uuid,uuid,uuid,text),
  pricing.advance_fee_set_generation_v1(uuid,uuid,uuid,uuid,text),
  pricing.initialize_price_and_fee_set_authority_v1(),
  pricing.advance_price_candidate_set_after_schedule_v1(),
  pricing.advance_price_candidate_set_after_source_v1(),
  pricing.initialize_or_advance_fee_set_after_define_v1(),
  pricing.advance_fee_set_after_schedule_v1()
TO pricing_management_routine_writer;

REVOKE INSERT, UPDATE, DELETE ON TABLE pricing.price_candidate_set_roots,
  pricing.price_candidate_set_revisions, pricing.price_candidate_set_heads,
  pricing.fee_set_roots, pricing.fee_set_revisions, pricing.fee_set_heads
  FROM ontos_runtime;
GRANT SELECT ON TABLE pricing.price_candidate_set_roots,
  pricing.price_candidate_set_revisions, pricing.price_candidate_set_heads,
  pricing.fee_set_roots, pricing.fee_set_revisions, pricing.fee_set_heads
  TO ontos_runtime;
