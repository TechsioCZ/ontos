CREATE TABLE "inventory"."stock_correction_open_reconciliations" (
	"tenant_id" uuid,
	"position_id" uuid,
	"correction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_correction_open_pk" PRIMARY KEY("tenant_id","position_id")
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_open_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_correction_source_evidence" (
	"evidence_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"authority_configuration_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"unit_module_id" text NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"unit_resource_type" text NOT NULL,
	"unit_tenant_id" uuid NOT NULL,
	"quantity_amount" text NOT NULL,
	"fact_meaning" text NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"business_observed_at" timestamp with time zone NOT NULL,
	"ordering_evidence_kind" text NOT NULL,
	"ordering_evidence_value" text NOT NULL,
	"owner_evidence_ref" text NOT NULL,
	"source_reference" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_correction_source_evidence_meaning_ck" CHECK ("fact_meaning" = 'ABSOLUTE_PHYSICAL_ON_HAND' and "issuer_backend_kind" = 'ontos_wms'),
	CONSTRAINT "inventory_stock_correction_source_evidence_ordering_ck" CHECK ("ordering_evidence_kind" = 'OWNER_ORDER_KEY'),
	CONSTRAINT "inventory_stock_correction_source_evidence_unit_ck" CHECK ("unit_module_id" = 'commerce.catalog' and "unit_resource_type" = 'commerce.catalog.product-unit' and "unit_tenant_id" = "tenant_id"),
	CONSTRAINT "inventory_stock_correction_source_evidence_quantity_ck" CHECK ("quantity_amount" ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' and length(split_part("quantity_amount", '.', 1)) <= 29 and (position('.' in "quantity_amount") = 0 or length(split_part("quantity_amount", '.', 2)) <= 9)),
	CONSTRAINT "inventory_stock_correction_source_evidence_text_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 300 and "issuer_backend_id" = btrim("issuer_backend_id") and length("issuer_backend_id") between 1 and 300 and "ordering_evidence_value" = btrim("ordering_evidence_value") and length("ordering_evidence_value") between 1 and 300 and "owner_evidence_ref" = btrim("owner_evidence_ref") and length("owner_evidence_ref") between 1 and 300 and "source_reference" = btrim("source_reference") and length("source_reference") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_correction_source_evidence_coverage" (
	"tenant_id" uuid,
	"evidence_id" uuid,
	"effect_id" uuid,
	"relation" text NOT NULL,
	"owner_evidence_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_correction_source_evidence_coverage_pk" PRIMARY KEY("tenant_id","evidence_id","effect_id"),
	CONSTRAINT "inventory_stock_correction_source_evidence_coverage_relation_ck" CHECK ("relation" in ('INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN')),
	CONSTRAINT "inventory_stock_correction_source_evidence_coverage_evidence_ck" CHECK ("owner_evidence_ref" = btrim("owner_evidence_ref") and length("owner_evidence_ref") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_coverage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_correction_source_evidence_current" (
	"tenant_id" uuid,
	"customer_configuration_id" text,
	"authority_configuration_id" uuid,
	"position_id" uuid,
	"evidence_id" uuid NOT NULL,
	"ordering_evidence_kind" text NOT NULL,
	"ordering_evidence_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_correction_source_evidence_current_pk" PRIMARY KEY("tenant_id","customer_configuration_id","authority_configuration_id","position_id"),
	CONSTRAINT "inventory_stock_correction_source_evidence_current_ordering_ck" CHECK ("ordering_evidence_kind" = 'OWNER_ORDER_KEY' and length(btrim("ordering_evidence_value")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_current" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_corrections" (
	"correction_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"position_id" uuid NOT NULL,
	"source_assertion_id" uuid,
	"source_evidence_id" uuid,
	"authority_configuration_id" uuid NOT NULL,
	"evidence_kind" text NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"owner_evidence_ref" text NOT NULL,
	"source_reference" text NOT NULL,
	"business_observed_at" timestamp with time zone NOT NULL,
	"expected_position_revision" integer NOT NULL,
	"position_revision_after" integer NOT NULL,
	"state" text NOT NULL,
	"corrected_quantity_amount" numeric(38,9),
	"reconciles_correction_id" uuid,
	"coverage_evidence_json" jsonb NOT NULL,
	"evaluated_material_effect_ids_json" jsonb NOT NULL,
	"record_json" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_corrections_customer_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 300),
	CONSTRAINT "inventory_stock_corrections_provenance_text_ck" CHECK (length(btrim("issuer_backend_id")) between 1 and 300 and length(btrim("owner_evidence_ref")) between 1 and 300 and length(btrim("source_reference")) between 1 and 300),
	CONSTRAINT "inventory_stock_corrections_issuer_ck" CHECK ("issuer_backend_kind" in ('external_business_system', 'ontos_wms')),
	CONSTRAINT "inventory_stock_corrections_evidence_ck" CHECK (("evidence_kind" = 'EXTERNAL_SOURCE_ASSERTION' and "issuer_backend_kind" = 'external_business_system' and "source_assertion_id" is not null and "source_evidence_id" is null) or ("evidence_kind" = 'ONTOS_WMS_OWNER_EVIDENCE' and "issuer_backend_kind" = 'ontos_wms' and "source_assertion_id" is null and "source_evidence_id" is not null)),
	CONSTRAINT "inventory_stock_corrections_state_ck" CHECK ("state" in ('APPLIED', 'INDETERMINATE')),
	CONSTRAINT "inventory_stock_corrections_quantity_ck" CHECK (("state" = 'APPLIED' and "corrected_quantity_amount" is not null and "corrected_quantity_amount" >= 0) or ("state" = 'INDETERMINATE' and "corrected_quantity_amount" is null)),
	CONSTRAINT "inventory_stock_corrections_revision_ck" CHECK ("expected_position_revision" >= 1 and "position_revision_after" = "expected_position_revision" + 1 and "position_revision_after" <= 2147483647)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory"."backend_configurations" ADD COLUMN "stock_correction_capability" text;--> statement-breakpoint
DROP TRIGGER "inventory_backend_configurations_explicit_cutover_trg" ON "inventory"."backend_configurations";--> statement-breakpoint
UPDATE "inventory"."backend_configurations"
SET "stock_correction_capability" = CASE
  WHEN "backend_kind" = 'ontos_wms' THEN 'SUPPORTED'
  ELSE 'UNSUPPORTED'
END;--> statement-breakpoint
ALTER TABLE "inventory"."backend_configurations" ALTER COLUMN "stock_correction_capability" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_correction_open_correction_uk" ON "inventory"."stock_correction_open_reconciliations" ("tenant_id","correction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_correction_source_evidence_tenant_id_uk" ON "inventory"."stock_correction_source_evidence" ("tenant_id","evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_correction_source_evidence_scope_id_uk" ON "inventory"."stock_correction_source_evidence" ("tenant_id","customer_configuration_id","authority_configuration_id","position_id","evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_correction_source_evidence_stream_order_uk" ON "inventory"."stock_correction_source_evidence" ("tenant_id","customer_configuration_id","authority_configuration_id","position_id","ordering_evidence_kind","ordering_evidence_value");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_correction_source_evidence_source_reference_uk" ON "inventory"."stock_correction_source_evidence" ("tenant_id","customer_configuration_id","authority_configuration_id","position_id","source_reference");--> statement-breakpoint
CREATE INDEX "inventory_stock_correction_source_evidence_stream_observed_idx" ON "inventory"."stock_correction_source_evidence" ("tenant_id","customer_configuration_id","authority_configuration_id","position_id","business_observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_correction_source_evidence_current_evidence_uk" ON "inventory"."stock_correction_source_evidence_current" ("tenant_id","evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_corrections_tenant_id_uk" ON "inventory"."stock_corrections" ("tenant_id","correction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_corrections_assertion_uk" ON "inventory"."stock_corrections" ("tenant_id","source_assertion_id") WHERE "source_assertion_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_corrections_source_evidence_uk" ON "inventory"."stock_corrections" ("tenant_id","source_evidence_id") WHERE "source_evidence_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_corrections_reconciles_uk" ON "inventory"."stock_corrections" ("tenant_id","reconciles_correction_id") WHERE "reconciles_correction_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_stock_corrections_position_idx" ON "inventory"."stock_corrections" ("tenant_id","position_id","applied_at");--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_open_reconciliations" ADD CONSTRAINT "inventory_stock_correction_open_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_open_reconciliations" ADD CONSTRAINT "inventory_stock_correction_open_correction_fk" FOREIGN KEY ("tenant_id","correction_id") REFERENCES "inventory"."stock_corrections"("tenant_id","correction_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence" ADD CONSTRAINT "inventory_stock_correction_source_evidence_authority_fk" FOREIGN KEY ("tenant_id","authority_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence" ADD CONSTRAINT "inventory_stock_correction_source_evidence_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence" ADD CONSTRAINT "inventory_stock_correction_source_evidence_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence" ADD CONSTRAINT "inventory_stock_correction_source_evidence_location_fk" FOREIGN KEY ("tenant_id","stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_coverage" ADD CONSTRAINT "inventory_stock_correction_source_evidence_coverage_evidence_fk" FOREIGN KEY ("tenant_id","evidence_id") REFERENCES "inventory"."stock_correction_source_evidence"("tenant_id","evidence_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_coverage" ADD CONSTRAINT "inventory_stock_correction_source_evidence_coverage_effect_fk" FOREIGN KEY ("tenant_id","effect_id") REFERENCES "inventory"."physical_stock_effects"("tenant_id","effect_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_current" ADD CONSTRAINT "inventory_stock_correction_source_evidence_current_evidence_fk" FOREIGN KEY ("tenant_id","customer_configuration_id","authority_configuration_id","position_id","evidence_id") REFERENCES "inventory"."stock_correction_source_evidence"("tenant_id","customer_configuration_id","authority_configuration_id","position_id","evidence_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" ADD CONSTRAINT "inventory_stock_corrections_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" ADD CONSTRAINT "inventory_stock_corrections_assertion_fk" FOREIGN KEY ("tenant_id","source_assertion_id") REFERENCES "inventory"."source_assertions"("tenant_id","assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" ADD CONSTRAINT "inventory_stock_corrections_source_evidence_fk" FOREIGN KEY ("tenant_id","source_evidence_id") REFERENCES "inventory"."stock_correction_source_evidence"("tenant_id","evidence_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" ADD CONSTRAINT "inventory_stock_corrections_authority_fk" FOREIGN KEY ("tenant_id","authority_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" ADD CONSTRAINT "inventory_stock_corrections_reconciles_fk" FOREIGN KEY ("tenant_id","reconciles_correction_id") REFERENCES "inventory"."stock_corrections"("tenant_id","correction_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."backend_configurations" ADD CONSTRAINT "inventory_backend_configurations_stock_correction_capability_ck" CHECK ("stock_correction_capability" in ('SUPPORTED', 'UNSUPPORTED') and ("backend_kind" <> 'ontos_wms' or "stock_correction_capability" = 'SUPPORTED'));--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_open_tenant_select" ON "inventory"."stock_correction_open_reconciliations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_correction_open_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_open_tenant_insert" ON "inventory"."stock_correction_open_reconciliations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_correction_open_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_open_tenant_update" ON "inventory"."stock_correction_open_reconciliations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_correction_open_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_correction_open_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_open_tenant_delete" ON "inventory"."stock_correction_open_reconciliations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_correction_open_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_tenant_select" ON "inventory"."stock_correction_source_evidence" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_tenant_insert" ON "inventory"."stock_correction_source_evidence" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_correction_source_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_tenant_update" ON "inventory"."stock_correction_source_evidence" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_correction_source_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_tenant_delete" ON "inventory"."stock_correction_source_evidence" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_coverage_tenant_select" ON "inventory"."stock_correction_source_evidence_coverage" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_coverage_tenant_insert" ON "inventory"."stock_correction_source_evidence_coverage" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_correction_source_evidence_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_coverage_tenant_update" ON "inventory"."stock_correction_source_evidence_coverage" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_correction_source_evidence_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_coverage_tenant_delete" ON "inventory"."stock_correction_source_evidence_coverage" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence_coverage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_current_tenant_select" ON "inventory"."stock_correction_source_evidence_current" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence_current"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_current_tenant_insert" ON "inventory"."stock_correction_source_evidence_current" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_correction_source_evidence_current"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_current_tenant_update" ON "inventory"."stock_correction_source_evidence_current" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence_current"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_correction_source_evidence_current"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_correction_source_evidence_current_tenant_delete" ON "inventory"."stock_correction_source_evidence_current" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_correction_source_evidence_current"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_corrections_tenant_select" ON "inventory"."stock_corrections" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_corrections_tenant_insert" ON "inventory"."stock_corrections" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_corrections_tenant_update" ON "inventory"."stock_corrections" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_corrections_tenant_delete" ON "inventory"."stock_corrections" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_open_reconciliations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_coverage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_correction_source_evidence_current" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_corrections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."reject_backend_configuration_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inventory Backend configurations are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'Inventory Backend identity, authority, Reservation capability, and Stock Correction capability require explicit cutover'
    USING ERRCODE = '23514', CONSTRAINT = 'inventory_backend_configurations_explicit_cutover_ck';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_backend_configurations_explicit_cutover_trg"
BEFORE UPDATE OR DELETE ON "inventory"."backend_configurations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_backend_configuration_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_correction_source_evidence_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_TABLE_NAME = 'stock_correction_source_evidence' THEN
    PERFORM 1
    FROM "inventory"."backend_configurations" AS authority
    JOIN "inventory"."stock_positions" AS position
      ON position.tenant_id = authority.tenant_id
      AND position.owner_configuration_id = authority.configuration_id
    WHERE authority.tenant_id = NEW.tenant_id
      AND authority.configuration_id = NEW.authority_configuration_id
      AND authority.customer_configuration_id = NEW.customer_configuration_id
      AND authority.backend_kind = 'ontos_wms'
      AND authority.backend_id = NEW.issuer_backend_id
      AND authority.stock_correction_capability = 'SUPPORTED'
      AND NEW.business_observed_at >= authority.selected_at
      AND position.stock_position_id = NEW.position_id
      AND position.customer_configuration_id = NEW.customer_configuration_id
      AND position.stock_item_id = NEW.stock_item_id
      AND position.stock_location_id = NEW.stock_location_id
      AND position.stock_unit_module_id = NEW.unit_module_id
      AND position.stock_unit_resource_id = NEW.unit_resource_id
      AND position.stock_unit_resource_type = NEW.unit_resource_type
      AND position.stock_unit_tenant_id = NEW.unit_tenant_id
      AND position.lifecycle_state = 'CURRENT'
    FOR KEY SHARE OF authority
    FOR UPDATE OF position;

    IF NOT FOUND
      OR pg_catalog.jsonb_typeof(NEW.evidence_json) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(NEW.evidence_json -> 'coverage') IS DISTINCT FROM 'array'
      OR NEW.evidence_json ->> 'evidenceId' IS DISTINCT FROM NEW.evidence_id::text
      OR NEW.evidence_json ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.evidence_json ->> 'factMeaning' IS DISTINCT FROM NEW.fact_meaning
      OR NEW.evidence_json #>> '{issuer,backendKind}' IS DISTINCT FROM NEW.issuer_backend_kind
      OR NEW.evidence_json #>> '{issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
      OR (NEW.evidence_json ->> 'businessObservedAt')::timestamptz IS DISTINCT FROM NEW.business_observed_at
      OR NEW.evidence_json #>> '{orderingEvidence,_tag}' IS DISTINCT FROM NEW.ordering_evidence_kind
      OR NEW.evidence_json #>> '{orderingEvidence,key}' IS DISTINCT FROM NEW.ordering_evidence_value
      OR NEW.evidence_json ->> 'ownerEvidenceRef' IS DISTINCT FROM NEW.owner_evidence_ref
      OR NEW.evidence_json ->> 'sourceReference' IS DISTINCT FROM NEW.source_reference
      OR (NEW.evidence_json ->> 'receivedAt')::timestamptz IS DISTINCT FROM NEW.received_at
      OR NEW.evidence_json #>> '{positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.evidence_json #>> '{positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
      OR NEW.evidence_json #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.evidence_json #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
      OR NEW.evidence_json #>> '{stockItemRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.evidence_json #>> '{stockItemRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-item'
      OR NEW.evidence_json #>> '{stockItemRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.evidence_json #>> '{stockItemRef,resourceId}' IS DISTINCT FROM NEW.stock_item_id::text
      OR NEW.evidence_json #>> '{stockLocationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR NEW.evidence_json #>> '{stockLocationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-location'
      OR NEW.evidence_json #>> '{stockLocationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.evidence_json #>> '{stockLocationRef,resourceId}' IS DISTINCT FROM NEW.stock_location_id::text
      OR NEW.evidence_json #>> '{quantity,amount}' IS DISTINCT FROM NEW.quantity_amount
      OR NEW.evidence_json #>> '{quantity,unitRef,moduleId}' IS DISTINCT FROM NEW.unit_module_id
      OR NEW.evidence_json #>> '{quantity,unitRef,resourceId}' IS DISTINCT FROM NEW.unit_resource_id::text
      OR NEW.evidence_json #>> '{quantity,unitRef,resourceType}' IS DISTINCT FROM NEW.unit_resource_type
      OR NEW.evidence_json #>> '{quantity,unitRef,tenantId}' IS DISTINCT FROM NEW.unit_tenant_id::text
      OR NEW.evidence_json #>> '{authorityConfiguration,configurationId}' IS DISTINCT FROM NEW.authority_configuration_id::text
      OR NEW.evidence_json #>> '{authorityConfiguration,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.evidence_json #>> '{authorityConfiguration,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.evidence_json #>> '{authorityConfiguration,selection,backend}' IS DISTINCT FROM 'ontos_wms'
      OR NEW.evidence_json #>> '{authorityConfiguration,selection,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
      OR NEW.evidence_json #>> '{authorityConfiguration,selection,stockCorrectionCapability}' IS DISTINCT FROM 'SUPPORTED'
      OR NOT EXISTS (
        SELECT 1
        FROM "inventory"."backend_configurations" AS exact_authority
        WHERE exact_authority.tenant_id = NEW.tenant_id
          AND exact_authority.configuration_id = NEW.authority_configuration_id
          AND (NEW.evidence_json #>> '{authorityConfiguration,selectedAt}')::timestamptz = exact_authority.selected_at
          AND (NEW.evidence_json #>> '{authorityConfiguration,revision}')::integer = exact_authority.revision
          AND NEW.evidence_json #>> '{authorityConfiguration,selection,exactReservationCapability}'
            = exact_authority.exact_reservation_capability
          AND NEW.evidence_json #>> '{authorityConfiguration,selection,stockCorrectionCapability}'
            = exact_authority.stock_correction_capability
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_stock_correction_source_evidence_exact_scope_ck',
        MESSAGE = 'OntOS WMS Stock Correction evidence must exactly match its selected authority, Current Position, and JSON provenance';
    END IF;

    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "inventory"."stock_correction_source_evidence" AS evidence
  JOIN "inventory"."physical_stock_effects" AS effect
    ON effect.tenant_id = evidence.tenant_id
    AND effect.effect_id = NEW.effect_id
  WHERE evidence.tenant_id = NEW.tenant_id
    AND evidence.evidence_id = NEW.evidence_id
    AND effect.state = 'APPLIED'
    AND effect.position_id = evidence.position_id
    AND effect.stock_item_id = evidence.stock_item_id
    AND effect.stock_location_id = evidence.stock_location_id
    AND effect.unit_resource_id = evidence.unit_resource_id
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(evidence.evidence_json -> 'coverage') AS expected(entry)
      WHERE expected.entry ->> 'evidenceId' = NEW.evidence_id::text
        AND expected.entry ->> 'effectId' = NEW.effect_id::text
        AND expected.entry ->> 'relation' = NEW.relation
        AND expected.entry ->> 'ownerEvidenceRef' = NEW.owner_evidence_ref
    )
  FOR KEY SHARE OF evidence, effect;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_correction_source_evidence_coverage_exact_scope_ck',
      MESSAGE = 'OntOS WMS Stock Correction coverage must exactly match one APPLIED physical effect and JSON entry';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_correction_source_evidence_exact_scope_trg"
BEFORE INSERT ON "inventory"."stock_correction_source_evidence"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_correction_source_evidence_exact_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_correction_source_evidence_coverage_exact_scope_trg"
BEFORE INSERT ON "inventory"."stock_correction_source_evidence_coverage"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_correction_source_evidence_exact_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_correction_source_evidence_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_stock_correction_source_evidence_append_only_ck',
    MESSAGE = 'Stock Correction source evidence and coverage are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_correction_source_evidence_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_correction_source_evidence"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_correction_source_evidence_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_correction_source_evidence_coverage_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_correction_source_evidence_coverage"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_correction_source_evidence_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_correction_source_evidence_coverage_complete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(NEW.evidence_json -> 'coverage') AS expected(entry)
    WHERE expected.entry ->> 'evidenceId' IS DISTINCT FROM NEW.evidence_id::text
      OR NOT EXISTS (
        SELECT 1
        FROM "inventory"."stock_correction_source_evidence_coverage" AS stored
        WHERE stored.tenant_id = NEW.tenant_id
          AND stored.evidence_id = NEW.evidence_id
          AND stored.effect_id::text = expected.entry ->> 'effectId'
          AND stored.relation = expected.entry ->> 'relation'
          AND stored.owner_evidence_ref = expected.entry ->> 'ownerEvidenceRef'
      )
  ) OR EXISTS (
    SELECT 1
    FROM "inventory"."stock_correction_source_evidence_coverage" AS stored
    WHERE stored.tenant_id = NEW.tenant_id
      AND stored.evidence_id = NEW.evidence_id
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(NEW.evidence_json -> 'coverage') AS expected(entry)
        WHERE expected.entry ->> 'evidenceId' = stored.evidence_id::text
          AND expected.entry ->> 'effectId' = stored.effect_id::text
          AND expected.entry ->> 'relation' = stored.relation
          AND expected.entry ->> 'ownerEvidenceRef' = stored.owner_evidence_ref
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM "inventory"."stock_correction_source_evidence_coverage" AS stored
    WHERE stored.tenant_id = NEW.tenant_id
      AND stored.evidence_id = NEW.evidence_id
  ) IS DISTINCT FROM pg_catalog.jsonb_array_length(NEW.evidence_json -> 'coverage')::bigint
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_correction_source_evidence_coverage_complete_ck',
      MESSAGE = 'OntOS WMS Stock Correction coverage JSON and child rows must form an exact bijection';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_stock_correction_source_evidence_coverage_complete_trg"
AFTER INSERT ON "inventory"."stock_correction_source_evidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_correction_source_evidence_coverage_complete"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_correction_source_evidence_current_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_correction_source_evidence_current_transition_ck',
      MESSAGE = 'Current OntOS WMS Stock Correction evidence may advance but cannot be deleted';
  END IF;

  PERFORM 1
  FROM "inventory"."stock_correction_source_evidence" AS evidence
  WHERE evidence.tenant_id = NEW.tenant_id
    AND evidence.customer_configuration_id = NEW.customer_configuration_id
    AND evidence.authority_configuration_id = NEW.authority_configuration_id
    AND evidence.position_id = NEW.position_id
    AND evidence.evidence_id = NEW.evidence_id
    AND evidence.ordering_evidence_kind = NEW.ordering_evidence_kind
    AND evidence.ordering_evidence_value = NEW.ordering_evidence_value
  FOR KEY SHARE;

  IF NOT FOUND
    OR NEW.ordering_evidence_kind IS DISTINCT FROM 'OWNER_ORDER_KEY'
    OR (
      TG_OP = 'UPDATE'
      AND (
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
        OR NEW.authority_configuration_id IS DISTINCT FROM OLD.authority_configuration_id
        OR NEW.position_id IS DISTINCT FROM OLD.position_id
        OR NEW.evidence_id IS NOT DISTINCT FROM OLD.evidence_id
        OR NEW.ordering_evidence_value <= OLD.ordering_evidence_value
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_correction_source_evidence_current_transition_ck',
      MESSAGE = 'Current OntOS WMS Stock Correction evidence must point at the exact stream and advance lexicographically';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_correction_source_evidence_current_transition_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "inventory"."stock_correction_source_evidence_current"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_correction_source_evidence_current_transition"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_correction_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  source_coverage jsonb;
  source_quantity_amount text;
  source_stock_item_id uuid;
  source_stock_location_id uuid;
  source_unit_module_id text;
  source_unit_resource_id uuid;
  source_unit_resource_type text;
  source_unit_tenant_id uuid;
  source_ordering_kind text;
  source_ordering_value text;
  expected_effect_ids jsonb;
  excluded_effect_ids jsonb;
  missing_effect_ids jsonb;
  unknown_effect_ids jsonb;
  expected_material_effect_ids jsonb;
  expected_reason_code text;
  position_on_hand_state text;
  position_on_hand_amount numeric(38, 9);
  position_on_hand_evidence_ref text;
  position_on_hand_observed_at timestamptz;
  position_owner_configuration_id uuid;
  position_unit_module_id text;
  position_unit_resource_id uuid;
  position_unit_resource_type text;
  position_unit_tenant_id uuid;
BEGIN
  SELECT
    position.on_hand_state,
    position.on_hand_amount,
    position.on_hand_evidence_ref,
    position.on_hand_observed_at,
    position.owner_configuration_id,
    position.stock_unit_module_id,
    position.stock_unit_resource_id,
    position.stock_unit_resource_type,
    position.stock_unit_tenant_id
  INTO
    position_on_hand_state,
    position_on_hand_amount,
    position_on_hand_evidence_ref,
    position_on_hand_observed_at,
    position_owner_configuration_id,
    position_unit_module_id,
    position_unit_resource_id,
    position_unit_resource_type,
    position_unit_tenant_id
  FROM "inventory"."backend_configurations" AS authority
  JOIN "inventory"."stock_positions" AS position
    ON position.tenant_id = authority.tenant_id
    AND position.owner_configuration_id = authority.configuration_id
  WHERE authority.tenant_id = NEW.tenant_id
    AND authority.configuration_id = NEW.authority_configuration_id
    AND authority.customer_configuration_id = NEW.customer_configuration_id
    AND authority.backend_kind = NEW.issuer_backend_kind
    AND authority.backend_id = NEW.issuer_backend_id
    AND authority.stock_correction_capability = 'SUPPORTED'
    AND position.stock_position_id = NEW.position_id
    AND position.customer_configuration_id = NEW.customer_configuration_id
    AND position.lifecycle_state = 'CURRENT'
    AND position.revision = NEW.expected_position_revision
  FOR KEY SHARE OF authority
  FOR UPDATE OF position;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_corrections_exact_scope_ck',
      MESSAGE = 'Stock Correction must match its exact Current Position and selected supported authority';
  END IF;

  IF NEW.evidence_kind = 'EXTERNAL_SOURCE_ASSERTION' THEN
    SELECT
      assertion.assertion_json -> 'coverage',
      assertion.quantity_amount,
      assertion.stock_item_id,
      assertion.stock_location_id,
      assertion.unit_module_id,
      assertion.unit_resource_id,
      assertion.unit_resource_type,
      assertion.unit_tenant_id,
      assertion.ordering_evidence_kind,
      assertion.ordering_evidence_value
    INTO
      source_coverage,
      source_quantity_amount,
      source_stock_item_id,
      source_stock_location_id,
      source_unit_module_id,
      source_unit_resource_id,
      source_unit_resource_type,
      source_unit_tenant_id,
      source_ordering_kind,
      source_ordering_value
    FROM "inventory"."source_assertions" AS assertion
    WHERE assertion.tenant_id = NEW.tenant_id
      AND assertion.assertion_id = NEW.source_assertion_id
      AND assertion.customer_configuration_id = NEW.customer_configuration_id
      AND assertion.authority_configuration_id = NEW.authority_configuration_id
      AND assertion.issuer_backend_kind = NEW.issuer_backend_kind
      AND assertion.issuer_backend_id = NEW.issuer_backend_id
      AND assertion.issuer_authority = 'SELECTED_BACKEND'
      AND assertion.position_id = NEW.position_id
      AND assertion.owner_evidence_ref = NEW.owner_evidence_ref
      AND assertion.source_reference = NEW.source_reference
      AND assertion.business_observed_at = NEW.business_observed_at
      AND EXISTS (
        SELECT 1
        FROM "inventory"."source_import_ledger" AS accepted
        WHERE accepted.tenant_id = assertion.tenant_id
          AND accepted.assertion_id = assertion.assertion_id
          AND accepted.status = 'ACCEPTED'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "inventory"."source_import_ledger" AS competing
        WHERE competing.tenant_id = assertion.tenant_id
          AND competing.customer_configuration_id = assertion.customer_configuration_id
          AND competing.issuer_backend_kind = assertion.issuer_backend_kind
          AND competing.issuer_backend_id = assertion.issuer_backend_id
          AND competing.fact_meaning = assertion.fact_meaning
          AND competing.position_id = assertion.position_id
          AND competing.status = 'ACCEPTED'
          AND (
            competing.ordering_evidence_kind <> assertion.ordering_evidence_kind
            OR (
              assertion.ordering_evidence_kind = 'SOURCE_REVISION'
              AND assertion.ordering_evidence_value <> competing.ordering_evidence_value
              AND (
                assertion.ordering_evidence_value !~ '^[0-9]+$'
                OR competing.ordering_evidence_value !~ '^[0-9]+$'
                OR pg_catalog.length(pg_catalog.ltrim(assertion.ordering_evidence_value, '0'))
                  < pg_catalog.length(pg_catalog.ltrim(competing.ordering_evidence_value, '0'))
                OR (
                  pg_catalog.length(pg_catalog.ltrim(assertion.ordering_evidence_value, '0'))
                    = pg_catalog.length(pg_catalog.ltrim(competing.ordering_evidence_value, '0'))
                  AND pg_catalog.ltrim(assertion.ordering_evidence_value, '0')
                    < pg_catalog.ltrim(competing.ordering_evidence_value, '0')
                )
              )
            )
            OR (
              assertion.ordering_evidence_kind = 'OWNER_ORDER_KEY'
              AND assertion.ordering_evidence_value < competing.ordering_evidence_value
            )
          )
      )
    FOR KEY SHARE;
  ELSE
    SELECT
      evidence.evidence_json -> 'coverage',
      evidence.quantity_amount,
      evidence.stock_item_id,
      evidence.stock_location_id,
      evidence.unit_module_id,
      evidence.unit_resource_id,
      evidence.unit_resource_type,
      evidence.unit_tenant_id,
      evidence.ordering_evidence_kind,
      evidence.ordering_evidence_value
    INTO
      source_coverage,
      source_quantity_amount,
      source_stock_item_id,
      source_stock_location_id,
      source_unit_module_id,
      source_unit_resource_id,
      source_unit_resource_type,
      source_unit_tenant_id,
      source_ordering_kind,
      source_ordering_value
    FROM "inventory"."stock_correction_source_evidence" AS evidence
    JOIN "inventory"."stock_correction_source_evidence_current" AS current_evidence
      ON current_evidence.tenant_id = evidence.tenant_id
      AND current_evidence.customer_configuration_id = evidence.customer_configuration_id
      AND current_evidence.authority_configuration_id = evidence.authority_configuration_id
      AND current_evidence.position_id = evidence.position_id
      AND current_evidence.evidence_id = evidence.evidence_id
      AND current_evidence.ordering_evidence_kind = evidence.ordering_evidence_kind
      AND current_evidence.ordering_evidence_value = evidence.ordering_evidence_value
    WHERE evidence.tenant_id = NEW.tenant_id
      AND evidence.evidence_id = NEW.source_evidence_id
      AND evidence.customer_configuration_id = NEW.customer_configuration_id
      AND evidence.authority_configuration_id = NEW.authority_configuration_id
      AND evidence.position_id = NEW.position_id
      AND evidence.issuer_backend_kind = NEW.issuer_backend_kind
      AND evidence.issuer_backend_id = NEW.issuer_backend_id
      AND evidence.owner_evidence_ref = NEW.owner_evidence_ref
      AND evidence.source_reference = NEW.source_reference
      AND evidence.business_observed_at = NEW.business_observed_at
    FOR KEY SHARE OF evidence, current_evidence;
  END IF;

  IF NOT FOUND
    OR source_stock_item_id IS DISTINCT FROM (
      SELECT position.stock_item_id FROM "inventory"."stock_positions" AS position
      WHERE position.tenant_id = NEW.tenant_id AND position.stock_position_id = NEW.position_id
    )
    OR source_stock_location_id IS DISTINCT FROM (
      SELECT position.stock_location_id FROM "inventory"."stock_positions" AS position
      WHERE position.tenant_id = NEW.tenant_id AND position.stock_position_id = NEW.position_id
    )
    OR source_unit_module_id IS DISTINCT FROM position_unit_module_id
    OR source_unit_resource_id IS DISTINCT FROM position_unit_resource_id
    OR source_unit_resource_type IS DISTINCT FROM position_unit_resource_type
    OR source_unit_tenant_id IS DISTINCT FROM position_unit_tenant_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_corrections_exact_scope_ck',
      MESSAGE = 'Stock Correction evidence must be the exact Current external assertion or OntOS WMS owner head';
  END IF;

  SELECT coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(effect.effect_id::text) ORDER BY effect.requested_at, effect.effect_id),
    '[]'::jsonb
  )
  INTO expected_effect_ids
  FROM "inventory"."physical_stock_effects" AS effect
  WHERE effect.tenant_id = NEW.tenant_id
    AND effect.position_id = NEW.position_id
    AND effect.stock_item_id = source_stock_item_id
    AND effect.stock_location_id = source_stock_location_id
    AND effect.unit_resource_id = source_unit_resource_id
    AND effect.state = 'APPLIED'
    AND (effect.evidence_json ->> 'appliedAt')::timestamptz >= NEW.business_observed_at;

  SELECT
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(evaluated.effect_id) ORDER BY evaluated.ordinality)
      FILTER (WHERE coverage.relation IS NULL), '[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(evaluated.effect_id) ORDER BY evaluated.ordinality)
      FILTER (WHERE coverage.relation = 'UNKNOWN'), '[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(evaluated.effect_id) ORDER BY evaluated.ordinality)
      FILTER (WHERE coverage.relation IN ('EXCLUDES', 'PREDATES')), '[]'::jsonb)
  INTO missing_effect_ids, unknown_effect_ids, excluded_effect_ids
  FROM pg_catalog.jsonb_array_elements_text(expected_effect_ids) WITH ORDINALITY AS evaluated(effect_id, ordinality)
  LEFT JOIN LATERAL (
    SELECT entry ->> 'relation' AS relation
    FROM pg_catalog.jsonb_array_elements(source_coverage) AS entry
    WHERE entry ->> 'effectId' = evaluated.effect_id
  ) AS coverage ON true;

  IF pg_catalog.jsonb_array_length(missing_effect_ids) > 0 THEN
    expected_material_effect_ids := missing_effect_ids;
    expected_reason_code := 'MATERIAL_EFFECT_COVERAGE_MISSING';
  ELSIF pg_catalog.jsonb_array_length(unknown_effect_ids) > 0 THEN
    expected_material_effect_ids := unknown_effect_ids;
    expected_reason_code := 'MATERIAL_EFFECT_COVERAGE_UNKNOWN';
  ELSIF pg_catalog.jsonb_array_length(excluded_effect_ids) > 0 THEN
    expected_material_effect_ids := excluded_effect_ids;
    expected_reason_code := 'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED';
  ELSE
    expected_material_effect_ids := '[]'::jsonb;
    expected_reason_code := NULL;
  END IF;

  IF pg_catalog.jsonb_typeof(NEW.record_json) IS DISTINCT FROM 'object'
    OR NEW.coverage_evidence_json IS DISTINCT FROM source_coverage
    OR NEW.evaluated_material_effect_ids_json IS DISTINCT FROM expected_effect_ids
    OR NEW.record_json -> 'coverageEvidence' IS DISTINCT FROM NEW.coverage_evidence_json
    OR NEW.record_json -> 'evaluatedMaterialEffectIds' IS DISTINCT FROM NEW.evaluated_material_effect_ids_json
    OR NEW.record_json ->> '_tag' IS DISTINCT FROM NEW.state
    OR NEW.record_json ->> 'correctionId' IS DISTINCT FROM NEW.correction_id::text
    OR NEW.record_json ->> 'actionInvocationId' IS DISTINCT FROM NEW.action_invocation_id::text
    OR NEW.record_json ->> 'principalId' IS DISTINCT FROM NEW.principal_id::text
    OR NEW.record_json ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
    OR NEW.record_json ->> 'evidenceKind' IS DISTINCT FROM NEW.evidence_kind
    OR NEW.record_json ->> 'sourceAssertionId' IS DISTINCT FROM NEW.source_assertion_id::text
    OR NEW.record_json ->> 'sourceEvidenceId' IS DISTINCT FROM NEW.source_evidence_id::text
    OR NEW.record_json ->> 'sourceReference' IS DISTINCT FROM NEW.source_reference
    OR NEW.record_json ->> 'ownerEvidenceRef' IS DISTINCT FROM NEW.owner_evidence_ref
    OR NEW.record_json #>> '{issuer,backendKind}' IS DISTINCT FROM NEW.issuer_backend_kind
    OR NEW.record_json #>> '{issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
    OR NEW.record_json #>> '{sourceOrderingEvidence,_tag}' IS DISTINCT FROM source_ordering_kind
    OR (
      source_ordering_kind = 'SOURCE_REVISION'
      AND NEW.record_json #>> '{sourceOrderingEvidence,revision}' IS DISTINCT FROM source_ordering_value
    )
    OR (
      source_ordering_kind = 'OWNER_ORDER_KEY'
      AND NEW.record_json #>> '{sourceOrderingEvidence,key}' IS DISTINCT FROM source_ordering_value
    )
    OR NEW.record_json #>> '{positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.record_json #>> '{positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
    OR NEW.record_json #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.record_json #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
    OR NEW.record_json #>> '{authorityConfigurationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.record_json #>> '{authorityConfigurationRef,resourceId}' IS DISTINCT FROM NEW.authority_configuration_id::text
    OR (NEW.record_json ->> 'businessObservedAt')::timestamptz IS DISTINCT FROM NEW.business_observed_at
    OR (NEW.record_json ->> 'expectedPositionRevision')::integer IS DISTINCT FROM NEW.expected_position_revision
    OR (NEW.record_json ->> 'positionRevisionAfter')::integer IS DISTINCT FROM NEW.position_revision_after
    OR (NEW.record_json ->> 'appliedAt')::timestamptz IS DISTINCT FROM NEW.applied_at
    OR NEW.record_json ->> 'reconcilesCorrectionId' IS DISTINCT FROM NEW.reconciles_correction_id::text
    OR NEW.record_json #>> '{previousOnHand,_tag}' IS DISTINCT FROM position_on_hand_state
    OR NEW.record_json #>> '{previousOnHand,meaning}' IS DISTINCT FROM 'ON_HAND'
    OR NEW.record_json #>> '{previousOnHand,ownerConfigurationRef,resourceId}' IS DISTINCT FROM position_owner_configuration_id::text
    OR (
      position_on_hand_state = 'CURRENT'
      AND (
        (NEW.record_json #>> '{previousOnHand,quantity,amount}')::numeric IS DISTINCT FROM position_on_hand_amount
        OR NEW.record_json #>> '{previousOnHand,evidenceRef}' IS DISTINCT FROM position_on_hand_evidence_ref
        OR (NEW.record_json #>> '{previousOnHand,observedAt}')::timestamptz IS DISTINCT FROM position_on_hand_observed_at
        OR NEW.record_json #>> '{previousOnHand,quantity,unitRef,resourceId}' IS DISTINCT FROM position_unit_resource_id::text
      )
    )
    OR (
      position_on_hand_state = 'STALE'
      AND (
        (NEW.record_json #>> '{previousOnHand,lastKnownQuantity,amount}')::numeric IS DISTINCT FROM position_on_hand_amount
        OR NEW.record_json #>> '{previousOnHand,evidenceRef}' IS DISTINCT FROM position_on_hand_evidence_ref
        OR (NEW.record_json #>> '{previousOnHand,lastObservedAt}')::timestamptz IS DISTINCT FROM position_on_hand_observed_at
        OR NEW.record_json #>> '{previousOnHand,lastKnownQuantity,unitRef,resourceId}' IS DISTINCT FROM position_unit_resource_id::text
      )
    )
    OR (
      position_on_hand_state IN ('UNKNOWN', 'MISSING', 'INDETERMINATE')
      AND NEW.record_json #>> '{previousOnHand,unitRef,resourceId}' IS DISTINCT FROM position_unit_resource_id::text
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_corrections_exact_scope_ck',
      MESSAGE = 'Stock Correction JSON evidence must exactly match relational provenance and evaluated APPLIED effects';
  END IF;

  IF NEW.state = 'APPLIED' THEN
    IF expected_reason_code IS NOT NULL
      OR source_quantity_amount::numeric IS DISTINCT FROM NEW.corrected_quantity_amount
      OR NEW.record_json #>> '{correctedQuantity,amount}' IS DISTINCT FROM source_quantity_amount
      OR NEW.record_json #>> '{correctedQuantity,unitRef,resourceId}' IS DISTINCT FROM source_unit_resource_id::text
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_stock_corrections_exact_scope_ck',
        MESSAGE = 'Applied Stock Correction must preserve the exact source absolute Quantity and Unit';
    END IF;
  ELSIF expected_reason_code IS NULL
    OR NEW.record_json -> 'materialEffectIds' IS DISTINCT FROM expected_material_effect_ids
    OR NEW.record_json ->> 'reasonCode' IS DISTINCT FROM expected_reason_code
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_corrections_exact_scope_ck',
      MESSAGE = 'Indeterminate Stock Correction must retain the exact material-effect reconciliation evidence';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_corrections_exact_scope_trg"
BEFORE INSERT ON "inventory"."stock_corrections"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_correction_exact_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_correction_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_stock_corrections_append_only_ck',
    MESSAGE = 'Stock Correction evidence is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_corrections_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_corrections"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_correction_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_correction_open_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  replacement_reconciles uuid;
  replacement_state text;
  replacement_position_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1
    FROM "inventory"."stock_corrections" AS replacement
    WHERE replacement.tenant_id = OLD.tenant_id
      AND replacement.position_id = OLD.position_id
      AND replacement.reconciles_correction_id = OLD.correction_id
      AND replacement.state = 'APPLIED'
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_stock_correction_open_transition_ck',
        MESSAGE = 'An open Stock Correction marker may be deleted only after an APPLIED reconciliation';
    END IF;
    RETURN OLD;
  END IF;

  SELECT correction.state, correction.position_id, correction.reconciles_correction_id
  INTO replacement_state, replacement_position_id, replacement_reconciles
  FROM "inventory"."stock_corrections" AS correction
  WHERE correction.tenant_id = NEW.tenant_id
    AND correction.correction_id = NEW.correction_id
  FOR KEY SHARE;

  IF NOT FOUND
    OR replacement_state IS DISTINCT FROM 'INDETERMINATE'
    OR replacement_position_id IS DISTINCT FROM NEW.position_id
    OR (TG_OP = 'INSERT' AND replacement_reconciles IS NULL AND EXISTS (
      SELECT 1 FROM "inventory"."stock_correction_open_reconciliations" AS current_marker
      WHERE current_marker.tenant_id = NEW.tenant_id AND current_marker.position_id = NEW.position_id
    ))
    OR (replacement_reconciles IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "inventory"."stock_correction_open_reconciliations" AS current_marker
      WHERE current_marker.tenant_id = NEW.tenant_id
        AND current_marker.position_id = NEW.position_id
        AND current_marker.correction_id = replacement_reconciles
    ))
    OR (TG_OP = 'UPDATE' AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.position_id IS DISTINCT FROM OLD.position_id
      OR replacement_reconciles IS DISTINCT FROM OLD.correction_id
    ))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_correction_open_transition_ck',
      MESSAGE = 'Open Stock Correction marker transitions must form one exact INDETERMINATE reconciliation chain';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_correction_open_transition_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "inventory"."stock_correction_open_reconciliations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_correction_open_transition"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_correction_source_evidence_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_correction_source_evidence_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_correction_source_evidence_coverage_complete"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_correction_source_evidence_current_transition"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_correction_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_correction_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_correction_open_transition"() FROM PUBLIC, "ontos_runtime";
