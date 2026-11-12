CREATE TABLE "party"."party_legacy_ico_authority_fences" (
	"tenant_id" uuid PRIMARY KEY,
	"fence_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_version" text NOT NULL,
	"fenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"migration_plan_ref" text NOT NULL,
	CONSTRAINT "party_legacy_ico_authority_fences_tenant_id_uk" UNIQUE("tenant_id","fence_id"),
	CONSTRAINT "party_legacy_ico_authority_fences_version_ck" CHECK ("snapshot_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "party_legacy_ico_authority_fences_plan_ck" CHECK (length("migration_plan_ref") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "party"."party_legacy_ico_authority_fences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party"."party_legacy_ico_authority_fences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_source_effect_receipts" (
	"tenant_id" uuid,
	"source_occurrence_hash" text,
	"request_hash" text NOT NULL,
	"operation" text NOT NULL,
	"party_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_source_effect_receipts_pkey" PRIMARY KEY("tenant_id","source_occurrence_hash"),
	CONSTRAINT "party_source_effect_receipts_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "party_source_effect_receipts_hash_ck" CHECK ("source_occurrence_hash" ~ '^[0-9a-f]{64}$' and "request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "party_source_effect_receipts_operation_ck" CHECK ("operation" in ('UPDATE', 'CORRECTION')),
	CONSTRAINT "party_source_effect_receipts_result_ck" CHECK (jsonb_typeof("result") = 'object' and octet_length("result"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "party"."party_source_effect_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party"."party_source_effect_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party"."party_source_effect_receipts" ADD CONSTRAINT "party_source_effect_receipts_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "party_legacy_ico_authority_fences_tenant_select" ON "party"."party_legacy_ico_authority_fences" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("party"."party_legacy_ico_authority_fences"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_legacy_ico_authority_fences_tenant_insert" ON "party"."party_legacy_ico_authority_fences" AS PERMISSIVE FOR INSERT TO "party_registry_runtime" WITH CHECK ("party"."party_legacy_ico_authority_fences"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_legacy_ico_authority_fences_tenant_update" ON "party"."party_legacy_ico_authority_fences" AS PERMISSIVE FOR UPDATE TO "party_registry_runtime" USING ("party"."party_legacy_ico_authority_fences"."tenant_id" = (select trust.current_tenant_id())) WITH CHECK ("party"."party_legacy_ico_authority_fences"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_legacy_ico_authority_fences_tenant_delete" ON "party"."party_legacy_ico_authority_fences" AS PERMISSIVE FOR DELETE TO "party_registry_runtime" USING ("party"."party_legacy_ico_authority_fences"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_source_effect_receipts_tenant_select" ON "party"."party_source_effect_receipts" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("party"."party_source_effect_receipts"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_source_effect_receipts_tenant_insert" ON "party"."party_source_effect_receipts" AS PERMISSIVE FOR INSERT TO "party_registry_runtime" WITH CHECK ("party"."party_source_effect_receipts"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_source_effect_receipts_tenant_update" ON "party"."party_source_effect_receipts" AS PERMISSIVE FOR UPDATE TO "party_registry_runtime" USING ("party"."party_source_effect_receipts"."tenant_id" = (select trust.current_tenant_id())) WITH CHECK ("party"."party_source_effect_receipts"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_source_effect_receipts_tenant_delete" ON "party"."party_source_effect_receipts" AS PERMISSIVE FOR DELETE TO "party_registry_runtime" USING ("party"."party_source_effect_receipts"."tenant_id" = (select trust.current_tenant_id()));