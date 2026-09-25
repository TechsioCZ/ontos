CREATE TABLE "inventory"."stock_sharing_eligibilities" (
	"eligibility_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"owner_configuration_id" uuid NOT NULL,
	"stock_position_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"commerce_market_id" text,
	"storefront_app_id" text,
	"commerce_validation_evidence_ref" text NOT NULL,
	"commerce_validation_observed_at" timestamp with time zone NOT NULL,
	"lifecycle_state" text DEFAULT 'CURRENT' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_sharing_eligibilities_subject_ck" CHECK ("channel" in ('B2C', 'B2B') and char_length(btrim("commerce_validation_evidence_ref")) between 1 and 300 and ("commerce_market_id" is null or char_length(btrim("commerce_market_id")) between 1 and 300) and ("storefront_app_id" is null or "storefront_app_id" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')),
	CONSTRAINT "inventory_stock_sharing_eligibilities_lifecycle_ck" CHECK (("lifecycle_state" = 'CURRENT' and "effective_to" is null) or ("lifecycle_state" = 'ENDED' and "effective_to" is not null and "effective_from" < "effective_to")),
	CONSTRAINT "inventory_stock_sharing_eligibilities_revision_ck" CHECK ("current_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_sharing_eligibility_history" (
	"history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"eligibility_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"transition_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_sharing_eligibility_history_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibility_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_sharing_eligibilities_scope_id_uk" ON "inventory"."stock_sharing_eligibilities" ("tenant_id","eligibility_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_sharing_eligibilities_current_position_idx" ON "inventory"."stock_sharing_eligibilities" ("tenant_id","customer_configuration_id","owner_configuration_id","stock_position_id") WHERE "lifecycle_state" = 'CURRENT' and "effective_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_sharing_eligibility_history_scope_id_uk" ON "inventory"."stock_sharing_eligibility_history" ("tenant_id","history_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_sharing_eligibility_history_revision_uk" ON "inventory"."stock_sharing_eligibility_history" ("tenant_id","eligibility_id","revision");--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibilities" ADD CONSTRAINT "inventory_stock_sharing_eligibilities_backend_configuration_fk" FOREIGN KEY ("tenant_id","owner_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibilities" ADD CONSTRAINT "inventory_stock_sharing_eligibilities_position_fk" FOREIGN KEY ("tenant_id","stock_position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibility_history" ADD CONSTRAINT "inventory_stock_sharing_eligibility_history_eligibility_fk" FOREIGN KEY ("tenant_id","eligibility_id") REFERENCES "inventory"."stock_sharing_eligibilities"("tenant_id","eligibility_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibilities_tenant_select" ON "inventory"."stock_sharing_eligibilities" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_sharing_eligibilities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibilities_tenant_insert" ON "inventory"."stock_sharing_eligibilities" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_sharing_eligibilities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibilities_tenant_update" ON "inventory"."stock_sharing_eligibilities" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_sharing_eligibilities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_sharing_eligibilities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibilities_tenant_delete" ON "inventory"."stock_sharing_eligibilities" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_sharing_eligibilities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibility_history_tenant_select" ON "inventory"."stock_sharing_eligibility_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_sharing_eligibility_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibility_history_tenant_insert" ON "inventory"."stock_sharing_eligibility_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_sharing_eligibility_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibility_history_tenant_update" ON "inventory"."stock_sharing_eligibility_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_sharing_eligibility_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_sharing_eligibility_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_sharing_eligibility_history_tenant_delete" ON "inventory"."stock_sharing_eligibility_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_sharing_eligibility_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibilities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_sharing_eligibility_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_sharing_eligibility_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM 1
  FROM "inventory"."stock_positions" AS position
  WHERE position.tenant_id = NEW.tenant_id
    AND position.stock_position_id = NEW.stock_position_id
    AND position.customer_configuration_id = NEW.customer_configuration_id
    AND position.owner_configuration_id = NEW.owner_configuration_id
    AND position.lifecycle_state = 'CURRENT'
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_sharing_eligibilities_position_scope_ck',
      MESSAGE = 'Stock Sharing Eligibility requires the exact Current Stock Position scope';
  END IF;

  PERFORM 1
  FROM "inventory"."backend_configurations" AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.configuration_id = NEW.owner_configuration_id
    AND backend.customer_configuration_id = NEW.customer_configuration_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_sharing_eligibilities_backend_scope_ck',
      MESSAGE = 'Stock Sharing Eligibility requires the selected backend for its Customer Configuration';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_sharing_eligibilities_scope_trg"
BEFORE INSERT OR UPDATE ON "inventory"."stock_sharing_eligibilities"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_sharing_eligibility_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_sharing_eligibility_identity_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_sharing_eligibilities_no_delete_ck',
      MESSAGE = 'Stock Sharing Eligibilities are durable and cannot be deleted';
  END IF;

  IF NEW.eligibility_id IS DISTINCT FROM OLD.eligibility_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.owner_configuration_id IS DISTINCT FROM OLD.owner_configuration_id
    OR NEW.stock_position_id IS DISTINCT FROM OLD.stock_position_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_stock_sharing_eligibilities_immutable_identity_ck',
      MESSAGE = 'Stock Sharing Eligibility identity is immutable';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_sharing_eligibilities_immutable_identity_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_sharing_eligibilities"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_sharing_eligibility_identity_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_sharing_eligibility_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_stock_sharing_eligibility_history_append_only_ck',
    MESSAGE = 'Stock Sharing Eligibility history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_sharing_eligibility_history_no_update_trg"
BEFORE UPDATE ON "inventory"."stock_sharing_eligibility_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_sharing_eligibility_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_sharing_eligibility_history_no_delete_trg"
BEFORE DELETE ON "inventory"."stock_sharing_eligibility_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_sharing_eligibility_history_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_sharing_eligibility_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_sharing_eligibility_identity_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_sharing_eligibility_history_mutation"() FROM PUBLIC, "ontos_runtime";
