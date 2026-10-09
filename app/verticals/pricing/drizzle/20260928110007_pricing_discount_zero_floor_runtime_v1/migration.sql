-- #797 governed Contractual Discount and ZERO_FLOOR persistence/runtime.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

ALTER TABLE pricing.contractual_discount_action_invocation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discount_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discount_schedule_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discount_schedule_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discounts FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discount_set_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discount_set_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.contractual_discount_set_roots FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_action_invocation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_authorization_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_authorization_schedule_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_governance_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_schedule_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_set_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_set_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.zero_floor_set_roots FORCE ROW LEVEL SECURITY;

CREATE FUNCTION pricing.canonicalize_management_json_v1(p_value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_kind text := jsonb_typeof(p_value);
  v_result jsonb;
BEGIN
  IF v_kind = 'array' THEN
    SELECT COALESCE(jsonb_agg(pricing.canonicalize_management_json_v1(value) ORDER BY ordinality), '[]'::jsonb)
      INTO v_result
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item(value, ordinality);
    RETURN v_result;
  END IF;
  IF v_kind = 'object' THEN
    SELECT COALESCE(
      jsonb_object_agg(
        key,
        CASE
          WHEN key IN ('amount', 'quantity', 'level', 'maximumFloorAdjustment', 'minimumRawAmount')
            AND jsonb_typeof(value) = 'string'
            AND value #>> '{}' ~ '^-?[0-9]+(?:\.[0-9]+)?$'
          THEN to_jsonb(((value #>> '{}')::numeric)::text)
          ELSE pricing.canonicalize_management_json_v1(value)
        END
        ORDER BY key
      ),
      '{}'::jsonb
    ) INTO v_result FROM jsonb_each(p_value);
    RETURN v_result;
  END IF;
  RETURN p_value;
END;
$function$;

CREATE FUNCTION pricing.lookup_contractual_discount_result_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_action_id uuid := (p_input ->> 'actionInvocationId')::uuid;
  v_principal_id uuid := (p_input ->> 'actingPrincipalId')::uuid;
  v_result jsonb;
BEGIN
  IF v_action_id IS NULL OR v_principal_id IS NULL OR p_input <>
    jsonb_build_object('actionInvocationId', v_action_id::text, 'actingPrincipalId', v_principal_id::text)
  THEN
    RAISE EXCEPTION 'Contractual Discount result lookup requires exact invocation and principal'
      USING ERRCODE = '22023';
  END IF;
  SELECT receipt.outcome INTO v_result
    FROM pricing.contractual_discount_action_invocation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_action_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actionInvocationId', v_action_id,
      'outcome', 'CONTRACTUAL_DISCOUNT_RESULT_FOUND',
      'result', v_result
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      'actionInvocationId', v_action_id,
      'outcome', 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT'
    );
  END IF;
END;
$function$;

CREATE FUNCTION pricing.management_fingerprint_v1(p_value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN encode(public.digest(pricing.canonicalize_management_json_v1(p_value)::text, 'sha256'), 'hex');

CREATE FUNCTION pricing.management_instant_v1(p_at timestamptz)
RETURNS text LANGUAGE sql STABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

CREATE FUNCTION pricing.zero_floor_predicate_ref_v1(p_query jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  RETURN 'pricing-zero-floor-current-set:v1:' || pricing.management_fingerprint_v1(
    p_query - 'effectiveAt' - 'exactPredicateRef'
  );
END;
$function$;

CREATE FUNCTION pricing.zero_floor_authorization_fingerprint_v1(p_authorization jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  RETURN pricing.management_fingerprint_v1(p_authorization);
END;
$function$;

CREATE FUNCTION pricing.zero_floor_schedule_at_v1(p_schedule jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN jsonb_build_object(
  'authorizationRef', p_schedule -> 'authorizationRef',
  'revisions', p_schedule -> 'revisions',
  'scheduleRevision', p_schedule -> 'scheduleRevision',
  'tenantId', p_schedule -> 'tenantId'
);

CREATE FUNCTION pricing.guard_zero_floor_set_head_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.zero_floor_set_root_id IS DISTINCT FROM OLD.zero_floor_set_root_id
    OR NEW.zero_floor_set_head_id IS DISTINCT FROM OLD.zero_floor_set_head_id
    OR NEW.generation <> OLD.generation + 1
    OR NOT EXISTS (
      SELECT 1 FROM pricing.zero_floor_set_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.zero_floor_set_root_id = OLD.zero_floor_set_root_id
         AND revision.zero_floor_set_revision_id = NEW.zero_floor_set_revision_id
         AND revision.previous_zero_floor_set_revision_id = OLD.zero_floor_set_revision_id
         AND revision.generation = NEW.generation
    )
  THEN
    RAISE EXCEPTION 'ZERO_FLOOR set generation must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_zero_floor_set_heads_monotonic_v1
BEFORE UPDATE ON pricing.zero_floor_set_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_zero_floor_set_head_v1();

CREATE FUNCTION pricing.guard_zero_floor_schedule_head_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.zero_floor_authorization_id IS DISTINCT FROM OLD.zero_floor_authorization_id
    OR NEW.zero_floor_authorization_schedule_head_id IS DISTINCT FROM OLD.zero_floor_authorization_schedule_head_id
    OR NEW.schedule_revision <> OLD.schedule_revision + 1
    OR NOT EXISTS (
      SELECT 1 FROM pricing.zero_floor_authorization_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.zero_floor_authorization_id = OLD.zero_floor_authorization_id
         AND revision.zero_floor_authorization_revision_id = NEW.zero_floor_authorization_revision_id
         AND revision.previous_zero_floor_authorization_revision_id = OLD.zero_floor_authorization_revision_id
         AND revision.schedule_revision = NEW.schedule_revision
    )
  THEN
    RAISE EXCEPTION 'ZERO_FLOOR schedule must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_zero_floor_authorization_schedule_heads_monotonic_v1
BEFORE UPDATE ON pricing.zero_floor_authorization_schedule_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_zero_floor_schedule_head_v1();

CREATE FUNCTION pricing.ensure_zero_floor_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_action_invocation_id text
)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_root_id uuid := gen_random_uuid();
  v_revision_id uuid := gen_random_uuid();
  v_generation integer;
BEGIN
  INSERT INTO pricing.zero_floor_set_roots (
    zero_floor_set_root_id, tenant_id, legal_entity_id, created_by_action_invocation_id
  ) VALUES (v_root_id, p_tenant_id, p_legal_entity_id, p_action_invocation_id)
  ON CONFLICT (tenant_id, legal_entity_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO pricing.zero_floor_set_revisions (
      zero_floor_set_revision_id, tenant_id, legal_entity_id, zero_floor_set_root_id,
      generation, action_invocation_id, mutation_kind
    ) VALUES (
      v_revision_id, p_tenant_id, p_legal_entity_id, v_root_id, 1,
      'internal:scope-initialized:' || v_revision_id::text, 'SCOPE_INITIALIZED'
    );
    INSERT INTO pricing.zero_floor_set_heads (
      tenant_id, legal_entity_id, zero_floor_set_root_id, zero_floor_set_revision_id, generation
    ) VALUES (p_tenant_id, p_legal_entity_id, v_root_id, v_revision_id, 1);
    RETURN 1;
  END IF;
  SELECT generation INTO v_generation FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN v_generation;
END;
$function$;

CREATE FUNCTION pricing.advance_zero_floor_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_action_invocation_id text,
  p_mutation_kind text
)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_existing pricing.zero_floor_set_revisions%ROWTYPE;
  v_revision_id uuid := gen_random_uuid();
BEGIN
  PERFORM pricing.ensure_zero_floor_set_v1(p_tenant_id, p_legal_entity_id, p_action_invocation_id || ':initialize');
  SELECT * INTO STRICT v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id FOR UPDATE;
  SELECT * INTO v_existing FROM pricing.zero_floor_set_revisions
   WHERE tenant_id = p_tenant_id AND action_invocation_id = p_action_invocation_id;
  IF FOUND THEN
    IF v_existing.legal_entity_id IS DISTINCT FROM p_legal_entity_id
      OR v_existing.zero_floor_set_root_id IS DISTINCT FROM v_head.zero_floor_set_root_id
      OR v_existing.mutation_kind IS DISTINCT FROM p_mutation_kind
    THEN
      RAISE EXCEPTION 'ZERO_FLOOR set action invocation is already bound to another mutation'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.generation;
  END IF;
  INSERT INTO pricing.zero_floor_set_revisions (
    zero_floor_set_revision_id, tenant_id, legal_entity_id, zero_floor_set_root_id,
    generation, previous_zero_floor_set_revision_id, action_invocation_id, mutation_kind
  ) VALUES (
    v_revision_id, p_tenant_id, p_legal_entity_id, v_head.zero_floor_set_root_id,
    v_head.generation + 1, v_head.zero_floor_set_revision_id, p_action_invocation_id, p_mutation_kind
  );
  UPDATE pricing.zero_floor_set_heads
     SET zero_floor_set_revision_id = v_revision_id, generation = v_head.generation + 1
   WHERE zero_floor_set_head_id = v_head.zero_floor_set_head_id AND generation = v_head.generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZERO_FLOOR set generation changed concurrently' USING ERRCODE = '40001';
  END IF;
  RETURN v_head.generation + 1;
END;
$function$;

CREATE FUNCTION pricing.uri_encode_component_v1(p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_bytes bytea := convert_to(p_value, 'UTF8');
  v_index integer;
  v_byte integer;
  v_result text := '';
BEGIN
  FOR v_index IN 0..length(v_bytes) - 1 LOOP
    v_byte := get_byte(v_bytes, v_index);
    IF (v_byte BETWEEN 48 AND 57) OR (v_byte BETWEEN 65 AND 90) OR (v_byte BETWEEN 97 AND 122)
      OR v_byte IN (33, 39, 40, 41, 42, 45, 46, 95, 126)
    THEN
      v_result := v_result || chr(v_byte);
    ELSE
      v_result := v_result || '%' || upper(lpad(to_hex(v_byte), 2, '0'));
    END IF;
  END LOOP;
  RETURN v_result;
END;
$function$;

CREATE FUNCTION pricing.contractual_discount_identity_ref_v1(p_identity jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN pricing.management_fingerprint_v1(p_identity);

CREATE FUNCTION pricing.contractual_discount_predicate_ref_v1(p_predicate jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_basis text;
  v_audiences text;
  v_values text[];
BEGIN
  IF p_predicate #>> '{basis,kind}' = 'WHOLE_PURCHASE' THEN
    v_basis := 'whole-purchase';
  ELSE
    v_basis := concat_ws(':',
      concat_ws('/', p_predicate #>> '{basis,catalogSelection,productRef,tenantId}', p_predicate #>> '{basis,catalogSelection,productRef,moduleId}', p_predicate #>> '{basis,catalogSelection,productRef,resourceType}', p_predicate #>> '{basis,catalogSelection,productRef,resourceId}'),
      concat_ws('/', p_predicate #>> '{basis,catalogSelection,variantRef,tenantId}', p_predicate #>> '{basis,catalogSelection,variantRef,moduleId}', p_predicate #>> '{basis,catalogSelection,variantRef,resourceType}', p_predicate #>> '{basis,catalogSelection,variantRef,resourceId}'),
      concat_ws('/', p_predicate #>> '{basis,unitBasis,unitRef,tenantId}', p_predicate #>> '{basis,unitBasis,unitRef,moduleId}', p_predicate #>> '{basis,unitBasis,unitRef,resourceType}', p_predicate #>> '{basis,unitBasis,unitRef,resourceId}'),
      ((p_predicate #>> '{basis,unitBasis,quantity}')::numeric)::text
    );
  END IF;
  SELECT string_agg(audience_ref, ',' ORDER BY audience_ref) INTO v_audiences
    FROM (
      SELECT CASE value ->> 'kind'
        WHEN 'PRICE_GROUP' THEN concat_ws('/', value #>> '{priceGroupRef,tenantId}', value #>> '{priceGroupRef,moduleId}', value #>> '{priceGroupRef,resourceType}', value #>> '{priceGroupRef,resourceId}')
        WHEN 'COUNTERPARTY' THEN concat_ws('/', value #>> '{counterpartyRef,tenantId}', value #>> '{counterpartyRef,moduleId}', value #>> '{counterpartyRef,resourceType}', value #>> '{counterpartyRef,resourceId}')
      END AS audience_ref
      FROM jsonb_array_elements(p_predicate -> 'audiences')
    ) AS refs;
  v_values := ARRAY[
    p_predicate ->> 'tenantId',
    p_predicate #>> '{commercialScope,sellingLegalEntityId}',
    p_predicate #>> '{commercialScope,channelId}',
    p_predicate #>> '{commercialScope,marketId}',
    p_predicate ->> 'currencyCode',
    v_basis,
    v_audiences
  ];
  RETURN 'pricing-contractual-discount-current-set:v1:' ||
    array_to_string(ARRAY(SELECT pricing.uri_encode_component_v1(value) FROM unnest(v_values) AS value), ':');
END;
$function$;

CREATE FUNCTION pricing.contractual_discount_schedule_at_v1(p_schedule jsonb, p_observed_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_current jsonb;
  v_current_count integer;
  v_future jsonb;
BEGIN
  SELECT count(*), (array_agg(value ORDER BY value #>> '{effectivePeriod,effectiveFrom}'))[1]
    INTO v_current_count, v_current
    FROM jsonb_array_elements(p_schedule -> 'revisions') AS revision(value)
   WHERE (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz <= p_observed_at
     AND ((value #> '{effectivePeriod,effectiveTo}') = 'null'::jsonb
       OR (value #>> '{effectivePeriod,effectiveTo}')::timestamptz > p_observed_at);
  IF v_current_count > 1 THEN
    RAISE EXCEPTION 'Contractual Discount schedule contains conflicting Current revisions' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value #>> '{effectivePeriod,effectiveFrom}'), '[]'::jsonb)
    INTO v_future
    FROM jsonb_array_elements(p_schedule -> 'revisions') AS revision(value)
   WHERE (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz > p_observed_at;
  RETURN jsonb_build_object(
    'discountId', p_schedule -> 'discountId',
    'future', v_future,
    'identityKey', p_schedule -> 'identityKey',
    'observedAt', pricing.management_instant_v1(p_observed_at),
    'revisions', p_schedule -> 'revisions',
    'scheduleRevision', p_schedule -> 'scheduleRevision'
  ) || CASE WHEN v_current IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('current', v_current) END;
END;
$function$;

CREATE FUNCTION pricing.read_current_contractual_discount_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_observed_at timestamptz := (p_input ->> 'observedAt')::timestamptz;
  v_predicate_ref text;
  v_head record;
  v_members jsonb;
  v_next_boundary timestamptz;
  v_owner_revision text;
  v_completeness jsonb;
BEGIN
  IF p_input ->> 'tenantId' <> p_tenant_id::text
    OR p_input #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
  THEN
    RAISE EXCEPTION 'Contractual Discount predicate scope is invalid' USING ERRCODE = '22023';
  END IF;
  v_predicate_ref := pricing.contractual_discount_predicate_ref_v1(p_input);
  SELECT head.*, root.created_at INTO v_head
    FROM pricing.contractual_discount_set_heads AS head
    JOIN pricing.contractual_discount_set_roots AS root
      ON root.contractual_discount_set_root_id = head.contractual_discount_set_root_id
   WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contractual Discount set authority is not initialized' USING ERRCODE = 'P0002';
  END IF;

  WITH matching_schedules AS (
    SELECT pricing.contractual_discount_schedule_at_v1(revision.schedule, v_observed_at) AS schedule
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
     WHERE (revision #>> '{effectivePeriod,effectiveFrom}')::timestamptz > v_observed_at
    UNION ALL
    SELECT (revision #>> '{effectivePeriod,effectiveTo}')::timestamptz
      FROM matching_schedules, LATERAL jsonb_array_elements(schedule -> 'revisions') AS revision
     WHERE revision #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb
       AND (revision #>> '{effectivePeriod,effectiveTo}')::timestamptz > v_observed_at
  )
  SELECT
    COALESCE((SELECT jsonb_agg(member ORDER BY member #>> '{definition,discountId}') FROM current_members), '[]'::jsonb),
    (SELECT min(boundary) FROM boundaries)
  INTO v_members, v_next_boundary;

  v_owner_revision := 'pricing:contractual-discount-set:generation:' || v_head.generation::text;
  v_completeness := jsonb_build_object(
    'observedAt', to_jsonb(v_observed_at),
    'ownerRevision', v_owner_revision,
    'scope', jsonb_build_object('kind', 'EXACT_PREDICATE', 'predicateRef', v_predicate_ref)
  );
  IF v_next_boundary IS NOT NULL THEN
    v_completeness := v_completeness || jsonb_build_object('nextApplicabilityBoundary', to_jsonb(v_next_boundary));
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'authority', jsonb_build_object(
      'generation', v_head.generation,
      'observedAt', to_jsonb(v_observed_at),
      'ownerRevision', v_owner_revision,
      'ownerRootRef', 'pricing:contractual-discount-set:' || v_head.contractual_discount_set_root_id::text,
      'predicateRef', v_predicate_ref,
      'verifiedAt', to_jsonb(statement_timestamp())
    ),
    'completenessEvidence', v_completeness,
    'currentDiscounts', v_members,
    'predicate', p_input
  );
END;
$function$;

CREATE FUNCTION pricing.verify_contractual_discount_set_generation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authority jsonb := p_input -> 'authority';
  v_predicate jsonb := p_input -> 'predicate';
  v_through timestamptz := (p_input ->> 'through')::timestamptz;
  v_head record;
  v_expected_ref text;
  v_current boolean := false;
  v_next_boundary timestamptz;
BEGIN
  IF v_predicate ->> 'tenantId' <> p_tenant_id::text
    OR v_predicate #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR v_through > statement_timestamp()
  THEN
    RAISE EXCEPTION 'Contractual Discount generation request is invalid' USING ERRCODE = '22023';
  END IF;
  v_expected_ref := pricing.contractual_discount_predicate_ref_v1(v_predicate);
  SELECT * INTO v_head FROM pricing.contractual_discount_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  IF FOUND THEN
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
       WHERE (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz >
             (v_predicate ->> 'observedAt')::timestamptz
      UNION ALL
      SELECT (value #>> '{effectivePeriod,effectiveTo}')::timestamptz
        FROM matching_revisions
       WHERE value #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb
         AND (value #>> '{effectivePeriod,effectiveTo}')::timestamptz >
             (v_predicate ->> 'observedAt')::timestamptz
    ) AS boundaries;
    v_current :=
      (v_authority ->> 'generation')::integer = v_head.generation
      AND v_authority ->> 'ownerRootRef' =
        'pricing:contractual-discount-set:' || v_head.contractual_discount_set_root_id::text
      AND v_authority ->> 'ownerRevision' =
        'pricing:contractual-discount-set:generation:' || v_head.generation::text
      AND v_authority ->> 'predicateRef' = v_expected_ref
      AND v_authority ->> 'observedAt' = v_predicate ->> 'observedAt'
      AND (v_next_boundary IS NULL OR v_through < v_next_boundary);
  END IF;
  IF v_current IS TRUE THEN
    RETURN QUERY SELECT jsonb_build_object(
      'authority', v_authority,
      'outcome', 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT',
      'verifiedThrough', to_jsonb(v_through)
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CHANGED',
      'verifiedThrough', to_jsonb(v_through)
    );
  END IF;
END;
$function$;

CREATE FUNCTION pricing.guard_contractual_discount_set_head_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.contractual_discount_set_root_id IS DISTINCT FROM OLD.contractual_discount_set_root_id
    OR NEW.contractual_discount_set_head_id IS DISTINCT FROM OLD.contractual_discount_set_head_id
    OR NEW.generation <> OLD.generation + 1
    OR NOT EXISTS (
      SELECT 1 FROM pricing.contractual_discount_set_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.contractual_discount_set_root_id = OLD.contractual_discount_set_root_id
         AND revision.contractual_discount_set_revision_id = NEW.contractual_discount_set_revision_id
         AND revision.previous_contractual_discount_set_revision_id = OLD.contractual_discount_set_revision_id
         AND revision.generation = NEW.generation
    )
  THEN
    RAISE EXCEPTION 'Contractual Discount set generation must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_contractual_discount_set_heads_monotonic_v1
BEFORE UPDATE ON pricing.contractual_discount_set_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_contractual_discount_set_head_v1();

CREATE FUNCTION pricing.guard_contractual_discount_schedule_head_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.discount_id IS DISTINCT FROM OLD.discount_id
    OR NEW.contractual_discount_schedule_head_id IS DISTINCT FROM OLD.contractual_discount_schedule_head_id
    OR NEW.schedule_revision <> OLD.schedule_revision + 1
    OR NOT EXISTS (
      SELECT 1 FROM pricing.contractual_discount_revisions AS revision
       WHERE revision.tenant_id = OLD.tenant_id
         AND revision.legal_entity_id = OLD.legal_entity_id
         AND revision.discount_id = OLD.discount_id
         AND revision.contractual_discount_revision_id = NEW.contractual_discount_revision_id
         AND revision.previous_contractual_discount_revision_id = OLD.contractual_discount_revision_id
         AND revision.schedule_revision = NEW.schedule_revision
    )
  THEN
    RAISE EXCEPTION 'Contractual Discount schedule must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER pricing_contractual_discount_schedule_heads_monotonic_v1
BEFORE UPDATE ON pricing.contractual_discount_schedule_heads
FOR EACH ROW EXECUTE FUNCTION pricing.guard_contractual_discount_schedule_head_v1();

CREATE FUNCTION pricing.advance_contractual_discount_set_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_action_invocation_id uuid,
  p_mutation_kind text
)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_head pricing.contractual_discount_set_heads%ROWTYPE;
  v_root_id uuid;
  v_revision_id uuid := gen_random_uuid();
BEGIN
  -- Serialize initialization even when two different identities are created in the same empty set.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'contractual-discount-set:' || p_tenant_id::text || ':' || p_legal_entity_id::text, 0
  ));
  SELECT * INTO v_head FROM pricing.contractual_discount_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id FOR UPDATE;
  IF NOT FOUND THEN
    v_root_id := gen_random_uuid();
    INSERT INTO pricing.contractual_discount_set_roots (
      contractual_discount_set_root_id, tenant_id, legal_entity_id, created_by_action_invocation_id
    ) VALUES (v_root_id, p_tenant_id, p_legal_entity_id, p_action_invocation_id);
    INSERT INTO pricing.contractual_discount_set_revisions (
      contractual_discount_set_revision_id, tenant_id, legal_entity_id, contractual_discount_set_root_id,
      generation, action_invocation_id, mutation_kind
    ) VALUES (v_revision_id, p_tenant_id, p_legal_entity_id, v_root_id, 1, p_action_invocation_id, p_mutation_kind);
    INSERT INTO pricing.contractual_discount_set_heads (
      tenant_id, legal_entity_id, contractual_discount_set_root_id, contractual_discount_set_revision_id, generation
    ) VALUES (p_tenant_id, p_legal_entity_id, v_root_id, v_revision_id, 1);
    RETURN 1;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.contractual_discount_set_revisions
     WHERE tenant_id = p_tenant_id AND action_invocation_id = p_action_invocation_id
  ) THEN
    RETURN v_head.generation;
  END IF;
  INSERT INTO pricing.contractual_discount_set_revisions (
    contractual_discount_set_revision_id, tenant_id, legal_entity_id, contractual_discount_set_root_id,
    generation, previous_contractual_discount_set_revision_id, action_invocation_id, mutation_kind
  ) VALUES (
    v_revision_id, p_tenant_id, p_legal_entity_id, v_head.contractual_discount_set_root_id,
    v_head.generation + 1, v_head.contractual_discount_set_revision_id, p_action_invocation_id, p_mutation_kind
  );
  UPDATE pricing.contractual_discount_set_heads
     SET contractual_discount_set_revision_id = v_revision_id, generation = v_head.generation + 1
   WHERE contractual_discount_set_head_id = v_head.contractual_discount_set_head_id
     AND generation = v_head.generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contractual Discount set generation changed concurrently' USING ERRCODE = '40001';
  END IF;
  RETURN v_head.generation + 1;
END;
$function$;

CREATE FUNCTION pricing.manage_contractual_discount_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_action_id uuid := (p_input ->> 'actionInvocationId')::uuid;
  v_principal_id uuid := (p_input ->> 'actingPrincipalId')::uuid;
  v_operation_at timestamptz := (p_input ->> 'trustedOperationAt')::timestamptz;
  v_identity jsonb := p_input -> 'identityKey';
  v_identity_ref text;
  v_fingerprint text;
  v_receipt record;
  v_discount record;
  v_head record;
  v_schedule jsonb;
  v_current jsonb;
  v_future jsonb;
  v_revisions jsonb;
  v_new_revision jsonb;
  v_target jsonb;
  v_outcome text;
  v_result jsonb;
  v_discount_id uuid;
  v_revision_id uuid;
  v_schedule_number integer;
  v_revision_number integer;
  v_ack jsonb;
  v_stored_ack jsonb;
  v_ack_fingerprint text;
  v_presented_ack jsonb := p_input -> 'acknowledgement';
  v_effective_boundary timestamptz;
  v_intended_period jsonb;
  v_scheduled_from timestamptz;
  v_scheduled_to timestamptz;
  v_previous_revision_id uuid;
BEGIN
  IF v_identity IS NULL
    OR v_identity ->> 'family' <> 'CONTRACTUAL_DISCOUNT'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR COALESCE(v_identity #>> '{audience,priceGroupRef,tenantId}', v_identity #>> '{audience,counterpartyRef,tenantId}') <> p_tenant_id::text
  THEN
    RAISE EXCEPTION 'Contractual Discount command scope is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_input ->> 'intent' = 'CREATE'
    AND p_input -> 'expectedState' IS DISTINCT FROM '{"state":"ABSENT"}'::jsonb
  THEN
    RAISE EXCEPTION 'Contractual Discount CREATE requires exact expected ABSENT state' USING ERRCODE = '22023';
  END IF;
  v_identity_ref := pricing.contractual_discount_identity_ref_v1(v_identity);
  v_fingerprint := pricing.management_fingerprint_v1(
    p_input - 'trustedOperationAt' - 'requestCorrelationId' - 'acknowledgement'
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || v_action_id::text, 0));
  SELECT * INTO v_receipt FROM pricing.contractual_discount_action_invocation_receipts
   WHERE tenant_id = p_tenant_id AND action_invocation_id = v_action_id;
  IF FOUND THEN
    IF v_receipt.legal_entity_id = p_legal_entity_id
      AND v_receipt.acting_principal_id = v_principal_id
      AND v_receipt.command_fingerprint = v_fingerprint THEN
      RETURN QUERY SELECT v_receipt.outcome;
    ELSE
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'IDENTITY_MISMATCH'
      );
    END IF;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || v_identity_ref, 0));
  SELECT discount.* INTO v_discount FROM pricing.contractual_discounts AS discount
   WHERE discount.tenant_id = p_tenant_id
     AND discount.legal_entity_id = p_legal_entity_id
     AND discount.identity_ref = v_identity_ref;

  IF p_input ->> 'intent' = 'CREATE' THEN
    IF v_discount.discount_id IS NOT NULL THEN
      v_result := jsonb_build_object(
        'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'EXPECTED_CURRENT_STALE'
      );
    ELSE
      v_discount_id := gen_random_uuid();
      v_revision_id := gen_random_uuid();
      v_new_revision := jsonb_build_object(
        'definition', jsonb_build_object(
          'discountId', v_discount_id,
          'identityKey', v_identity,
          'revision', jsonb_build_object(
            'configuredEffect', p_input -> 'configuredEffect',
            'effectiveFrom', p_input #>> '{effectivePeriod,effectiveFrom}',
            'revision', 1,
            'revisionId', v_revision_id
          )
        ),
        'effectivePeriod', p_input -> 'effectivePeriod',
        'lineage', jsonb_build_object('correctedRevisionId', NULL, 'kind', 'INITIAL', 'previousRevisionId', NULL)
      );
      v_schedule := pricing.contractual_discount_schedule_at_v1(jsonb_build_object(
        'discountId', v_discount_id,
        'identityKey', v_identity,
        'revisions', jsonb_build_array(v_new_revision),
        'scheduleRevision', 1
      ), v_operation_at);
      INSERT INTO pricing.contractual_discounts (
        discount_id, tenant_id, legal_entity_id, identity_ref, identity_key, created_by_action_invocation_id
      ) VALUES (v_discount_id, p_tenant_id, p_legal_entity_id, v_identity_ref, v_identity, v_action_id);
      INSERT INTO pricing.contractual_discount_revisions (
        contractual_discount_revision_id, tenant_id, legal_entity_id, discount_id, schedule_revision,
        schedule, action_invocation_id, command_fingerprint, acting_principal_id, reason
      ) VALUES (
        gen_random_uuid(), p_tenant_id, p_legal_entity_id, v_discount_id, 1,
        v_schedule, v_action_id, v_fingerprint, v_principal_id, p_input ->> 'reason'
      ) RETURNING contractual_discount_revision_id INTO v_revision_id;
      INSERT INTO pricing.contractual_discount_schedule_heads (
        tenant_id, legal_entity_id, discount_id, contractual_discount_revision_id, schedule_revision
      ) VALUES (p_tenant_id, p_legal_entity_id, v_discount_id, v_revision_id, 1);
      PERFORM pricing.advance_contractual_discount_set_v1(p_tenant_id, p_legal_entity_id, v_action_id, 'DISCOUNT_CREATED');
      v_result := jsonb_build_object('outcome', 'CONTRACTUAL_DISCOUNT_CREATED', 'schedule', v_schedule);
    END IF;
  ELSE
    IF v_discount.discount_id IS NULL THEN
      v_result := jsonb_build_object(
        'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'IDENTITY_MISMATCH'
      );
    ELSE
      SELECT head.*, revision.schedule INTO v_head
        FROM pricing.contractual_discount_schedule_heads AS head
        JOIN pricing.contractual_discount_revisions AS revision
          ON revision.contractual_discount_revision_id = head.contractual_discount_revision_id
       WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id
         AND head.discount_id = v_discount.discount_id
       FOR UPDATE OF head;
      v_schedule := pricing.contractual_discount_schedule_at_v1(v_head.schedule, v_operation_at);
      v_current := v_schedule -> 'current';
      IF p_input ->> 'intent' IN ('VALUE_ONLY_CURRENT', 'RETIRE_CURRENT') THEN
        IF v_current IS NULL OR pricing.canonicalize_management_json_v1(p_input -> 'expectedCurrent') <>
          pricing.canonicalize_management_json_v1(jsonb_build_object(
            'discountId', v_discount.discount_id,
            'effectivePeriod', v_current -> 'effectivePeriod',
            'identityKey', v_identity,
            'revision', v_current #> '{definition,revision,revision}',
            'revisionId', v_current #> '{definition,revision,revisionId}',
            'scheduleRevision', v_head.schedule_revision
          ))
        THEN
          v_result := jsonb_build_object(
            'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'EXPECTED_CURRENT_STALE'
          );
        ELSE
          v_effective_boundary := CASE
            WHEN v_presented_ack IS NULL THEN v_operation_at
            WHEN p_input ->> 'intent' = 'VALUE_ONLY_CURRENT'
              THEN (v_presented_ack #>> '{intendedEffectivePeriod,effectiveFrom}')::timestamptz
            ELSE (v_presented_ack #>> '{intendedEffectivePeriod,effectiveTo}')::timestamptz
          END;
          v_intended_period := CASE WHEN p_input ->> 'intent' = 'VALUE_ONLY_CURRENT'
            THEN jsonb_build_object(
              'effectiveFrom', pricing.management_instant_v1(v_effective_boundary),
              'effectiveTo', v_current #> '{effectivePeriod,effectiveTo}'
            )
            ELSE jsonb_build_object(
              'effectiveFrom', v_current #>> '{effectivePeriod,effectiveFrom}',
              'effectiveTo', pricing.management_instant_v1(v_effective_boundary)
            )
          END;
          v_future := v_schedule -> 'future';
          IF jsonb_array_length(v_future) > 0 THEN
            v_ack := jsonb_build_object(
              'actingPrincipalId', v_principal_id,
              'discountId', v_discount.discount_id,
              'identityKey', v_identity,
              'intendedConfiguredEffect', COALESCE(p_input -> 'configuredEffect', v_current #> '{definition,revision,configuredEffect}'),
              'intendedEffectivePeriod', v_intended_period,
              'intent', p_input ->> 'intent',
              'presentedFuture', v_future,
              'scheduleRevision', v_head.schedule_revision,
              'targetEffectivePeriod', v_current -> 'effectivePeriod',
              'targetRevisionId', v_current #> '{definition,revision,revisionId}'
            );
            -- Bind every presented schedule and target field to the operator's exact intent.
            v_ack_fingerprint := pricing.management_fingerprint_v1(v_ack);
            v_ack := v_ack || jsonb_build_object('fingerprint', v_ack_fingerprint);
            IF v_presented_ack IS NULL THEN
              INSERT INTO pricing.contractual_discount_schedule_acknowledgements (
                tenant_id, legal_entity_id, discount_id, fingerprint, acknowledgement, issued_by_principal_id
              ) VALUES (
                p_tenant_id, p_legal_entity_id, v_discount.discount_id,
                v_ack_fingerprint, v_ack, v_principal_id
              )
              ON CONFLICT (tenant_id, fingerprint) DO NOTHING;
              v_result := jsonb_build_object(
                'outcome', 'CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED', 'acknowledgement', v_ack
              );
            ELSE
              SELECT acknowledgement INTO v_stored_ack
                FROM pricing.contractual_discount_schedule_acknowledgements
               WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
                 AND discount_id = v_discount.discount_id AND fingerprint = v_ack_fingerprint
                 AND issued_by_principal_id = v_principal_id;
            END IF;
            IF v_presented_ack IS NOT NULL
              AND (v_presented_ack IS DISTINCT FROM v_ack
              OR v_stored_ack IS DISTINCT FROM v_ack
              ) THEN
              v_result := jsonb_build_object(
                'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'ACKNOWLEDGEMENT_STALE'
              );
            END IF;
          END IF;
          IF v_result IS NULL THEN
            IF p_input ->> 'intent' = 'VALUE_ONLY_CURRENT'
              AND pricing.canonicalize_management_json_v1(v_current #> '{definition,revision,configuredEffect}') =
                pricing.canonicalize_management_json_v1(p_input -> 'configuredEffect')
              AND v_effective_boundary = (v_current #>> '{effectivePeriod,effectiveFrom}')::timestamptz
            THEN
              v_result := jsonb_build_object('outcome', 'CONTRACTUAL_DISCOUNT_UNCHANGED', 'schedule', v_schedule);
            ELSIF v_effective_boundary <= (v_current #>> '{effectivePeriod,effectiveFrom}')::timestamptz
              OR (v_current #> '{effectivePeriod,effectiveTo}') <> 'null'::jsonb
                AND v_effective_boundary >= (v_current #>> '{effectivePeriod,effectiveTo}')::timestamptz
            THEN
              v_result := jsonb_build_object(
                'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'BOUNDARY_CROSSED'
              );
            ELSE
              v_schedule_number := v_head.schedule_revision + 1;
              SELECT COALESCE(max((value #>> '{definition,revision,revision}')::integer), 0) + 1
                INTO v_revision_number FROM jsonb_array_elements(v_schedule -> 'revisions');
              v_revision_id := gen_random_uuid();
              v_new_revision := jsonb_build_object(
                'definition', jsonb_build_object(
                  'discountId', v_discount.discount_id,
                  'identityKey', v_identity,
                  'revision', jsonb_build_object(
                    'configuredEffect', COALESCE(p_input -> 'configuredEffect', v_current #> '{definition,revision,configuredEffect}'),
                    'effectiveFrom', CASE WHEN p_input ->> 'intent' = 'RETIRE_CURRENT'
                      THEN v_current #>> '{effectivePeriod,effectiveFrom}' ELSE pricing.management_instant_v1(v_effective_boundary) END,
                    'revision', v_revision_number,
                    'revisionId', v_revision_id
                  )
                ),
                'effectivePeriod', CASE WHEN p_input ->> 'intent' = 'RETIRE_CURRENT'
                  THEN jsonb_build_object('effectiveFrom', v_current #>> '{effectivePeriod,effectiveFrom}', 'effectiveTo', pricing.management_instant_v1(v_effective_boundary))
                  ELSE jsonb_build_object('effectiveFrom', pricing.management_instant_v1(v_effective_boundary),
                    'effectiveTo', v_current #> '{effectivePeriod,effectiveTo}') END,
                'lineage', jsonb_build_object(
                  'correctedRevisionId', NULL,
                  'kind', CASE WHEN p_input ->> 'intent' = 'RETIRE_CURRENT' THEN 'RETIREMENT' ELSE 'VALUE_ONLY_CURRENT' END,
                  'previousRevisionId', v_current #> '{definition,revision,revisionId}'
                )
              );
              IF p_input ->> 'intent' = 'RETIRE_CURRENT' THEN
                SELECT jsonb_agg(CASE WHEN value #>> '{definition,revision,revisionId}' =
                  v_current #>> '{definition,revision,revisionId}' THEN v_new_revision ELSE value END
                  ORDER BY value #>> '{effectivePeriod,effectiveFrom}')
                  INTO v_revisions FROM jsonb_array_elements(v_schedule -> 'revisions');
              ELSE
                SELECT jsonb_agg(value ORDER BY value #>> '{effectivePeriod,effectiveFrom}',
                  value #>> '{definition,revision,revision}') INTO v_revisions
                  FROM (
                    SELECT CASE WHEN value #>> '{definition,revision,revisionId}' =
                      v_current #>> '{definition,revision,revisionId}'
                      THEN jsonb_set(value, '{effectivePeriod,effectiveTo}', to_jsonb(pricing.management_instant_v1(v_effective_boundary)))
                      ELSE value END AS value
                      FROM jsonb_array_elements(v_schedule -> 'revisions')
                    UNION ALL SELECT v_new_revision
                  ) AS scheduled;
              END IF;
              v_schedule := pricing.contractual_discount_schedule_at_v1(jsonb_build_object(
                'discountId', v_discount.discount_id, 'identityKey', v_identity,
                'revisions', v_revisions, 'scheduleRevision', v_schedule_number
              ), v_operation_at);
              v_outcome := CASE WHEN p_input ->> 'intent' = 'RETIRE_CURRENT'
                THEN 'CONTRACTUAL_DISCOUNT_RETIRED' ELSE 'CONTRACTUAL_DISCOUNT_REVISED' END;
            END IF;
          END IF;
        END IF;
      ELSIF p_input ->> 'intent' = 'SCHEDULE_REVISION' THEN
        IF (p_input ->> 'expectedScheduleRevision')::integer IS DISTINCT FROM v_head.schedule_revision THEN
          v_result := jsonb_build_object(
            'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'EXPECTED_SCHEDULE_STALE'
          );
        ELSE
          BEGIN
            v_scheduled_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
            v_scheduled_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
          EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
            RAISE EXCEPTION 'Contractual Discount scheduled period is invalid' USING ERRCODE = '22023';
          END;
          IF v_scheduled_from IS NULL
            OR v_scheduled_from <= v_operation_at
            OR (v_scheduled_to IS NOT NULL AND v_scheduled_to <= v_scheduled_from)
          THEN
            v_result := jsonb_build_object(
              'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'BOUNDARY_CROSSED'
            );
          ELSIF EXISTS (
            SELECT 1
              FROM jsonb_array_elements(v_schedule -> 'revisions') AS scheduled(value)
             WHERE (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz <
                     COALESCE(v_scheduled_to, 'infinity'::timestamptz)
               AND ((value #> '{effectivePeriod,effectiveTo}') = 'null'::jsonb
                 OR v_scheduled_from < (value #>> '{effectivePeriod,effectiveTo}')::timestamptz)
          ) THEN
            v_result := jsonb_build_object(
              'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'OVERLAPPING_SCHEDULE'
            );
          ELSE
            SELECT (value #>> '{definition,revision,revisionId}')::uuid
              INTO v_previous_revision_id
              FROM jsonb_array_elements(v_schedule -> 'revisions') AS scheduled(value)
             WHERE (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz < v_scheduled_from
             ORDER BY (value #>> '{effectivePeriod,effectiveFrom}')::timestamptz DESC,
                      (value #>> '{definition,revision,revision}')::integer DESC
             LIMIT 1;
            IF v_previous_revision_id IS NULL THEN
              v_result := jsonb_build_object(
                'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'OVERLAPPING_SCHEDULE'
              );
            ELSE
              v_schedule_number := v_head.schedule_revision + 1;
              SELECT COALESCE(max((value #>> '{definition,revision,revision}')::integer), 0) + 1
                INTO v_revision_number FROM jsonb_array_elements(v_schedule -> 'revisions');
              v_revision_id := gen_random_uuid();
              v_new_revision := jsonb_build_object(
                'definition', jsonb_build_object(
                  'discountId', v_discount.discount_id,
                  'identityKey', v_identity,
                  'revision', jsonb_build_object(
                    'configuredEffect', p_input -> 'configuredEffect',
                    'effectiveFrom', pricing.management_instant_v1(v_scheduled_from),
                    'revision', v_revision_number,
                    'revisionId', v_revision_id
                  )
                ),
                'effectivePeriod', jsonb_build_object(
                  'effectiveFrom', pricing.management_instant_v1(v_scheduled_from),
                  'effectiveTo', CASE WHEN v_scheduled_to IS NULL THEN NULL
                    ELSE pricing.management_instant_v1(v_scheduled_to) END
                ),
                'lineage', jsonb_build_object(
                  'correctedRevisionId', NULL,
                  'kind', 'SCHEDULED',
                  'previousRevisionId', v_previous_revision_id
                )
              );
              SELECT jsonb_agg(value ORDER BY value #>> '{effectivePeriod,effectiveFrom}',
                value #>> '{definition,revision,revision}') INTO v_revisions
                FROM (
                  SELECT value FROM jsonb_array_elements(v_schedule -> 'revisions')
                  UNION ALL SELECT v_new_revision
                ) AS scheduled;
              v_schedule := pricing.contractual_discount_schedule_at_v1(jsonb_build_object(
                'discountId', v_discount.discount_id, 'identityKey', v_identity,
                'revisions', v_revisions, 'scheduleRevision', v_schedule_number
              ), v_operation_at);
              v_outcome := 'CONTRACTUAL_DISCOUNT_REVISED';
            END IF;
          END IF;
        END IF;
      ELSIF p_input ->> 'intent' = 'CORRECT_REVISION' THEN
        IF (p_input ->> 'expectedScheduleRevision')::integer <> v_head.schedule_revision THEN
          v_result := jsonb_build_object(
            'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'EXPECTED_SCHEDULE_STALE'
          );
        ELSE
          SELECT value INTO v_target FROM jsonb_array_elements(v_schedule -> 'revisions')
           WHERE value #>> '{definition,revision,revisionId}' = p_input ->> 'targetRevisionId';
          IF v_target IS NULL THEN
            v_result := jsonb_build_object(
              'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'TARGET_REVISION_NOT_FOUND'
            );
          ELSIF v_target -> 'effectivePeriod' <> p_input -> 'targetEffectivePeriod' THEN
            v_result := jsonb_build_object(
              'outcome', 'CONTRACTUAL_DISCOUNT_CONFLICT', 'identityKey', v_identity, 'reason', 'EFFECTIVE_BOUNDARY_STALE'
            );
          ELSE
            v_schedule_number := v_head.schedule_revision + 1;
            SELECT max((value #>> '{definition,revision,revision}')::integer) + 1
              INTO v_revision_number FROM jsonb_array_elements(v_schedule -> 'revisions');
            v_revision_id := gen_random_uuid();
            v_new_revision := jsonb_build_object(
              'definition', jsonb_build_object(
                'discountId', v_discount.discount_id, 'identityKey', v_identity,
                'revision', jsonb_build_object(
                  'configuredEffect', p_input -> 'configuredEffect',
                  'effectiveFrom', v_target #>> '{effectivePeriod,effectiveFrom}',
                  'revision', v_revision_number, 'revisionId', v_revision_id
                )
              ),
              'effectivePeriod', v_target -> 'effectivePeriod',
              'lineage', jsonb_build_object(
                'correctedRevisionId', v_target #> '{definition,revision,revisionId}',
                'kind', 'CORRECTION',
                'previousRevisionId', v_target #> '{definition,revision,revisionId}'
              )
            );
            SELECT jsonb_agg(CASE WHEN value #>> '{definition,revision,revisionId}' = p_input ->> 'targetRevisionId'
              THEN v_new_revision ELSE value END ORDER BY value #>> '{effectivePeriod,effectiveFrom}')
              INTO v_revisions FROM jsonb_array_elements(v_schedule -> 'revisions');
            v_schedule := pricing.contractual_discount_schedule_at_v1(jsonb_build_object(
              'discountId', v_discount.discount_id, 'identityKey', v_identity,
              'revisions', v_revisions, 'scheduleRevision', v_schedule_number
            ), v_operation_at);
            v_outcome := 'CONTRACTUAL_DISCOUNT_CORRECTED';
          END IF;
        END IF;
      ELSE
        RAISE EXCEPTION 'Unsupported Contractual Discount intent' USING ERRCODE = '22023';
      END IF;

      IF v_result IS NULL AND v_outcome IS NOT NULL THEN
        INSERT INTO pricing.contractual_discount_revisions (
          tenant_id, legal_entity_id, discount_id, schedule_revision,
          previous_contractual_discount_revision_id, schedule, action_invocation_id,
          command_fingerprint, acting_principal_id, reason
        ) VALUES (
          p_tenant_id, p_legal_entity_id, v_discount.discount_id, v_schedule_number,
          v_head.contractual_discount_revision_id, v_schedule, v_action_id,
          v_fingerprint, v_principal_id, p_input ->> 'reason'
        ) RETURNING contractual_discount_revision_id INTO v_revision_id;
        UPDATE pricing.contractual_discount_schedule_heads
           SET contractual_discount_revision_id = v_revision_id, schedule_revision = v_schedule_number
         WHERE contractual_discount_schedule_head_id = v_head.contractual_discount_schedule_head_id
           AND schedule_revision = v_head.schedule_revision;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Contractual Discount schedule changed concurrently' USING ERRCODE = '40001';
        END IF;
        PERFORM pricing.advance_contractual_discount_set_v1(
          p_tenant_id, p_legal_entity_id, v_action_id, 'DISCOUNT_SCHEDULE_CHANGED'
        );
        v_result := jsonb_build_object('outcome', v_outcome, 'schedule', v_schedule);
      END IF;
    END IF;
  END IF;

  INSERT INTO pricing.contractual_discount_action_invocation_receipts (
    tenant_id, legal_entity_id, action_invocation_id, acting_principal_id, command_fingerprint, outcome
  ) VALUES (p_tenant_id, p_legal_entity_id, v_action_id, v_principal_id, v_fingerprint, v_result);
  RETURN QUERY SELECT v_result;
END;
$function$;

DO $policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT * FROM (VALUES
      ('contractual_discount_action_invocation_receipts', 'pricing_contractual_discount_action_receipts_scope_select'),
      ('contractual_discount_action_invocation_receipts', 'pricing_contractual_discount_action_receipts_scope_insert'),
      ('contractual_discount_revisions', 'pricing_contractual_discount_revisions_scope_select'),
      ('contractual_discount_revisions', 'pricing_contractual_discount_revisions_scope_insert'),
      ('contractual_discount_schedule_acknowledgements', 'pricing_contractual_discount_schedule_acknowledgements_scope_select'),
      ('contractual_discount_schedule_acknowledgements', 'pricing_contractual_discount_schedule_acknowledgements_scope_insert'),
      ('contractual_discount_schedule_heads', 'pricing_contractual_discount_schedule_heads_scope_select'),
      ('contractual_discount_schedule_heads', 'pricing_contractual_discount_schedule_heads_scope_insert'),
      ('contractual_discount_schedule_heads', 'pricing_contractual_discount_schedule_heads_scope_update'),
      ('contractual_discount_set_heads', 'pricing_contractual_discount_set_heads_scope_select'),
      ('contractual_discount_set_heads', 'pricing_contractual_discount_set_heads_scope_insert'),
      ('contractual_discount_set_heads', 'pricing_contractual_discount_set_heads_scope_update'),
      ('contractual_discount_set_revisions', 'pricing_contractual_discount_set_revisions_scope_select'),
      ('contractual_discount_set_revisions', 'pricing_contractual_discount_set_revisions_scope_insert'),
      ('contractual_discount_set_roots', 'pricing_contractual_discount_set_roots_scope_select'),
      ('contractual_discount_set_roots', 'pricing_contractual_discount_set_roots_scope_insert'),
      ('contractual_discounts', 'pricing_contractual_discounts_scope_select'),
      ('contractual_discounts', 'pricing_contractual_discounts_scope_insert'),
      ('zero_floor_action_invocation_receipts', 'pricing_zero_floor_action_receipts_scope_select'),
      ('zero_floor_action_invocation_receipts', 'pricing_zero_floor_action_receipts_scope_insert'),
      ('zero_floor_authorization_revisions', 'pricing_zero_floor_authorization_revisions_scope_select'),
      ('zero_floor_authorization_revisions', 'pricing_zero_floor_authorization_revisions_scope_insert'),
      ('zero_floor_authorization_schedule_heads', 'pricing_zero_floor_authorization_schedule_heads_scope_select'),
      ('zero_floor_authorization_schedule_heads', 'pricing_zero_floor_authorization_schedule_heads_scope_insert'),
      ('zero_floor_authorization_schedule_heads', 'pricing_zero_floor_authorization_schedule_heads_scope_update'),
      ('zero_floor_authorizations', 'pricing_zero_floor_authorizations_scope_select'),
      ('zero_floor_authorizations', 'pricing_zero_floor_authorizations_scope_insert'),
      ('zero_floor_governance_approvals', 'pricing_zero_floor_governance_approvals_scope_select'),
      ('zero_floor_governance_approvals', 'pricing_zero_floor_governance_approvals_scope_insert'),
      ('zero_floor_schedule_acknowledgements', 'pricing_zero_floor_schedule_acknowledgements_scope_select'),
      ('zero_floor_schedule_acknowledgements', 'pricing_zero_floor_schedule_acknowledgements_scope_insert'),
      ('zero_floor_set_heads', 'pricing_zero_floor_set_heads_scope_select'),
      ('zero_floor_set_heads', 'pricing_zero_floor_set_heads_scope_insert'),
      ('zero_floor_set_heads', 'pricing_zero_floor_set_heads_scope_update'),
      ('zero_floor_set_revisions', 'pricing_zero_floor_set_revisions_scope_select'),
      ('zero_floor_set_revisions', 'pricing_zero_floor_set_revisions_scope_insert'),
      ('zero_floor_set_roots', 'pricing_zero_floor_set_roots_scope_select'),
      ('zero_floor_set_roots', 'pricing_zero_floor_set_roots_scope_insert')
    ) AS policies(table_name, policy_name)
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER POLICY %I ON pricing.%I TO ontos_runtime, pricing_management_routine_writer',
      v_policy.policy_name,
      v_policy.table_name
    );
  END LOOP;
END;
$policies$;

GRANT SELECT, INSERT ON TABLE
  pricing.contractual_discount_action_invocation_receipts,
  pricing.contractual_discount_revisions,
  pricing.contractual_discount_schedule_acknowledgements,
  pricing.contractual_discounts,
  pricing.contractual_discount_set_revisions,
  pricing.contractual_discount_set_roots,
  pricing.zero_floor_action_invocation_receipts,
  pricing.zero_floor_authorization_revisions,
  pricing.zero_floor_authorizations,
  pricing.zero_floor_governance_approvals,
  pricing.zero_floor_schedule_acknowledgements,
  pricing.zero_floor_set_revisions,
  pricing.zero_floor_set_roots
TO pricing_management_routine_writer;

GRANT SELECT, INSERT, UPDATE ON TABLE
  pricing.contractual_discount_schedule_heads,
  pricing.contractual_discount_set_heads,
  pricing.zero_floor_authorization_schedule_heads,
  pricing.zero_floor_set_heads
TO pricing_management_routine_writer;

REVOKE INSERT, UPDATE, DELETE ON TABLE
  pricing.contractual_discount_action_invocation_receipts,
  pricing.contractual_discount_revisions,
  pricing.contractual_discount_schedule_acknowledgements,
  pricing.contractual_discount_schedule_heads,
  pricing.contractual_discounts,
  pricing.contractual_discount_set_heads,
  pricing.contractual_discount_set_revisions,
  pricing.contractual_discount_set_roots,
  pricing.zero_floor_action_invocation_receipts,
  pricing.zero_floor_authorization_revisions,
  pricing.zero_floor_authorization_schedule_heads,
  pricing.zero_floor_authorizations,
  pricing.zero_floor_governance_approvals,
  pricing.zero_floor_schedule_acknowledgements,
  pricing.zero_floor_set_heads,
  pricing.zero_floor_set_revisions,
  pricing.zero_floor_set_roots
FROM ontos_runtime;
GRANT SELECT ON TABLE
  pricing.contractual_discount_action_invocation_receipts,
  pricing.contractual_discount_revisions,
  pricing.contractual_discount_schedule_acknowledgements,
  pricing.contractual_discount_schedule_heads,
  pricing.contractual_discounts,
  pricing.contractual_discount_set_heads,
  pricing.contractual_discount_set_revisions,
  pricing.contractual_discount_set_roots,
  pricing.zero_floor_action_invocation_receipts,
  pricing.zero_floor_authorization_revisions,
  pricing.zero_floor_authorization_schedule_heads,
  pricing.zero_floor_authorizations,
  pricing.zero_floor_governance_approvals,
  pricing.zero_floor_schedule_acknowledgements,
  pricing.zero_floor_set_heads,
  pricing.zero_floor_set_revisions,
  pricing.zero_floor_set_roots
TO ontos_runtime;

GRANT EXECUTE ON FUNCTION pricing.canonicalize_management_json_v1(jsonb),
  pricing.management_fingerprint_v1(jsonb),
  pricing.management_instant_v1(timestamptz),
  pricing.zero_floor_predicate_ref_v1(jsonb),
  pricing.zero_floor_authorization_fingerprint_v1(jsonb),
  pricing.zero_floor_schedule_at_v1(jsonb),
  pricing.uri_encode_component_v1(text),
  pricing.contractual_discount_identity_ref_v1(jsonb),
  pricing.contractual_discount_predicate_ref_v1(jsonb),
  pricing.contractual_discount_schedule_at_v1(jsonb,timestamptz)
TO pricing_management_routine_writer;

ALTER FUNCTION pricing.ensure_zero_floor_set_v1(uuid,uuid,text) SECURITY DEFINER;
ALTER FUNCTION pricing.advance_zero_floor_set_v1(uuid,uuid,text,text) SECURITY DEFINER;
ALTER FUNCTION pricing.advance_contractual_discount_set_v1(uuid,uuid,uuid,text) SECURITY DEFINER;
ALTER FUNCTION pricing.manage_contractual_discount_v1(uuid,uuid,jsonb) SECURITY DEFINER;

GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.ensure_zero_floor_set_v1(uuid,uuid,text)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.advance_zero_floor_set_v1(uuid,uuid,text,text)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.advance_contractual_discount_set_v1(uuid,uuid,uuid,text)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.manage_contractual_discount_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pricing FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.canonicalize_management_json_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.management_fingerprint_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.management_instant_v1(timestamptz) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_predicate_ref_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_authorization_fingerprint_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_schedule_at_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.uri_encode_component_v1(text) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.contractual_discount_identity_ref_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.contractual_discount_predicate_ref_v1(jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.contractual_discount_schedule_at_v1(jsonb,timestamptz) TO ontos_runtime;
REVOKE ALL ON FUNCTION pricing.ensure_zero_floor_set_v1(uuid,uuid,text) FROM ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_zero_floor_set_v1(uuid,uuid,text,text) FROM ontos_runtime;
REVOKE ALL ON FUNCTION pricing.advance_contractual_discount_set_v1(uuid,uuid,uuid,text) FROM ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.manage_contractual_discount_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.lookup_contractual_discount_result_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_contractual_discount_set_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_contractual_discount_set_generation_v1(uuid,uuid,jsonb) TO ontos_runtime;
