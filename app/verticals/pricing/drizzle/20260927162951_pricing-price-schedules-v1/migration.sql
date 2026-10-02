CREATE TABLE "pricing"."price_schedule_acknowledgements" (
	"price_schedule_acknowledgement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"issued_by_principal_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_schedule_acknowledgements_fingerprint_uk" UNIQUE("tenant_id","fingerprint"),
	CONSTRAINT "pricing_price_schedule_acknowledgements_fingerprint_ck" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_price_schedule_acknowledgements_payload_ck" CHECK (jsonb_typeof("acknowledgement") = 'object' and "acknowledgement"->>'fingerprint' = "fingerprint")
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_schedule_entries" (
	"price_schedule_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"price_revision_id" uuid NOT NULL,
	"price_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	CONSTRAINT "pricing_price_schedule_entries_revision_uk" UNIQUE("tenant_id","legal_entity_id","price_id","price_schedule_revision_id","price_revision_id"),
	CONSTRAINT "pricing_price_schedule_entries_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_schedule_heads" (
	"price_schedule_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"price_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	CONSTRAINT "pricing_price_schedule_heads_scope_price_uk" UNIQUE("tenant_id","legal_entity_id","price_id"),
	CONSTRAINT "pricing_price_schedule_heads_revision_ck" CHECK ("schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_schedule_revisions" (
	"price_schedule_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"previous_schedule_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_schedule_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","price_schedule_revision_id"),
	CONSTRAINT "pricing_price_schedule_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","price_id","schedule_revision"),
	CONSTRAINT "pricing_price_schedule_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_price_schedule_revisions_number_ck" CHECK ("schedule_revision" > 0),
	CONSTRAINT "pricing_price_schedule_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD COLUMN "effective_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD COLUMN "previous_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD COLUMN "corrected_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD COLUMN "transition_kind" text DEFAULT 'INITIAL' NOT NULL;--> statement-breakpoint
CREATE INDEX "pricing_price_schedule_entries_at_idx" ON "pricing"."price_schedule_entries" ("tenant_id","legal_entity_id","price_id","schedule_revision","effective_from","effective_to");--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_acknowledgements" ADD CONSTRAINT "pricing_price_schedule_acknowledgements_price_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id") REFERENCES "pricing"."prices"("tenant_id","legal_entity_id","price_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_entries" ADD CONSTRAINT "pricing_price_schedule_entries_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","price_revision_id") REFERENCES "pricing"."price_revisions"("tenant_id","legal_entity_id","price_id","price_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_entries" ADD CONSTRAINT "pricing_price_schedule_entries_schedule_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","price_schedule_revision_id") REFERENCES "pricing"."price_schedule_revisions"("tenant_id","legal_entity_id","price_id","price_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_schedule_heads" ADD CONSTRAINT "pricing_price_schedule_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","price_schedule_revision_id") REFERENCES "pricing"."price_schedule_revisions"("tenant_id","legal_entity_id","price_id","price_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD CONSTRAINT "pricing_price_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from");--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD CONSTRAINT "pricing_price_revisions_lineage_ck" CHECK (("transition_kind" = 'INITIAL' and "previous_revision_id" is null and "corrected_revision_id" is null) or ("transition_kind" in ('VALUE_ONLY_CURRENT', 'SCHEDULED', 'RETIREMENT') and "previous_revision_id" is not null and "corrected_revision_id" is null) or ("transition_kind" = 'CORRECTION' and "previous_revision_id" is not null and "corrected_revision_id" is not null));--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_acknowledgements_scope_select" ON "pricing"."price_schedule_acknowledgements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_acknowledgements_scope_insert" ON "pricing"."price_schedule_acknowledgements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_acknowledgements_scope_update" ON "pricing"."price_schedule_acknowledgements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_acknowledgements_scope_delete" ON "pricing"."price_schedule_acknowledgements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_entries_scope_select" ON "pricing"."price_schedule_entries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_entries_scope_insert" ON "pricing"."price_schedule_entries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_entries_scope_update" ON "pricing"."price_schedule_entries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_entries_scope_delete" ON "pricing"."price_schedule_entries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_heads_scope_select" ON "pricing"."price_schedule_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_heads_scope_insert" ON "pricing"."price_schedule_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_heads_scope_update" ON "pricing"."price_schedule_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."price_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."price_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_heads_scope_delete" ON "pricing"."price_schedule_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."price_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_revisions_scope_select" ON "pricing"."price_schedule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_revisions_scope_insert" ON "pricing"."price_schedule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_schedule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_revisions_scope_update" ON "pricing"."price_schedule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_schedule_revisions_scope_delete" ON "pricing"."price_schedule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
ALTER POLICY "pricing_price_current_scope_insert" ON "pricing"."price_current_revisions" TO "ontos_runtime" WITH CHECK (false);--> statement-breakpoint
ALTER POLICY "pricing_price_current_scope_update" ON "pricing"."price_current_revisions" TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER POLICY "pricing_price_current_scope_delete" ON "pricing"."price_current_revisions" TO "ontos_runtime" USING (false);