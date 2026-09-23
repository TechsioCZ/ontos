CREATE TABLE "catalog"."package_option_role_revisions" (
	"tenant_id" uuid,
	"package_definition_id" uuid,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"revision" integer,
	"content_revision" integer NOT NULL,
	"state" text NOT NULL,
	"independently_requested" boolean NOT NULL,
	"loose_units_substitutable" boolean NOT NULL,
	"validation_reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_package_option_role_revisions_pk" PRIMARY KEY("tenant_id","package_definition_id","revision"),
	CONSTRAINT "catalog_package_option_role_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_package_option_role_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_package_option_role_revisions_content_ck" CHECK ("content_revision" > 0),
	CONSTRAINT "catalog_package_option_role_revisions_state_ck" CHECK ("state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_package_option_role_revisions_active_ck" CHECK ("state" <> 'ACTIVE' or ("independently_requested" and not "loose_units_substitutable")),
	CONSTRAINT "catalog_package_option_role_revisions_reason_ck" CHECK ("validation_reason" = btrim("validation_reason") and length("validation_reason") between 1 and 1000),
	CONSTRAINT "catalog_package_option_role_revisions_evidence_ck" CHECK (cardinality("evidence_refs") > 0 and array_position("evidence_refs", null) is null)
);
--> statement-breakpoint
ALTER TABLE "catalog"."package_option_role_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."package_definitions" ADD COLUMN "current_option_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_package_option_role_revisions_effective_idx" ON "catalog"."package_option_role_revisions" ("tenant_id","package_definition_id","effective_at");--> statement-breakpoint
ALTER TABLE "catalog"."package_option_role_revisions" ADD CONSTRAINT "catalog_package_option_role_revisions_definition_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_option_role_revisions" ADD CONSTRAINT "catalog_package_option_role_revisions_content_fk" FOREIGN KEY ("tenant_id","package_definition_id","content_revision") REFERENCES "catalog"."package_content_revisions"("tenant_id","package_definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_definitions" ADD CONSTRAINT "catalog_package_definitions_option_revision_ck" CHECK ("current_option_revision" >= 0);--> statement-breakpoint
CREATE POLICY "catalog_package_option_role_revisions_tenant_select" ON "catalog"."package_option_role_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."package_option_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_option_role_revisions_tenant_insert" ON "catalog"."package_option_role_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."package_option_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_option_role_revisions_tenant_update" ON "catalog"."package_option_role_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."package_option_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."package_option_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_option_role_revisions_tenant_delete" ON "catalog"."package_option_role_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."package_option_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."package_option_role_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_package_option_role_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."package_option_role_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
