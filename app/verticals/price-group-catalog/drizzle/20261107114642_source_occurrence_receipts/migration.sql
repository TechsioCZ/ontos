CREATE TABLE "price_group_catalog"."price_group_source_operation_receipts" (
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"business_original_invocation_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"issuer" text NOT NULL,
	"route_id" text NOT NULL,
	"namespace" text NOT NULL,
	"record_key" text NOT NULL,
	"source_occurrence_id" text NOT NULL,
	"intent_hash" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_source_receipt_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "price_group_source_receipt_kind_ck" CHECK ("operation_kind" in ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION')),
	CONSTRAINT "price_group_source_receipt_hash_ck" CHECK ("intent_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "price_group_source_receipt_identity_ck" CHECK (length("issuer") between 1 and 300 and "issuer" = btrim("issuer") and length("route_id") between 1 and 300 and "route_id" = btrim("route_id") and length("namespace") between 1 and 300 and "namespace" = btrim("namespace") and length("record_key") between 1 and 300 and "record_key" = btrim("record_key") and length("source_occurrence_id") between 1 and 300 and "source_occurrence_id" = btrim("source_occurrence_id"))
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_source_operation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "price_group_source_occurrence_uk" ON "price_group_catalog"."price_group_source_operation_receipts" ("tenant_id","issuer","route_id","namespace","record_key","source_occurrence_id","operation_kind") WHERE "action_invocation_id" = "business_original_invocation_id";--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_source_operation_receipts" ADD CONSTRAINT "price_group_source_receipt_business_fk" FOREIGN KEY ("tenant_id","business_original_invocation_id") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","action_invocation_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "price_group_source_receipt_scope_select" ON "price_group_catalog"."price_group_source_operation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_source_operation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_source_receipt_scope_insert" ON "price_group_catalog"."price_group_source_operation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_source_operation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_source_receipt_scope_update" ON "price_group_catalog"."price_group_source_operation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_source_operation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_source_operation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_source_receipt_scope_delete" ON "price_group_catalog"."price_group_source_operation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_source_operation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE price_group_catalog.price_group_source_operation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE price_group_catalog.price_group_source_operation_receipts FROM PUBLIC, ontos_runtime;
CREATE TRIGGER price_group_source_receipts_append_only BEFORE UPDATE OR DELETE ON price_group_catalog.price_group_source_operation_receipts FOR EACH ROW EXECUTE FUNCTION price_group_catalog.reject_append_only_mutation();
--> statement-breakpoint
-- Stable resource identity is never enough to classify a delivery as the same source operation.
-- This opt-in journal stores only safe qualifiers, a canonical intent checksum and immutable ledger refs.
CREATE FUNCTION price_group_catalog.execute_source_occurrence(p_tenant_id uuid, p_input jsonb, p_kind text)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_source jsonb := p_input->'sourceCorrelation';
  v_occurrence text := v_source->>'sourceOccurrenceId';
  v_hash text;
  v_saved price_group_catalog.price_group_source_operation_receipts%ROWTYPE;
  v_original price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_native_input jsonb := p_input;
  v_outcome jsonb;
  v_original_id uuid;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  IF p_kind NOT IN ('CREATE_PRICE_GROUP','CREATE_DEFINITION_REVISION') THEN
    RAISE EXCEPTION 'Invalid source operation kind' USING ERRCODE='22023';
  END IF;
  IF v_occurrence IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text,334));
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((p_input - 'actionInvocationId' - 'actingPrincipalId' - 'trustedEffectiveAt' - 'definitionRevisionId' - 'priceGroupId')::text,'UTF8')),'hex');
    SELECT * INTO v_saved FROM price_group_catalog.price_group_source_operation_receipts
      WHERE tenant_id=p_tenant_id AND action_invocation_id=(p_input->>'actionInvocationId')::uuid;
    IF FOUND THEN
      IF v_saved.intent_hash IS DISTINCT FROM v_hash OR v_saved.operation_kind IS DISTINCT FROM p_kind
        OR v_saved.acting_principal_id IS DISTINCT FROM (p_input->>'actingPrincipalId')::uuid THEN
        RETURN QUERY SELECT jsonb_build_object('_tag','idempotency_conflict'); RETURN;
      END IF;
    ELSE
      SELECT * INTO v_saved FROM price_group_catalog.price_group_source_operation_receipts
        WHERE tenant_id=p_tenant_id AND issuer=v_source->>'issuer' AND route_id=v_source->>'routeId'
          AND namespace=v_source->>'namespace' AND record_key=v_source->>'recordKey'
          AND source_occurrence_id=v_occurrence AND operation_kind=p_kind
          AND action_invocation_id=business_original_invocation_id;
      IF FOUND AND v_saved.intent_hash IS DISTINCT FROM v_hash THEN
        RETURN QUERY SELECT jsonb_build_object('_tag','idempotency_conflict'); RETURN;
      END IF;
    END IF;
    IF v_saved.action_invocation_id IS NOT NULL THEN
      SELECT * INTO STRICT v_original FROM price_group_catalog.price_group_catalog_ledger
        WHERE tenant_id=p_tenant_id AND action_invocation_id=v_saved.business_original_invocation_id AND operation_kind=p_kind;
      v_native_input := p_input || jsonb_build_object('actionInvocationId',v_original.action_invocation_id,
        'actingPrincipalId',v_original.acting_principal_id,'trustedEffectiveAt',v_original.trusted_effective_at);
    END IF;
  END IF;
  IF p_kind='CREATE_PRICE_GROUP' THEN
    SELECT result.payload INTO v_outcome FROM price_group_catalog.create_price_group_with_complete_schedule(p_tenant_id,v_native_input) AS result;
  ELSE
    SELECT result.payload INTO v_outcome FROM price_group_catalog.create_definition_revision_with_continuity(p_tenant_id,v_native_input) AS result;
  END IF;
  IF v_outcome->>'_tag' NOT IN ('accepted','replayed') THEN
    RETURN QUERY SELECT v_outcome; RETURN;
  END IF;
  -- Only successful native acceptance/replay may bind source identity or record a receipt.
  PERFORM price_group_catalog.bind_price_group_source_correlation(p_tenant_id,v_native_input,(v_outcome#>>'{definition,priceGroupRef,resourceId}')::uuid);
  IF v_occurrence IS NOT NULL THEN
    v_original_id := (v_outcome#>>'{definition,created,actionInvocationId}')::uuid;
    INSERT INTO price_group_catalog.price_group_source_operation_receipts
      (tenant_id,action_invocation_id,acting_principal_id,business_original_invocation_id,operation_kind,issuer,route_id,namespace,record_key,source_occurrence_id,intent_hash)
    VALUES (p_tenant_id,(p_input->>'actionInvocationId')::uuid,(p_input->>'actingPrincipalId')::uuid,v_original_id,p_kind,
      v_source->>'issuer',v_source->>'routeId',v_source->>'namespace',v_source->>'recordKey',v_occurrence,v_hash)
    ON CONFLICT (tenant_id,action_invocation_id) DO NOTHING;
    v_outcome := v_outcome || jsonb_build_object('businessOriginalInvocationId',v_original_id);
  END IF;
  RETURN QUERY SELECT v_outcome;
END $function$;
REVOKE ALL ON FUNCTION price_group_catalog.execute_source_occurrence(uuid,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_group_catalog.create_price_group_with_source_correlation(p_tenant_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
  SELECT * FROM price_group_catalog.execute_source_occurrence(p_tenant_id,p_input,'CREATE_PRICE_GROUP')
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_group_catalog.create_definition_revision_with_source_correlation(p_tenant_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
  SELECT * FROM price_group_catalog.execute_source_occurrence(p_tenant_id,p_input,'CREATE_DEFINITION_REVISION')
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_group_catalog.read_price_group_operation_receipt(p_tenant_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE v_entry price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_receipt price_group_catalog.price_group_source_operation_receipts%ROWTYPE;
  v_id uuid := (p_input->>'actionInvocationId')::uuid;
  v_original_id uuid;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_receipt FROM price_group_catalog.price_group_source_operation_receipts
    WHERE tenant_id=p_tenant_id AND action_invocation_id=v_id
      AND (NOT p_input ? 'actingPrincipalId' OR acting_principal_id=(p_input->>'actingPrincipalId')::uuid);
  IF FOUND THEN
    v_original_id:=v_receipt.business_original_invocation_id;
    SELECT * INTO STRICT v_entry FROM price_group_catalog.price_group_catalog_ledger
      WHERE tenant_id=p_tenant_id AND action_invocation_id=v_original_id AND operation_kind=v_receipt.operation_kind;
  ELSE
    -- A journaled delivery cannot escape its writer check by falling back to business-original state.
    IF EXISTS (SELECT 1 FROM price_group_catalog.price_group_source_operation_receipts WHERE tenant_id=p_tenant_id AND action_invocation_id=v_id) THEN
      RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_ABSENT','actionInvocationId',v_id); RETURN;
    END IF;
    SELECT * INTO v_entry FROM price_group_catalog.price_group_catalog_ledger
      WHERE tenant_id=p_tenant_id AND action_invocation_id=v_id
        AND (NOT p_input ? 'actingPrincipalId' OR acting_principal_id=(p_input->>'actingPrincipalId')::uuid);
    IF NOT FOUND THEN
      RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_ABSENT','actionInvocationId',v_id); RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_FOUND','receipt',jsonb_build_object(
    'actionInvocationId',v_id,'operationKind',v_entry.operation_kind,'catalogRevision',v_entry.catalog_revision,
    'definitionRevisionId',v_entry.definition_revision_id,'priceGroupRef',jsonb_build_object('moduleId','pricing.price-group-catalog',
    'resourceType','pricing.price-group-catalog.price-group','tenantId',p_tenant_id,'resourceId',v_entry.price_group_id))
    || CASE WHEN v_original_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessOriginalInvocationId',v_original_id) END);
END $function$;
