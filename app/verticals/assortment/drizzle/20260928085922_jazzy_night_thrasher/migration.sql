CREATE TABLE "assortment"."assortment_decision_set_fences" (
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid PRIMARY KEY,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_decision_set_fences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_decision_set_fences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "assortment_decision_set_fences_scope_select" ON "assortment"."assortment_decision_set_fences" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_decision_set_fences_scope_insert" ON "assortment"."assortment_decision_set_fences" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_decision_set_fences_scope_update" ON "assortment"."assortment_decision_set_fences" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_decision_set_fences_scope_delete" ON "assortment"."assortment_decision_set_fences" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
