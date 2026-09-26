CREATE TABLE "inventory"."binding_correction_reconciliations" (
	"reconciliation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_revision" integer NOT NULL,
	"correction_evidence_ref" text NOT NULL,
	"corrected_at" timestamp with time zone NOT NULL,
	"obligation_id" uuid NOT NULL,
	"purchase_demand_occurrence_id" text NOT NULL,
	"historical_stock_item_id" uuid NOT NULL,
	"current_stock_item_id" uuid NOT NULL,
	"reason" text DEFAULT 'POST_COMMIT_BINDING_MISMATCH' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_binding_correction_reconciliations_meaning_ck" CHECK ("binding_revision" >= 2 and char_length(btrim("correction_evidence_ref")) between 1 and 300 and char_length(btrim("purchase_demand_occurrence_id")) between 1 and 300 and "reason" = 'POST_COMMIT_BINDING_MISMATCH' and "status" = 'OPEN' and "historical_stock_item_id" <> "current_stock_item_id")
);
--> statement-breakpoint
ALTER TABLE "inventory"."binding_correction_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_binding_correction_reconciliations_scope_id_uk" ON "inventory"."binding_correction_reconciliations" ("tenant_id","reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_binding_correction_reconciliations_observation_uk" ON "inventory"."binding_correction_reconciliations" ("tenant_id","binding_id","binding_revision","obligation_id","purchase_demand_occurrence_id");--> statement-breakpoint
CREATE INDEX "inventory_binding_correction_reconciliations_open_idx" ON "inventory"."binding_correction_reconciliations" ("tenant_id","status","corrected_at");--> statement-breakpoint
CREATE INDEX "inventory_obligation_requirements_binding_impact_idx" ON "inventory"."obligation_requirements" ("tenant_id","binding_id","stock_item_id","exact_selection_meaning_kind","exact_selection_meaning_id");--> statement-breakpoint
ALTER TABLE "inventory"."binding_correction_reconciliations" ADD CONSTRAINT "inventory_binding_correction_reconciliations_requirement_fk" FOREIGN KEY ("tenant_id","obligation_id","purchase_demand_occurrence_id") REFERENCES "inventory"."obligation_requirements"("tenant_id","obligation_id","purchase_demand_occurrence_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."binding_correction_reconciliations" ADD CONSTRAINT "inventory_binding_correction_reconciliations_historical_item_fk" FOREIGN KEY ("tenant_id","historical_stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."binding_correction_reconciliations" ADD CONSTRAINT "inventory_binding_correction_reconciliations_current_item_fk" FOREIGN KEY ("tenant_id","current_stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_binding_correction_reconciliations_tenant_select" ON "inventory"."binding_correction_reconciliations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."binding_correction_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_binding_correction_reconciliations_tenant_insert" ON "inventory"."binding_correction_reconciliations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."binding_correction_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_binding_correction_reconciliations_tenant_update" ON "inventory"."binding_correction_reconciliations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."binding_correction_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."binding_correction_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_binding_correction_reconciliations_tenant_delete" ON "inventory"."binding_correction_reconciliations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."binding_correction_reconciliations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."binding_correction_reconciliations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inventory"."binding_correction_reconciliations" TO "ontos_runtime";
