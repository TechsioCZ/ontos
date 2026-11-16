CREATE TABLE "price_group_catalog"."price_group_source_correlations" (
	"tenant_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"route_id" text NOT NULL,
	"namespace" text NOT NULL,
	"record_key" text NOT NULL,
	"mapping_version" text NOT NULL,
	"price_group_id" uuid NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_source_identity_uk" UNIQUE("tenant_id","issuer","route_id","namespace","record_key"),
	CONSTRAINT "price_group_source_qualifiers_ck" CHECK (length("issuer") between 1 and 300 and "issuer" = btrim("issuer") and length("route_id") between 1 and 300 and "route_id" = btrim("route_id") and length("namespace") between 1 and 300 and "namespace" = btrim("namespace") and length("record_key") between 1 and 300 and "record_key" = btrim("record_key") and length("mapping_version") between 1 and 300 and "mapping_version" = btrim("mapping_version"))
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_source_correlations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_source_correlations" ADD CONSTRAINT "price_group_source_group_fk" FOREIGN KEY ("tenant_id","price_group_id") REFERENCES "price_group_catalog"."price_groups"("tenant_id","price_group_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_source_correlations" ADD CONSTRAINT "price_group_source_invocation_fk" FOREIGN KEY ("tenant_id","created_by_action_invocation_id") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","action_invocation_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "price_group_source_scope_select" ON "price_group_catalog"."price_group_source_correlations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_source_scope_insert" ON "price_group_catalog"."price_group_source_correlations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_source_scope_update" ON "price_group_catalog"."price_group_source_correlations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_source_scope_delete" ON "price_group_catalog"."price_group_source_correlations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE price_group_catalog.price_group_source_correlations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE price_group_catalog.price_group_source_correlations FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
-- The private wrappers preserve the existing owner lifecycle and transaction. A source collision
-- raises, so both the native mutation and correlation roll back together.
CREATE FUNCTION price_group_catalog.bind_price_group_source_correlation(p_tenant_id uuid, p_input jsonb, p_group_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_source jsonb := p_input->'sourceCorrelation'; v_bound uuid;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  IF v_source IS NULL THEN RETURN; END IF;
  INSERT INTO price_group_catalog.price_group_source_correlations
    (tenant_id, issuer, route_id, namespace, record_key, mapping_version, price_group_id, created_by_action_invocation_id)
  VALUES (p_tenant_id, v_source->>'issuer', v_source->>'routeId', v_source->>'namespace',
    v_source->>'recordKey', v_source->>'mappingVersion', p_group_id, (p_input->>'actionInvocationId')::uuid)
  ON CONFLICT (tenant_id, issuer, route_id, namespace, record_key) DO NOTHING;
  SELECT price_group_id INTO v_bound FROM price_group_catalog.price_group_source_correlations
    WHERE tenant_id = p_tenant_id AND issuer = v_source->>'issuer' AND route_id = v_source->>'routeId'
      AND namespace = v_source->>'namespace' AND record_key = v_source->>'recordKey' FOR UPDATE;
  IF v_bound IS DISTINCT FROM p_group_id THEN
    RAISE EXCEPTION 'Source identity already belongs to another Price Group'
      USING ERRCODE = '23505', CONSTRAINT = 'price_group_source_identity_uk';
  END IF;
  UPDATE price_group_catalog.price_group_source_correlations SET mapping_version = v_source->>'mappingVersion'
    WHERE tenant_id = p_tenant_id AND issuer = v_source->>'issuer' AND route_id = v_source->>'routeId'
      AND namespace = v_source->>'namespace' AND record_key = v_source->>'recordKey';
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION price_group_catalog.bind_price_group_source_correlation(uuid,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION price_group_catalog.create_price_group_with_source_correlation(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_outcome jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT result.payload INTO v_outcome FROM price_group_catalog.create_price_group_with_complete_schedule(p_tenant_id,p_input) AS result;
  IF v_outcome->>'_tag' IN ('accepted','replayed') THEN
    PERFORM price_group_catalog.bind_price_group_source_correlation(p_tenant_id,p_input,(v_outcome#>>'{definition,priceGroupRef,resourceId}')::uuid);
  END IF;
  RETURN QUERY SELECT v_outcome;
END $function$;
--> statement-breakpoint
CREATE FUNCTION price_group_catalog.create_definition_revision_with_source_correlation(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_outcome jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT result.payload INTO v_outcome FROM price_group_catalog.create_definition_revision_with_continuity(p_tenant_id,p_input) AS result;
  IF v_outcome->>'_tag' IN ('accepted','replayed') THEN
    PERFORM price_group_catalog.bind_price_group_source_correlation(p_tenant_id,p_input,(v_outcome#>>'{definition,priceGroupRef,resourceId}')::uuid);
  END IF;
  RETURN QUERY SELECT v_outcome;
END $function$;
--> statement-breakpoint
CREATE FUNCTION price_group_catalog.read_price_group_source_associations(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  IF (p_input->>'limit')::integer NOT BETWEEN 1 AND 100 OR (p_input->>'offset')::integer < 0 THEN
    RAISE EXCEPTION 'Invalid pagination' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY WITH filtered AS MATERIALIZED (
    SELECT source.* FROM price_group_catalog.price_group_source_correlations AS source
    WHERE source.tenant_id = p_tenant_id AND source.issuer = p_input->>'issuer'
      AND source.route_id = p_input->>'routeId' AND source.namespace = p_input->>'namespace'
      AND (NOT p_input ? 'recordKey' OR source.record_key = p_input->>'recordKey')
  ), page AS (
    SELECT * FROM filtered ORDER BY record_key COLLATE "C", price_group_id LIMIT (p_input->>'limit')::integer OFFSET (p_input->>'offset')::integer
  ) SELECT jsonb_build_object(
    'count',(SELECT count(*) FROM filtered),'limit',(p_input->>'limit')::integer,'offset',(p_input->>'offset')::integer,
    'associations',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'priceGroupRef',jsonb_build_object('moduleId','pricing.price-group-catalog','resourceType','pricing.price-group-catalog.price-group','tenantId',p_tenant_id,'resourceId',page.price_group_id),
      'sourceCorrelation',jsonb_build_object('issuer',page.issuer,'routeId',page.route_id,'namespace',page.namespace,'recordKey',page.record_key,'mappingVersion',page.mapping_version)
    ) ORDER BY page.record_key COLLATE "C", page.price_group_id) FROM page),'[]'::jsonb));
END $function$;
--> statement-breakpoint
CREATE FUNCTION price_group_catalog.read_price_group_operation_receipt(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_entry price_group_catalog.price_group_catalog_ledger%ROWTYPE;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_entry FROM price_group_catalog.price_group_catalog_ledger
    WHERE tenant_id = p_tenant_id AND action_invocation_id = (p_input->>'actionInvocationId')::uuid;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_ABSENT','actionInvocationId',p_input->>'actionInvocationId'); RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_FOUND','receipt',jsonb_build_object(
    'actionInvocationId',v_entry.action_invocation_id,'operationKind',v_entry.operation_kind,
    'catalogRevision',v_entry.catalog_revision,'definitionRevisionId',v_entry.definition_revision_id,
    'priceGroupRef',jsonb_build_object('moduleId','pricing.price-group-catalog','resourceType','pricing.price-group-catalog.price-group','tenantId',p_tenant_id,'resourceId',v_entry.price_group_id)
  ));
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION price_group_catalog.create_price_group_with_source_correlation(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION price_group_catalog.create_definition_revision_with_source_correlation(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION price_group_catalog.read_price_group_source_associations(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION price_group_catalog.read_price_group_operation_receipt(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION price_group_catalog.create_price_group_with_source_correlation(uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION price_group_catalog.create_definition_revision_with_source_correlation(uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION price_group_catalog.read_price_group_source_associations(uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION price_group_catalog.read_price_group_operation_receipt(uuid,jsonb) TO ontos_runtime;
