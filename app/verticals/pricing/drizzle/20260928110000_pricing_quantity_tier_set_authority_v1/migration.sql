CREATE TABLE "pricing"."quantity_tier_set_heads" (
	"quantity_tier_set_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_set_root_id" uuid NOT NULL,
	"quantity_tier_set_revision_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	CONSTRAINT "pricing_quantity_tier_set_heads_price_uk" UNIQUE("tenant_id","legal_entity_id","price_id"),
	CONSTRAINT "pricing_quantity_tier_set_heads_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tier_set_revisions" (
	"quantity_tier_set_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_set_root_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"previous_quantity_tier_set_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"mutation_kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_quantity_tier_set_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id","quantity_tier_set_revision_id"),
	CONSTRAINT "pricing_quantity_tier_set_revisions_generation_uk" UNIQUE("tenant_id","legal_entity_id","quantity_tier_set_root_id","generation"),
	CONSTRAINT "pricing_quantity_tier_set_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_quantity_tier_set_revisions_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "pricing_quantity_tier_set_revisions_lineage_ck" CHECK (("generation" = 1 and "previous_quantity_tier_set_revision_id" is null and "mutation_kind" = 'PRICE_CREATED') or ("generation" > 1 and "previous_quantity_tier_set_revision_id" is not null and "mutation_kind" in ('TIER_DEFINED', 'TIER_REVISED')))
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tier_set_roots" (
	"quantity_tier_set_root_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_quantity_tier_set_roots_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id"),
	CONSTRAINT "pricing_quantity_tier_set_roots_price_uk" UNIQUE("tenant_id","legal_entity_id","price_id")
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_heads" ADD CONSTRAINT "pricing_quantity_tier_set_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id","quantity_tier_set_revision_id") REFERENCES "pricing"."quantity_tier_set_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id","quantity_tier_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_revisions" ADD CONSTRAINT "pricing_quantity_tier_set_revisions_root_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id") REFERENCES "pricing"."quantity_tier_set_roots"("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_revisions" ADD CONSTRAINT "pricing_quantity_tier_set_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id","previous_quantity_tier_set_revision_id") REFERENCES "pricing"."quantity_tier_set_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_set_root_id","quantity_tier_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_set_roots" ADD CONSTRAINT "pricing_quantity_tier_set_roots_price_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id") REFERENCES "pricing"."prices"("tenant_id","legal_entity_id","price_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_heads_scope_select" ON "pricing"."quantity_tier_set_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_heads_scope_insert" ON "pricing"."quantity_tier_set_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_heads_scope_update" ON "pricing"."quantity_tier_set_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."quantity_tier_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."quantity_tier_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_heads_scope_delete" ON "pricing"."quantity_tier_set_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."quantity_tier_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_revisions_scope_select" ON "pricing"."quantity_tier_set_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_revisions_scope_insert" ON "pricing"."quantity_tier_set_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_revisions_scope_update" ON "pricing"."quantity_tier_set_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_revisions_scope_delete" ON "pricing"."quantity_tier_set_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_roots_scope_select" ON "pricing"."quantity_tier_set_roots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_roots_scope_insert" ON "pricing"."quantity_tier_set_roots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_roots_scope_update" ON "pricing"."quantity_tier_set_roots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_set_roots_scope_delete" ON "pricing"."quantity_tier_set_roots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);