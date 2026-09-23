CREATE TABLE "catalog"."product_variant_axis_allowance_events" (
	"tenant_id" uuid,
	"product_id" uuid,
	"attribute_definition_id" uuid,
	"allowance_revision" integer,
	"axis_revision" integer NOT NULL,
	"definition_revision" integer NOT NULL,
	"value_count" integer NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_variant_axis_allowance_events_pk" PRIMARY KEY("tenant_id","product_id","attribute_definition_id","allowance_revision"),
	CONSTRAINT "catalog_product_variant_axis_allowance_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_variant_axis_allowance_revision_ck" CHECK ("allowance_revision" > 0 and "axis_revision" > 0 and "definition_revision" > 0 and "value_count" >= 0),
	CONSTRAINT "catalog_product_variant_axis_allowance_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_allowance_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_variant_axis_allowed_values" (
	"tenant_id" uuid,
	"product_id" uuid,
	"attribute_definition_id" uuid,
	"allowance_revision" integer,
	"value_key" text,
	"value_snapshot" jsonb NOT NULL,
	CONSTRAINT "catalog_product_variant_axis_allowed_values_pk" PRIMARY KEY("tenant_id","product_id","attribute_definition_id","allowance_revision","value_key"),
	CONSTRAINT "catalog_product_variant_axis_allowed_values_key_ck" CHECK (length("value_key") = 64 and "value_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_allowed_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_allowance_events" ADD CONSTRAINT "catalog_product_variant_axis_allowance_axis_fk" FOREIGN KEY ("tenant_id","product_id","axis_revision") REFERENCES "catalog"."product_variant_axis_events"("tenant_id","product_id","axis_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_allowance_events" ADD CONSTRAINT "catalog_product_variant_axis_allowance_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_allowed_values" ADD CONSTRAINT "catalog_product_variant_axis_allowed_values_event_fk" FOREIGN KEY ("tenant_id","product_id","attribute_definition_id","allowance_revision") REFERENCES "catalog"."product_variant_axis_allowance_events"("tenant_id","product_id","attribute_definition_id","allowance_revision") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowance_events_tenant_select" ON "catalog"."product_variant_axis_allowance_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_variant_axis_allowance_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowance_events_tenant_insert" ON "catalog"."product_variant_axis_allowance_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_variant_axis_allowance_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowance_events_tenant_update" ON "catalog"."product_variant_axis_allowance_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_variant_axis_allowance_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_variant_axis_allowance_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowance_events_tenant_delete" ON "catalog"."product_variant_axis_allowance_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_variant_axis_allowance_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowed_values_tenant_select" ON "catalog"."product_variant_axis_allowed_values" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_variant_axis_allowed_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowed_values_tenant_insert" ON "catalog"."product_variant_axis_allowed_values" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_variant_axis_allowed_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowed_values_tenant_update" ON "catalog"."product_variant_axis_allowed_values" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_variant_axis_allowed_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_variant_axis_allowed_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_allowed_values_tenant_delete" ON "catalog"."product_variant_axis_allowed_values" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_variant_axis_allowed_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Drizzle owns policies but PostgreSQL FORCE RLS is part of the owner boundary.
ALTER TABLE "catalog"."product_variant_axis_allowance_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_allowed_values" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_variant_axis_allowance_events_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_variant_axis_allowance_events"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_variant_axis_allowed_values_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_variant_axis_allowed_values"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();