CREATE TABLE "catalog"."product_type_untyped_decisions" (
	"tenant_id" uuid,
	"product_id" uuid,
	"decision_revision" integer,
	"decision_state" text NOT NULL,
	"structured_attributes_required" boolean NOT NULL,
	"variant_axes_required" boolean NOT NULL,
	"product_revision" integer NOT NULL,
	"axis_revision" integer NOT NULL,
	"value_revision_tokens" text[] NOT NULL,
	"variant_revision_tokens" text[] NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_type_untyped_decisions_pk" PRIMARY KEY("tenant_id","product_id","decision_revision"),
	CONSTRAINT "catalog_product_type_untyped_decisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_type_untyped_decisions_revision_ck" CHECK ("decision_revision" > 0 and "product_revision" > 0 and "axis_revision" >= 0),
	CONSTRAINT "catalog_product_type_untyped_decisions_state_ck" CHECK ("decision_state" in ('CONFIRMED', 'REVOKED')),
	CONSTRAINT "catalog_product_type_untyped_decisions_confirmed_ck" CHECK ("decision_state" <> 'CONFIRMED' or (not "structured_attributes_required" and not "variant_axes_required")),
	CONSTRAINT "catalog_product_type_untyped_decisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_untyped_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_untyped_decisions" ADD CONSTRAINT "catalog_product_type_untyped_decisions_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_type_untyped_decisions_tenant_select" ON "catalog"."product_type_untyped_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_type_untyped_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_untyped_decisions_tenant_insert" ON "catalog"."product_type_untyped_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_type_untyped_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_untyped_decisions_tenant_update" ON "catalog"."product_type_untyped_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_type_untyped_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_type_untyped_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_untyped_decisions_tenant_delete" ON "catalog"."product_type_untyped_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_type_untyped_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_untyped_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_type_untyped_decisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_type_untyped_decisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
