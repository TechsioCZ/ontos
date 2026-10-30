-- #1277: derive the owner's exact fingerprint before entering the existing strict,
-- scoped Current reader and immutable proof-receipt writer. Supplied references
-- remain the responsibility of the original strict entrypoint.
CREATE FUNCTION pricing.read_current_zero_floor_authorization_set_for_query_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_query jsonb := p_input -> 'query';
  v_keys text[] := ARRAY[
    'audienceRefs', 'catalogSelection', 'commercialScope', 'currencyCode',
    'effectiveAt', 'materialRevisionRefs', 'pricingBasis', 'tenantId'
  ];
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR p_input - 'query' <> '{}'::jsonb
    OR jsonb_typeof(v_query) IS DISTINCT FROM 'object'
    OR NOT (v_query ?& v_keys)
    OR v_query - v_keys <> '{}'::jsonb
    OR jsonb_typeof(v_query -> 'audienceRefs') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_query -> 'materialRevisionRefs') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'ZERO_FLOOR bootstrap requires one complete query without a supplied predicate'
      USING ERRCODE = '22023';
  END IF;
  v_query := v_query || jsonb_build_object(
    'exactPredicateRef', pricing.zero_floor_predicate_ref_v1(v_query));
  RETURN QUERY SELECT current_set.payload
    FROM pricing.read_current_zero_floor_authorization_set_v1(
      p_tenant_id, p_legal_entity_id, jsonb_build_object('query', v_query)) AS current_set;
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_current_zero_floor_authorization_set_for_query_v1(uuid,uuid,jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_current_zero_floor_authorization_set_for_query_v1(uuid,uuid,jsonb)
  TO ontos_runtime;
