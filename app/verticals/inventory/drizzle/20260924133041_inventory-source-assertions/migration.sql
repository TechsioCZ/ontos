CREATE TABLE "inventory"."source_assertion_coverage" (
	"tenant_id" uuid,
	"assertion_id" uuid,
	"effect_id" uuid,
	"relation" text NOT NULL,
	"owner_evidence_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_source_assertion_coverage_pk" PRIMARY KEY("tenant_id","assertion_id","effect_id"),
	CONSTRAINT "inventory_source_assertion_coverage_relation_ck" CHECK ("relation" in ('INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN')),
	CONSTRAINT "inventory_source_assertion_coverage_evidence_ck" CHECK (length(btrim("owner_evidence_ref")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_assertion_coverage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."source_assertions" (
	"assertion_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"authority_configuration_id" uuid NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"issuer_authority" text NOT NULL,
	"item_correlation_id" uuid NOT NULL,
	"location_correlation_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"unit_module_id" text NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"unit_resource_type" text NOT NULL,
	"unit_tenant_id" uuid NOT NULL,
	"quantity_amount" text NOT NULL,
	"fact_meaning" text NOT NULL,
	"business_observed_at" timestamp with time zone NOT NULL,
	"ordering_evidence_kind" text NOT NULL,
	"ordering_evidence_value" text NOT NULL,
	"owner_evidence_ref" text NOT NULL,
	"source_reference" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"assertion_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_source_assertions_meaning_ck" CHECK ("fact_meaning" = 'ABSOLUTE_PHYSICAL_ON_HAND' and "issuer_backend_kind" = 'external_business_system'),
	CONSTRAINT "inventory_source_assertions_authority_ck" CHECK ("issuer_authority" in ('SELECTED_BACKEND', 'HISTORICAL_PRE_CUTOVER_ISSUER')),
	CONSTRAINT "inventory_source_assertions_unit_ck" CHECK ("unit_module_id" = 'commerce.catalog' and "unit_resource_type" = 'commerce.catalog.product-unit' and "unit_tenant_id" = "tenant_id"),
	CONSTRAINT "inventory_source_assertions_text_ck" CHECK (length(btrim("customer_configuration_id")) between 1 and 300 and length(btrim("issuer_backend_id")) between 1 and 300 and length(btrim("quantity_amount")) between 1 and 50 and length(btrim("ordering_evidence_value")) between 1 and 300 and length(btrim("owner_evidence_ref")) between 1 and 300 and length(btrim("source_reference")) between 1 and 300),
	CONSTRAINT "inventory_source_assertions_ordering_ck" CHECK ("ordering_evidence_kind" in ('SOURCE_REVISION', 'OWNER_ORDER_KEY'))
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_assertions_tenant_id_uk" ON "inventory"."source_assertions" ("tenant_id","assertion_id");--> statement-breakpoint
CREATE INDEX "inventory_source_assertions_position_observed_idx" ON "inventory"."source_assertions" ("tenant_id","position_id","business_observed_at");--> statement-breakpoint
ALTER TABLE "inventory"."source_assertion_coverage" ADD CONSTRAINT "inventory_source_assertion_coverage_assertion_fk" FOREIGN KEY ("tenant_id","assertion_id") REFERENCES "inventory"."source_assertions"("tenant_id","assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertion_coverage" ADD CONSTRAINT "inventory_source_assertion_coverage_effect_fk" FOREIGN KEY ("tenant_id","effect_id") REFERENCES "inventory"."physical_stock_effects"("tenant_id","effect_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ADD CONSTRAINT "inventory_source_assertions_authority_configuration_fk" FOREIGN KEY ("tenant_id","authority_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ADD CONSTRAINT "inventory_source_assertions_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ADD CONSTRAINT "inventory_source_assertions_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ADD CONSTRAINT "inventory_source_assertions_location_fk" FOREIGN KEY ("tenant_id","stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ADD CONSTRAINT "inventory_source_assertions_item_correlation_fk" FOREIGN KEY ("tenant_id","item_correlation_id") REFERENCES "inventory"."external_stock_correlations"("tenant_id","correlation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" ADD CONSTRAINT "inventory_source_assertions_location_correlation_fk" FOREIGN KEY ("tenant_id","location_correlation_id") REFERENCES "inventory"."external_stock_correlations"("tenant_id","correlation_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_source_assertion_coverage_tenant_select" ON "inventory"."source_assertion_coverage" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_assertion_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertion_coverage_tenant_insert" ON "inventory"."source_assertion_coverage" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_assertion_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertion_coverage_tenant_update" ON "inventory"."source_assertion_coverage" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_assertion_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_assertion_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertion_coverage_tenant_delete" ON "inventory"."source_assertion_coverage" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_assertion_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertions_tenant_select" ON "inventory"."source_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertions_tenant_insert" ON "inventory"."source_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertions_tenant_update" ON "inventory"."source_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_assertions_tenant_delete" ON "inventory"."source_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."source_assertion_coverage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."source_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_source_assertion_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  authority_configuration "inventory"."backend_configurations"%ROWTYPE;
  selected_issuer boolean;
  stored_assertion jsonb;
BEGIN
  IF TG_TABLE_NAME = 'source_assertions' THEN
    IF pg_catalog.jsonb_typeof(NEW.assertion_json) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(NEW.assertion_json -> 'coverage') IS DISTINCT FROM 'array'
      OR NEW.assertion_json ->> 'assertionId' IS DISTINCT FROM NEW.assertion_id::text
      OR NEW.assertion_json ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.assertion_json ->> 'factMeaning' IS DISTINCT FROM NEW.fact_meaning
      OR NEW.assertion_json ->> 'issuerAuthority' IS DISTINCT FROM NEW.issuer_authority
      OR NEW.assertion_json #>> '{issuer,backendKind}' IS DISTINCT FROM NEW.issuer_backend_kind
      OR NEW.assertion_json #>> '{issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
      OR NEW.assertion_json #>> '{authorityConfiguration,configurationId}' IS DISTINCT FROM NEW.authority_configuration_id::text
      OR NEW.assertion_json #>> '{authorityConfiguration,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{authorityConfiguration,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.assertion_json #>> '{itemCorrelationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.assertion_json #>> '{itemCorrelationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.external-stock-correlation'
      OR NEW.assertion_json #>> '{itemCorrelationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{itemCorrelationRef,resourceId}' IS DISTINCT FROM NEW.item_correlation_id::text
      OR NEW.assertion_json #>> '{locationCorrelationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.assertion_json #>> '{locationCorrelationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.external-stock-correlation'
      OR NEW.assertion_json #>> '{locationCorrelationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{locationCorrelationRef,resourceId}' IS DISTINCT FROM NEW.location_correlation_id::text
      OR NEW.assertion_json #>> '{positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.assertion_json #>> '{positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
      OR NEW.assertion_json #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
      OR NEW.assertion_json #>> '{stockItemRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.assertion_json #>> '{stockItemRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-item'
      OR NEW.assertion_json #>> '{stockItemRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{stockItemRef,resourceId}' IS DISTINCT FROM NEW.stock_item_id::text
      OR NEW.assertion_json #>> '{stockLocationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.assertion_json #>> '{stockLocationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-location'
      OR NEW.assertion_json #>> '{stockLocationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{stockLocationRef,resourceId}' IS DISTINCT FROM NEW.stock_location_id::text
      OR NEW.assertion_json #>> '{quantity,amount}' IS DISTINCT FROM NEW.quantity_amount
      OR NEW.assertion_json #>> '{quantity,unitRef,moduleId}' IS DISTINCT FROM NEW.unit_module_id
      OR NEW.assertion_json #>> '{quantity,unitRef,resourceType}' IS DISTINCT FROM NEW.unit_resource_type
      OR NEW.assertion_json #>> '{quantity,unitRef,tenantId}' IS DISTINCT FROM NEW.unit_tenant_id::text
      OR NEW.assertion_json #>> '{quantity,unitRef,resourceId}' IS DISTINCT FROM NEW.unit_resource_id::text
      OR (NEW.assertion_json ->> 'businessObservedAt')::timestamptz IS DISTINCT FROM NEW.business_observed_at
      OR (NEW.assertion_json ->> 'receivedAt')::timestamptz IS DISTINCT FROM NEW.received_at
      OR NEW.assertion_json #>> '{orderingEvidence,_tag}' IS DISTINCT FROM NEW.ordering_evidence_kind
      OR (
        NEW.ordering_evidence_kind = 'SOURCE_REVISION'
        AND (
          NEW.assertion_json #>> '{orderingEvidence,revision}' IS DISTINCT FROM NEW.ordering_evidence_value
          OR NEW.assertion_json #> '{orderingEvidence,key}' IS NOT NULL
        )
      )
      OR (
        NEW.ordering_evidence_kind = 'OWNER_ORDER_KEY'
        AND (
          NEW.assertion_json #>> '{orderingEvidence,key}' IS DISTINCT FROM NEW.ordering_evidence_value
          OR NEW.assertion_json #> '{orderingEvidence,revision}' IS NOT NULL
        )
      )
      OR NEW.assertion_json ->> 'ownerEvidenceRef' IS DISTINCT FROM NEW.owner_evidence_ref
      OR NEW.assertion_json ->> 'sourceReference' IS DISTINCT FROM NEW.source_reference
      OR NEW.assertion_json #>> '{itemExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{itemExternalKey,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.assertion_json #>> '{itemExternalKey,issuer,backendKind}' IS DISTINCT FROM NEW.issuer_backend_kind
      OR NEW.assertion_json #>> '{itemExternalKey,issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
      OR NEW.assertion_json #>> '{itemExternalKey,identifierKind}' IS DISTINCT FROM 'ITEM'
      OR NEW.assertion_json #>> '{locationExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.assertion_json #>> '{locationExternalKey,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.assertion_json #>> '{locationExternalKey,issuer,backendKind}' IS DISTINCT FROM NEW.issuer_backend_kind
      OR NEW.assertion_json #>> '{locationExternalKey,issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
      OR NEW.assertion_json #>> '{locationExternalKey,identifierKind}' IS DISTINCT FROM 'LOCATION'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion JSON must exactly match its relational owner scope';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(NEW.assertion_json -> 'coverage') AS coverage(entry)
      WHERE coverage.entry ->> 'assertionId' IS DISTINCT FROM NEW.assertion_id::text
        OR coverage.entry ->> 'effectId' IS NULL
        OR coverage.entry ->> 'relation' NOT IN ('INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN')
        OR coalesce(length(btrim(coverage.entry ->> 'ownerEvidenceRef')), 0) NOT BETWEEN 1 AND 300
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements(NEW.assertion_json -> 'coverage') AS coverage(entry)
    ) <> (
      SELECT pg_catalog.count(DISTINCT coverage.entry ->> 'effectId')
      FROM pg_catalog.jsonb_array_elements(NEW.assertion_json -> 'coverage') AS coverage(entry)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion coverage evidence must be exact and unique';
    END IF;

    SELECT configuration.* INTO authority_configuration
    FROM "inventory"."backend_configurations" AS configuration
    WHERE configuration.tenant_id = NEW.tenant_id
      AND configuration.configuration_id = NEW.authority_configuration_id
      AND configuration.customer_configuration_id = NEW.customer_configuration_id
    FOR KEY SHARE;

    IF NOT FOUND
      OR NEW.assertion_json #>> '{authorityConfiguration,revision}' IS DISTINCT FROM authority_configuration.revision::text
      OR (NEW.assertion_json #>> '{authorityConfiguration,selectedAt}')::timestamptz IS DISTINCT FROM authority_configuration.selected_at
      OR NEW.assertion_json #>> '{authorityConfiguration,selection,backend}' IS DISTINCT FROM authority_configuration.backend_kind
      OR NEW.assertion_json #>> '{authorityConfiguration,selection,backendId}' IS DISTINCT FROM authority_configuration.backend_id
      OR NEW.assertion_json #>> '{authorityConfiguration,selection,exactReservationCapability}' IS DISTINCT FROM authority_configuration.exact_reservation_capability
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion authority configuration evidence is not exact';
    END IF;

    selected_issuer := authority_configuration.backend_kind = NEW.issuer_backend_kind
      AND authority_configuration.backend_id = NEW.issuer_backend_id
      AND NEW.business_observed_at >= authority_configuration.selected_at;
    IF (NEW.issuer_authority = 'SELECTED_BACKEND' AND NOT selected_issuer)
      OR (NEW.issuer_authority = 'HISTORICAL_PRE_CUTOVER_ISSUER' AND selected_issuer)
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion issuer authority contradicts the captured backend configuration';
    END IF;

    PERFORM 1
    FROM "inventory"."stock_positions" AS position
    WHERE position.tenant_id = NEW.tenant_id
      AND position.stock_position_id = NEW.position_id
      AND position.customer_configuration_id = NEW.customer_configuration_id
      AND position.stock_item_id = NEW.stock_item_id
      AND position.stock_location_id = NEW.stock_location_id
      AND position.stock_unit_module_id = NEW.unit_module_id
      AND position.stock_unit_resource_id = NEW.unit_resource_id
      AND position.stock_unit_resource_type = NEW.unit_resource_type
      AND position.stock_unit_tenant_id = NEW.unit_tenant_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion Position scope is not exact';
    END IF;

    PERFORM 1
    FROM "inventory"."external_stock_correlations" AS correlation
    WHERE correlation.tenant_id = NEW.tenant_id
      AND correlation.correlation_id = NEW.item_correlation_id
      AND correlation.customer_configuration_id = NEW.customer_configuration_id
      AND correlation.issuer_backend_kind = NEW.issuer_backend_kind
      AND correlation.issuer_backend_id = NEW.issuer_backend_id
      AND correlation.namespace = NEW.assertion_json #>> '{itemExternalKey,namespace}'
      AND correlation.external_scope = NEW.assertion_json #>> '{itemExternalKey,externalScope}'
      AND correlation.identifier_kind = 'ITEM'
      AND correlation.external_value = NEW.assertion_json #>> '{itemExternalKey,externalValue}'
      AND correlation.stock_item_id = NEW.stock_item_id
      AND correlation.stock_location_id IS NULL
      AND correlation.effective_from <= NEW.business_observed_at
      AND (correlation.effective_to IS NULL OR NEW.business_observed_at < correlation.effective_to)
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion Item correlation is not effective for business-observed time';
    END IF;

    PERFORM 1
    FROM "inventory"."external_stock_correlations" AS correlation
    WHERE correlation.tenant_id = NEW.tenant_id
      AND correlation.correlation_id = NEW.location_correlation_id
      AND correlation.customer_configuration_id = NEW.customer_configuration_id
      AND correlation.issuer_backend_kind = NEW.issuer_backend_kind
      AND correlation.issuer_backend_id = NEW.issuer_backend_id
      AND correlation.namespace = NEW.assertion_json #>> '{locationExternalKey,namespace}'
      AND correlation.external_scope = NEW.assertion_json #>> '{locationExternalKey,externalScope}'
      AND correlation.identifier_kind = 'LOCATION'
      AND correlation.external_value = NEW.assertion_json #>> '{locationExternalKey,externalValue}'
      AND correlation.stock_location_id = NEW.stock_location_id
      AND correlation.stock_item_id IS NULL
      AND correlation.effective_from <= NEW.business_observed_at
      AND (correlation.effective_to IS NULL OR NEW.business_observed_at < correlation.effective_to)
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_assertions_exact_scope_ck',
        MESSAGE = 'Inventory Source Assertion Location correlation is not effective for business-observed time';
    END IF;

    RETURN NEW;
  END IF;

  SELECT assertion.assertion_json INTO stored_assertion
  FROM "inventory"."source_assertions" AS assertion
  JOIN "inventory"."physical_stock_effects" AS effect
    ON effect.tenant_id = NEW.tenant_id
    AND effect.effect_id = NEW.effect_id
    AND effect.position_id = assertion.position_id
    AND effect.stock_item_id = assertion.stock_item_id
    AND effect.stock_location_id = assertion.stock_location_id
    AND effect.unit_resource_id = assertion.unit_resource_id
    AND effect.state = 'APPLIED'
  WHERE assertion.tenant_id = NEW.tenant_id
    AND assertion.assertion_id = NEW.assertion_id
  FOR KEY SHARE OF assertion, effect;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(stored_assertion -> 'coverage') AS coverage(entry)
    WHERE coverage.entry ->> 'assertionId' = NEW.assertion_id::text
      AND coverage.entry ->> 'effectId' = NEW.effect_id::text
      AND coverage.entry ->> 'relation' = NEW.relation
      AND coverage.entry ->> 'ownerEvidenceRef' = NEW.owner_evidence_ref
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_assertion_coverage_exact_scope_ck',
      MESSAGE = 'Source Coverage must match its exact Assertion, physical effect, and nested owner evidence';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_assertions_exact_scope_trg"
BEFORE INSERT ON "inventory"."source_assertions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_assertion_exact_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_assertion_coverage_exact_scope_trg"
BEFORE INSERT ON "inventory"."source_assertion_coverage"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_assertion_exact_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_source_assertion_coverage_complete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF pg_catalog.jsonb_array_length(NEW.assertion_json -> 'coverage') IS DISTINCT FROM (
    SELECT pg_catalog.count(*)::integer
    FROM "inventory"."source_assertion_coverage" AS stored
    WHERE stored.tenant_id = NEW.tenant_id
      AND stored.assertion_id = NEW.assertion_id
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(NEW.assertion_json -> 'coverage') AS expected(entry)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "inventory"."source_assertion_coverage" AS stored
      WHERE stored.tenant_id = NEW.tenant_id
        AND stored.assertion_id = NEW.assertion_id
        AND stored.effect_id::text = expected.entry ->> 'effectId'
        AND stored.relation = expected.entry ->> 'relation'
        AND stored.owner_evidence_ref = expected.entry ->> 'ownerEvidenceRef'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_assertion_coverage_complete_ck',
      MESSAGE = 'Inventory Source Assertion JSON coverage and relational coverage must be an exact bijection';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_source_assertion_coverage_complete_trg"
AFTER INSERT ON "inventory"."source_assertions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_assertion_coverage_complete"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_source_assertion_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_source_assertions_append_only_ck',
    MESSAGE = 'Inventory Source Assertions and coverage evidence are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_assertions_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."source_assertions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_source_assertion_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_assertion_coverage_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."source_assertion_coverage"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_source_assertion_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_source_assertion_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_source_assertion_coverage_complete"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_source_assertion_mutation"() FROM PUBLIC, "ontos_runtime";
