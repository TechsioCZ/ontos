CREATE FUNCTION pricing.read_price_group_source_prices_v1(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS NULL
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id',true),'')::uuid
    OR (p_input#>>'{priceGroupRef,tenantId}')::uuid IS DISTINCT FROM p_tenant_id
  THEN RAISE EXCEPTION 'Pricing source group scope mismatch' USING ERRCODE = '42501'; END IF;
  IF (p_input->>'limit')::integer NOT BETWEEN 1 AND 100 OR (p_input->>'offset')::integer < 0
    OR nullif(p_input#>>'{sourceSystem,ownerModuleId}','') IS NULL OR nullif(p_input#>>'{sourceSystem,sourceSystemRef}','') IS NULL
  THEN RAISE EXCEPTION 'Pricing source group query invalid' USING ERRCODE = '22023'; END IF;
  RETURN QUERY WITH evaluated AS MATERIALIZED (
    SELECT price.price_id, definition.payload AS definition,
      CASE WHEN definition.payload->>'outcome' = 'PRICE_DEFINITION_CURRENT' THEN
        pricing.price_source_provenance_json_v1(p_tenant_id,p_legal_entity_id,price.price_id,(definition.payload#>>'{definition,revision,revisionId}')::uuid)
      END AS provenance
    FROM pricing.prices AS price
    CROSS JOIN LATERAL pricing.read_current_price_definition_v1(p_tenant_id,p_legal_entity_id,price.price_id) AS definition
    WHERE price.tenant_id = p_tenant_id AND price.legal_entity_id = p_legal_entity_id
      AND price.price_group_selector = jsonb_build_object('kind','PRICE_GROUP','priceGroupRef',p_input->'priceGroupRef')
  ), filtered AS MATERIALIZED (
    SELECT * FROM evaluated
    WHERE provenance#>>'{evidence,sourceAssertion,sourceRecord,sourceSystem,ownerModuleId}' = p_input#>>'{sourceSystem,ownerModuleId}'
      AND provenance#>>'{evidence,sourceAssertion,sourceRecord,sourceSystem,sourceSystemRef}' = p_input#>>'{sourceSystem,sourceSystemRef}'
      OR (definition->>'outcome' <> 'PRICE_DEFINITION_CURRENT' AND EXISTS (
        SELECT 1 FROM pricing.price_source_assertions AS source
        WHERE source.tenant_id = p_tenant_id AND source.legal_entity_id = p_legal_entity_id AND source.price_id = evaluated.price_id
          AND source.source_owner_module_id = p_input#>>'{sourceSystem,ownerModuleId}'
          AND source.source_system_ref = p_input#>>'{sourceSystem,sourceSystemRef}'
      ))
  ), page AS (
    SELECT * FROM filtered ORDER BY price_id LIMIT (p_input->>'limit')::integer OFFSET (p_input->>'offset')::integer
  ) SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluated WHERE definition->>'outcome' = 'PRICE_DEFINITION_CURRENT' AND provenance IS NULL)
    THEN jsonb_build_object('unavailable',true)
    ELSE jsonb_build_object('count',(SELECT count(*) FROM filtered),'limit',(p_input->>'limit')::integer,'offset',(p_input->>'offset')::integer,
      'prices',coalesce((SELECT jsonb_agg(jsonb_build_object('price',definition) ||
        CASE WHEN definition->>'outcome' = 'PRICE_DEFINITION_CURRENT' THEN jsonb_build_object('provenance',provenance) ELSE '{}'::jsonb END ORDER BY price_id) FROM page),'[]'::jsonb)) END;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.read_price_group_source_prices_v1(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.read_price_group_source_prices_v1(uuid,uuid,jsonb) TO ontos_runtime;
