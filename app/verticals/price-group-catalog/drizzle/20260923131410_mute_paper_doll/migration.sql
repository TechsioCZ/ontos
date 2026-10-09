CREATE TABLE "price_group_catalog"."price_group_containment_projection_intents" (
	"mutation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"price_group_id" uuid NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	"definition_catalog_revision" bigint NOT NULL,
	"source_action_invocation_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"catalog_version" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_containment_intents_scope_mutation_uk" UNIQUE("tenant_id","mutation_id"),
	CONSTRAINT "price_group_catalog_containment_intents_scope_action_uk" UNIQUE("tenant_id","source_action_invocation_id"),
	CONSTRAINT "price_group_catalog_containment_intents_scope_group_uk" UNIQUE("tenant_id","price_group_id"),
	CONSTRAINT "price_group_catalog_containment_intents_operation_ck" CHECK ("operation" = 'TOUCH_CONTAINMENT'),
	CONSTRAINT "price_group_catalog_containment_intents_catalog_version_ck" CHECK ("catalog_version" = '1'),
	CONSTRAINT "price_group_catalog_containment_intents_state_ck" CHECK ("state" in ('PENDING', 'APPLIED')),
	CONSTRAINT "price_group_catalog_containment_intents_completion_ck" CHECK (("state" = 'PENDING' and "completed_at" is null) or ("state" = 'APPLIED' and "completed_at" is not null and "completed_at" >= "requested_at"))
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_containment_projection_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "price_group_catalog_containment_intents_pending_idx" ON "price_group_catalog"."price_group_containment_projection_intents" ("tenant_id","state","requested_at");--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_containment_projection_intents" ADD CONSTRAINT "price_group_catalog_containment_intents_definition_fk" FOREIGN KEY ("tenant_id","price_group_id","definition_revision_id") REFERENCES "price_group_catalog"."price_group_definition_revisions"("tenant_id","price_group_id","definition_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_containment_projection_intents" ADD CONSTRAINT "price_group_catalog_containment_intents_ledger_fk" FOREIGN KEY ("tenant_id","definition_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "price_group_catalog_containment_intents_scope_select" ON "price_group_catalog"."price_group_containment_projection_intents" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_containment_projection_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_containment_intents_scope_insert" ON "price_group_catalog"."price_group_containment_projection_intents" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_containment_projection_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_containment_intents_scope_update" ON "price_group_catalog"."price_group_containment_projection_intents" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_containment_projection_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_containment_projection_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_containment_intents_scope_delete" ON "price_group_catalog"."price_group_containment_projection_intents" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_containment_projection_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);