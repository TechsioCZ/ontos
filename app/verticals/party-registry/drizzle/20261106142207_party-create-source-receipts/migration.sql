CREATE TABLE "party"."party_create_source_receipts" (
	"tenant_id" uuid,
	"action_invocation_id" uuid,
	"principal_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"match_decision_id" uuid NOT NULL,
	CONSTRAINT "party_create_source_receipts_pkey" PRIMARY KEY("tenant_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "party"."party_create_source_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle models RLS enablement and policies but cannot express PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "party"."party_create_source_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "party_create_source_receipts_tenant_decision_idx" ON "party"."party_create_source_receipts" ("tenant_id","match_decision_id");--> statement-breakpoint
ALTER TABLE "party"."party_create_source_receipts" ADD CONSTRAINT "party_create_source_receipts_tenant_decision_fk" FOREIGN KEY ("tenant_id","match_decision_id") REFERENCES "party"."party_match_decisions"("tenant_id","match_decision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "party_create_source_receipts_tenant_select" ON "party"."party_create_source_receipts" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("party"."party_create_source_receipts"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_create_source_receipts_tenant_insert" ON "party"."party_create_source_receipts" AS PERMISSIVE FOR INSERT TO "party_registry_runtime" WITH CHECK ("party"."party_create_source_receipts"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_create_source_receipts_tenant_update" ON "party"."party_create_source_receipts" AS PERMISSIVE FOR UPDATE TO "party_registry_runtime" USING ("party"."party_create_source_receipts"."tenant_id" = (select trust.current_tenant_id())) WITH CHECK ("party"."party_create_source_receipts"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_create_source_receipts_tenant_delete" ON "party"."party_create_source_receipts" AS PERMISSIVE FOR DELETE TO "party_registry_runtime" USING ("party"."party_create_source_receipts"."tenant_id" = (select trust.current_tenant_id()));
