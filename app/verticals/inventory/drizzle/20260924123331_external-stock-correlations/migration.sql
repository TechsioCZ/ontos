CREATE TABLE "inventory"."external_stock_correlations" (
	"correlation_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"namespace" text NOT NULL,
	"external_scope" text NOT NULL,
	"identifier_kind" text NOT NULL,
	"external_value" text NOT NULL,
	"stock_item_id" uuid,
	"stock_location_id" uuid,
	"lifecycle_state" text DEFAULT 'CURRENT' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"owner_evidence_ref" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_external_stock_correlations_key_ck" CHECK (length(btrim("customer_configuration_id")) between 1 and 300 and "issuer_backend_kind" in ('external_business_system', 'ontos_wms') and length(btrim("issuer_backend_id")) between 1 and 300 and length(btrim("namespace")) between 1 and 300 and length(btrim("external_scope")) between 1 and 300 and "identifier_kind" in ('ITEM', 'LOCATION') and length(btrim("external_value")) between 1 and 300),
	CONSTRAINT "inventory_external_stock_correlations_target_ck" CHECK (("identifier_kind" = 'ITEM' and "stock_item_id" is not null and "stock_location_id" is null) or ("identifier_kind" = 'LOCATION' and "stock_item_id" is null and "stock_location_id" is not null)),
	CONSTRAINT "inventory_external_stock_correlations_lifecycle_ck" CHECK (("lifecycle_state" = 'CURRENT' and "effective_to" is null) or ("lifecycle_state" = 'ENDED' and "effective_to" is not null and "effective_from" < "effective_to")),
	CONSTRAINT "inventory_external_stock_correlations_evidence_ck" CHECK (length(btrim("owner_evidence_ref")) between 1 and 300),
	CONSTRAINT "inventory_external_stock_correlations_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."external_stock_correlations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_external_stock_correlations_scope_id_uk" ON "inventory"."external_stock_correlations" ("tenant_id","correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_external_stock_correlations_current_key_uk" ON "inventory"."external_stock_correlations" ("tenant_id","customer_configuration_id","issuer_backend_kind","issuer_backend_id","namespace","external_scope","identifier_kind","external_value") WHERE "lifecycle_state" = 'CURRENT' and "effective_to" is null;--> statement-breakpoint
CREATE INDEX "inventory_external_stock_correlations_item_idx" ON "inventory"."external_stock_correlations" ("tenant_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "inventory_external_stock_correlations_location_idx" ON "inventory"."external_stock_correlations" ("tenant_id","stock_location_id");--> statement-breakpoint
ALTER TABLE "inventory"."external_stock_correlations" ADD CONSTRAINT "inventory_external_stock_correlations_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."external_stock_correlations" ADD CONSTRAINT "inventory_external_stock_correlations_location_fk" FOREIGN KEY ("tenant_id","stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_external_stock_correlations_tenant_select" ON "inventory"."external_stock_correlations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."external_stock_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_external_stock_correlations_tenant_insert" ON "inventory"."external_stock_correlations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."external_stock_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_external_stock_correlations_tenant_update" ON "inventory"."external_stock_correlations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."external_stock_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."external_stock_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_external_stock_correlations_tenant_delete" ON "inventory"."external_stock_correlations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."external_stock_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."external_stock_correlations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_external_stock_correlation_identity_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_external_stock_correlations_no_delete_ck',
      MESSAGE = 'Inventory External Stock Correlations are durable history and cannot be deleted';
  END IF;

  IF NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.issuer_backend_kind IS DISTINCT FROM OLD.issuer_backend_kind
    OR NEW.issuer_backend_id IS DISTINCT FROM OLD.issuer_backend_id
    OR NEW.namespace IS DISTINCT FROM OLD.namespace
    OR NEW.external_scope IS DISTINCT FROM OLD.external_scope
    OR NEW.identifier_kind IS DISTINCT FROM OLD.identifier_kind
    OR NEW.external_value IS DISTINCT FROM OLD.external_value
    OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id
    OR NEW.stock_location_id IS DISTINCT FROM OLD.stock_location_id
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_external_stock_correlations_immutable_identity_ck',
      MESSAGE = 'Inventory External Stock Correlation identity and effective-from evidence are immutable';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_external_stock_correlations_immutable_identity_trg"
BEFORE UPDATE ON "inventory"."external_stock_correlations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_external_stock_correlation_identity_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_external_stock_correlations_no_delete_trg"
BEFORE DELETE ON "inventory"."external_stock_correlations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_external_stock_correlation_identity_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_external_stock_correlation_nonoverlap"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.concat_ws(
        E'\x1f',
        NEW.tenant_id::text,
        NEW.customer_configuration_id,
        NEW.issuer_backend_kind,
        NEW.issuer_backend_id,
        NEW.namespace,
        NEW.external_scope,
        NEW.identifier_kind,
        NEW.external_value
      ),
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM "inventory"."external_stock_correlations" AS existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.customer_configuration_id = NEW.customer_configuration_id
      AND existing.issuer_backend_kind = NEW.issuer_backend_kind
      AND existing.issuer_backend_id = NEW.issuer_backend_id
      AND existing.namespace = NEW.namespace
      AND existing.external_scope = NEW.external_scope
      AND existing.identifier_kind = NEW.identifier_kind
      AND existing.external_value = NEW.external_value
      AND existing.correlation_id <> NEW.correlation_id
      AND pg_catalog.tstzrange(existing.effective_from, existing.effective_to, '[)')
        && pg_catalog.tstzrange(NEW.effective_from, NEW.effective_to, '[)')
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      CONSTRAINT = 'inventory_external_stock_correlations_effective_period_excl',
      MESSAGE = 'Inventory External Stock Correlation Effective Periods cannot overlap for one exact external key';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_external_stock_correlations_nonoverlap_trg"
BEFORE INSERT OR UPDATE ON "inventory"."external_stock_correlations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_external_stock_correlation_nonoverlap"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_external_stock_correlation_identity_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_external_stock_correlation_nonoverlap"() FROM PUBLIC, "ontos_runtime";
