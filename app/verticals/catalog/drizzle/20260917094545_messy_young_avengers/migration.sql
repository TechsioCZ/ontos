CREATE TABLE "catalog"."product_configuration_revision_activations" (
	"tenant_id" uuid,
	"definition_id" uuid,
	"revision" integer,
	"superseded_revision" integer,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_configuration_revision_activations_pk" PRIMARY KEY("tenant_id","definition_id","revision"),
	CONSTRAINT "catalog_configuration_revision_activations_time_uk" UNIQUE("tenant_id","definition_id","effective_at"),
	CONSTRAINT "catalog_configuration_revision_activations_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_configuration_revision_activations_predecessor_ck" CHECK ("superseded_revision" is null or "superseded_revision" <> "revision"),
	CONSTRAINT "catalog_configuration_revision_activations_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_revision_activations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_revision_activations" ADD CONSTRAINT "catalog_configuration_revision_activations_revision_fk" FOREIGN KEY ("tenant_id","definition_id","revision") REFERENCES "catalog"."product_configuration_definition_revisions"("tenant_id","definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_revision_activations" ADD CONSTRAINT "catalog_configuration_revision_activations_predecessor_fk" FOREIGN KEY ("tenant_id","definition_id","superseded_revision") REFERENCES "catalog"."product_configuration_definition_revisions"("tenant_id","definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_configuration_revision_activations_tenant_select" ON "catalog"."product_configuration_revision_activations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_revision_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_revision_activations_tenant_insert" ON "catalog"."product_configuration_revision_activations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_revision_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_revision_activations_tenant_update" ON "catalog"."product_configuration_revision_activations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_revision_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_revision_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_revision_activations_tenant_delete" ON "catalog"."product_configuration_revision_activations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_revision_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_revision_activations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_revision_activations_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_revision_activations"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
