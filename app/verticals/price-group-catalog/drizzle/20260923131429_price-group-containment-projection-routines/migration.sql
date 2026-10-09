-- Custom SQL migration file, put your code below! --
ALTER TABLE "price_group_catalog"."price_group_containment_projection_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "price_group_catalog"."price_group_containment_projection_intents" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "price_group_catalog"."price_group_containment_projection_intents" FROM "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."create_price_group_with_containment_projection"(
  p_tenant_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_outcome jsonb;
  v_definition jsonb;
  v_intent price_group_catalog.price_group_containment_projection_intents%ROWTYPE;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);

  SELECT created.payload INTO v_outcome
  FROM price_group_catalog.create_price_group(p_tenant_id, p_input) AS created;

  IF v_outcome->>'_tag' NOT IN ('accepted', 'replayed') THEN
    RETURN QUERY SELECT v_outcome;
    RETURN;
  END IF;

  v_definition := v_outcome->'definition';
  INSERT INTO price_group_catalog.price_group_containment_projection_intents (
    tenant_id,
    price_group_id,
    definition_revision_id,
    definition_catalog_revision,
    source_action_invocation_id,
    operation,
    catalog_version,
    state,
    requested_at
  ) VALUES (
    p_tenant_id,
    (v_definition#>>'{priceGroupRef,resourceId}')::uuid,
    (v_definition->>'definitionRevisionId')::uuid,
    (v_definition->>'acceptedCatalogRevision')::bigint,
    (p_input->>'actionInvocationId')::uuid,
    'TOUCH_CONTAINMENT',
    '1',
    'PENDING',
    (p_input->>'trustedEffectiveAt')::timestamptz
  )
  ON CONFLICT (tenant_id, source_action_invocation_id) DO NOTHING;

  SELECT intent.* INTO v_intent
  FROM price_group_catalog.price_group_containment_projection_intents AS intent
  WHERE intent.tenant_id = p_tenant_id
    AND intent.source_action_invocation_id = (p_input->>'actionInvocationId')::uuid;

  IF NOT FOUND
    OR v_intent.price_group_id <> (v_definition#>>'{priceGroupRef,resourceId}')::uuid
    OR v_intent.definition_revision_id <> (v_definition->>'definitionRevisionId')::uuid
    OR v_intent.definition_catalog_revision <> (v_definition->>'acceptedCatalogRevision')::bigint
  THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'idempotency_conflict');
    RETURN;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    '_tag', v_outcome->>'_tag',
    'definition', v_definition,
    'projection', jsonb_build_object(
      'mutationId', v_intent.mutation_id,
      'operation', 'touch_containment',
      'staged', true
    )
  );
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."read_price_group_containment_projection_intent"(
  p_tenant_id uuid,
  p_mutation_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_intent price_group_catalog.price_group_containment_projection_intents%ROWTYPE;
  v_definition jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);

  SELECT intent.* INTO v_intent
  FROM price_group_catalog.price_group_containment_projection_intents AS intent
  WHERE intent.tenant_id = p_tenant_id
    AND intent.mutation_id = p_mutation_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found');
    RETURN;
  END IF;

  v_definition := price_group_catalog.definition_json(
    p_tenant_id,
    v_intent.price_group_id,
    v_intent.definition_revision_id,
    v_intent.definition_catalog_revision
  );

  IF v_definition IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found');
    RETURN;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'found',
    'intent', jsonb_build_object(
      'catalogVersion', v_intent.catalog_version,
      'completedAt', CASE WHEN v_intent.completed_at IS NULL THEN NULL
        ELSE to_char(v_intent.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'definition', v_definition,
      'mutationId', v_intent.mutation_id,
      'operation', 'touch_containment',
      'priceGroupRef', v_definition->'priceGroupRef',
      'pricingCatalogRef', jsonb_build_object(
        'moduleId', 'pricing.price-group-catalog',
        'resourceId', p_tenant_id,
        'resourceType', 'pricing.price-group-catalog.price-group-catalog-root',
        'tenantId', p_tenant_id
      ),
      'requestedAt', to_char(v_intent.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'schemaVersion', '1',
      'sourceActionInvocationId', v_intent.source_action_invocation_id,
      'state', v_intent.state
    )
  );
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."complete_price_group_containment_projection"(
  p_tenant_id uuid,
  p_mutation_id uuid,
  p_completed_at timestamptz
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_intent_payload jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);

  UPDATE price_group_catalog.price_group_containment_projection_intents AS intent
  SET state = 'APPLIED',
      completed_at = greatest(p_completed_at, intent.requested_at)
  WHERE intent.tenant_id = p_tenant_id
    AND intent.mutation_id = p_mutation_id
    AND intent.state = 'PENDING';

  SELECT current_intent.payload INTO v_intent_payload
  FROM price_group_catalog.read_price_group_containment_projection_intent(p_tenant_id, p_mutation_id) AS current_intent;

  IF v_intent_payload->>'_tag' <> 'found' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found');
    RETURN;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'completed',
    'completion', v_intent_payload->'intent'
  );
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."create_price_group"(uuid, jsonb) FROM "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."create_price_group_with_containment_projection"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."read_price_group_containment_projection_intent"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."complete_price_group_containment_projection"(uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."create_price_group_with_containment_projection"(uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."read_price_group_containment_projection_intent"(uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."complete_price_group_containment_projection"(uuid, uuid, timestamptz) TO "ontos_runtime";
