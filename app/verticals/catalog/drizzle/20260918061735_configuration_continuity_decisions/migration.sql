CREATE TABLE "catalog"."product_configuration_continuity_decisions" (
	"tenant_id" uuid,
	"decision_id" uuid DEFAULT gen_random_uuid(),
	"definition_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"package_definition_id" uuid,
	"left_revision" integer NOT NULL,
	"right_revision" integer NOT NULL,
	"left_selection_hash" text NOT NULL,
	"right_selection_hash" text NOT NULL,
	"meaning_evidence_refs" text[] NOT NULL,
	"left_rule_evidence_refs" text[] NOT NULL,
	"right_rule_evidence_refs" text[] NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_configuration_continuity_pk" PRIMARY KEY("tenant_id","decision_id"),
	CONSTRAINT "catalog_configuration_continuity_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_configuration_continuity_revisions_ck" CHECK ("left_revision" > 0 and "right_revision" > 0 and "left_revision" <> "right_revision"),
	CONSTRAINT "catalog_configuration_continuity_left_hash_ck" CHECK ("left_selection_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_configuration_continuity_right_hash_ck" CHECK ("right_selection_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_configuration_continuity_evidence_ck" CHECK (cardinality("meaning_evidence_refs") > 0 and cardinality("left_rule_evidence_refs") > 0 and cardinality("right_rule_evidence_refs") > 0),
	CONSTRAINT "catalog_configuration_continuity_reason_ck" CHECK (length(btrim("reason")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" ADD CONSTRAINT "catalog_configuration_continuity_definition_fk" FOREIGN KEY ("tenant_id","product_id","definition_id") REFERENCES "catalog"."product_configuration_definitions"("tenant_id","product_id","definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" ADD CONSTRAINT "catalog_configuration_continuity_left_fk" FOREIGN KEY ("tenant_id","definition_id","left_revision") REFERENCES "catalog"."product_configuration_definition_revisions"("tenant_id","definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" ADD CONSTRAINT "catalog_configuration_continuity_right_fk" FOREIGN KEY ("tenant_id","definition_id","right_revision") REFERENCES "catalog"."product_configuration_definition_revisions"("tenant_id","definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" ADD CONSTRAINT "catalog_configuration_continuity_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" ADD CONSTRAINT "catalog_configuration_continuity_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_configuration_continuity_tenant_select" ON "catalog"."product_configuration_continuity_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_continuity_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_continuity_tenant_insert" ON "catalog"."product_configuration_continuity_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_continuity_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_continuity_tenant_update" ON "catalog"."product_configuration_continuity_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_continuity_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_continuity_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_continuity_tenant_delete" ON "catalog"."product_configuration_continuity_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_continuity_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_continuity_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_continuity_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_continuity_decisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
