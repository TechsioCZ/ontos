CREATE TABLE "pricing"."quantity_tier_revisions" (
	"quantity_tier_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"resulting_amount" numeric(38,9) NOT NULL,
	"currency_code" text NOT NULL,
	"previous_revision_id" uuid,
	"corrected_revision_id" uuid,
	"transition_kind" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_quantity_tier_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_revision_id"),
	CONSTRAINT "pricing_quantity_tier_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","quantity_tier_id","revision_number"),
	CONSTRAINT "pricing_quantity_tier_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_quantity_tier_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "pricing_quantity_tier_revisions_amount_ck" CHECK ("resulting_amount" >= 0),
	CONSTRAINT "pricing_quantity_tier_revisions_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_quantity_tier_revisions_lineage_ck" CHECK (("transition_kind" = 'INITIAL' and "previous_revision_id" is null and "corrected_revision_id" is null) or ("transition_kind" in ('VALUE_ONLY_CURRENT', 'SCHEDULED', 'RETIREMENT') and "previous_revision_id" is not null and "corrected_revision_id" is null) or ("transition_kind" = 'CORRECTION' and "previous_revision_id" is not null and "corrected_revision_id" is not null)),
	CONSTRAINT "pricing_quantity_tier_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tier_schedule_acknowledgements" (
	"quantity_tier_schedule_acknowledgement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"issued_by_principal_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_quantity_tier_schedule_acknowledgements_fingerprint_uk" UNIQUE("tenant_id","fingerprint"),
	CONSTRAINT "pricing_quantity_tier_schedule_acknowledgements_fingerprint_ck" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_quantity_tier_schedule_acknowledgements_payload_ck" CHECK (jsonb_typeof("acknowledgement") = 'object' and "acknowledgement"->>'fingerprint' = "fingerprint")
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tier_schedule_entries" (
	"quantity_tier_schedule_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_id" uuid NOT NULL,
	"quantity_tier_revision_id" uuid NOT NULL,
	"quantity_tier_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	CONSTRAINT "pricing_quantity_tier_schedule_entries_revision_uk" UNIQUE("tenant_id","legal_entity_id","quantity_tier_id","quantity_tier_schedule_revision_id","quantity_tier_revision_id"),
	CONSTRAINT "pricing_quantity_tier_schedule_entries_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tier_schedule_heads" (
	"quantity_tier_schedule_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_id" uuid NOT NULL,
	"quantity_tier_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	CONSTRAINT "pricing_quantity_tier_schedule_heads_tier_uk" UNIQUE("tenant_id","legal_entity_id","quantity_tier_id"),
	CONSTRAINT "pricing_quantity_tier_schedule_heads_revision_ck" CHECK ("schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tier_schedule_revisions" (
	"quantity_tier_schedule_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity_tier_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"previous_schedule_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_quantity_tier_schedule_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id"),
	CONSTRAINT "pricing_quantity_tier_schedule_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","quantity_tier_id","schedule_revision"),
	CONSTRAINT "pricing_quantity_tier_schedule_revisions_entry_fk_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id","schedule_revision"),
	CONSTRAINT "pricing_quantity_tier_schedule_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_quantity_tier_schedule_revisions_number_ck" CHECK ("schedule_revision" > 0),
	CONSTRAINT "pricing_quantity_tier_schedule_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."quantity_tiers" (
	"quantity_tier_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"threshold_quantity" numeric(38,9) NOT NULL,
	"catalog_quantity_basis" jsonb NOT NULL,
	"price_currency_code" text NOT NULL,
	"price_basis_quantity" numeric(38,9) NOT NULL,
	"price_unit_ref" jsonb NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_quantity_tiers_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_id"),
	CONSTRAINT "pricing_quantity_tiers_identity_uk" UNIQUE("tenant_id","legal_entity_id","price_id","threshold_quantity","catalog_quantity_basis","price_basis_quantity","price_unit_ref"),
	CONSTRAINT "pricing_quantity_tiers_scope_currency_uk" UNIQUE("tenant_id","legal_entity_id","price_id","quantity_tier_id","price_currency_code"),
	CONSTRAINT "pricing_quantity_tiers_invocation_uk" UNIQUE("tenant_id","created_by_action_invocation_id"),
	CONSTRAINT "pricing_quantity_tiers_threshold_ck" CHECK ("threshold_quantity" > 0),
	CONSTRAINT "pricing_quantity_tiers_currency_ck" CHECK ("price_currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_quantity_tiers_price_basis_quantity_ck" CHECK ("price_basis_quantity" > 0),
	CONSTRAINT "pricing_quantity_tiers_catalog_basis_ck" CHECK (jsonb_typeof("catalog_quantity_basis") = 'object' and jsonb_typeof("catalog_quantity_basis"->'targetRef') = 'object' and jsonb_typeof("catalog_quantity_basis"->'unitRef') = 'object' and ("catalog_quantity_basis"->>'targetDivisibilityRevision')::numeric > 0 and ("catalog_quantity_basis"->>'unitRuleRevision')::numeric > 0 and "catalog_quantity_basis"->'unitRef' = "price_unit_ref"),
	CONSTRAINT "pricing_quantity_tiers_price_unit_ck" CHECK (jsonb_typeof("price_unit_ref") = 'object' and "price_unit_ref"->>'resourceType' = 'commerce.catalog.product-unit')
);
--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."prices" ADD CONSTRAINT "pricing_prices_tier_basis_uk" UNIQUE("tenant_id","legal_entity_id","price_id","currency_code","basis_quantity","unit_ref");--> statement-breakpoint
CREATE INDEX "pricing_quantity_tier_schedule_entries_at_idx" ON "pricing"."quantity_tier_schedule_entries" ("tenant_id","legal_entity_id","quantity_tier_id","schedule_revision","effective_from","effective_to");--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_revisions" ADD CONSTRAINT "pricing_quantity_tier_revisions_tier_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id") REFERENCES "pricing"."quantity_tiers"("tenant_id","legal_entity_id","price_id","quantity_tier_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_revisions" ADD CONSTRAINT "pricing_quantity_tier_revisions_currency_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","currency_code") REFERENCES "pricing"."quantity_tiers"("tenant_id","legal_entity_id","price_id","quantity_tier_id","price_currency_code") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_revisions" ADD CONSTRAINT "pricing_quantity_tier_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","previous_revision_id") REFERENCES "pricing"."quantity_tier_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_revisions" ADD CONSTRAINT "pricing_quantity_tier_revisions_corrected_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","corrected_revision_id") REFERENCES "pricing"."quantity_tier_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_acknowledgements" ADD CONSTRAINT "pricing_quantity_tier_schedule_acknowledgements_tier_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id") REFERENCES "pricing"."quantity_tiers"("tenant_id","legal_entity_id","price_id","quantity_tier_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_entries" ADD CONSTRAINT "pricing_quantity_tier_schedule_entries_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_revision_id") REFERENCES "pricing"."quantity_tier_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_entries" ADD CONSTRAINT "pricing_quantity_tier_schedule_entries_schedule_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id","schedule_revision") REFERENCES "pricing"."quantity_tier_schedule_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id","schedule_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_heads" ADD CONSTRAINT "pricing_quantity_tier_schedule_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id","schedule_revision") REFERENCES "pricing"."quantity_tier_schedule_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id","schedule_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_revisions" ADD CONSTRAINT "pricing_quantity_tier_schedule_revisions_tier_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id") REFERENCES "pricing"."quantity_tiers"("tenant_id","legal_entity_id","price_id","quantity_tier_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tier_schedule_revisions" ADD CONSTRAINT "pricing_quantity_tier_schedule_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","quantity_tier_id","previous_schedule_revision_id") REFERENCES "pricing"."quantity_tier_schedule_revisions"("tenant_id","legal_entity_id","price_id","quantity_tier_id","quantity_tier_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."quantity_tiers" ADD CONSTRAINT "pricing_quantity_tiers_price_basis_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","price_currency_code","price_basis_quantity","price_unit_ref") REFERENCES "pricing"."prices"("tenant_id","legal_entity_id","price_id","currency_code","basis_quantity","unit_ref") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_revisions_scope_select" ON "pricing"."quantity_tier_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_revisions_scope_insert" ON "pricing"."quantity_tier_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_revisions_scope_update" ON "pricing"."quantity_tier_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_revisions_scope_delete" ON "pricing"."quantity_tier_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_acknowledgements_scope_select" ON "pricing"."quantity_tier_schedule_acknowledgements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_acknowledgements_scope_insert" ON "pricing"."quantity_tier_schedule_acknowledgements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_acknowledgements_scope_update" ON "pricing"."quantity_tier_schedule_acknowledgements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_acknowledgements_scope_delete" ON "pricing"."quantity_tier_schedule_acknowledgements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_entries_scope_select" ON "pricing"."quantity_tier_schedule_entries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_entries_scope_insert" ON "pricing"."quantity_tier_schedule_entries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_entries_scope_update" ON "pricing"."quantity_tier_schedule_entries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_entries_scope_delete" ON "pricing"."quantity_tier_schedule_entries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_heads_scope_select" ON "pricing"."quantity_tier_schedule_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_heads_scope_insert" ON "pricing"."quantity_tier_schedule_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_heads_scope_update" ON "pricing"."quantity_tier_schedule_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."quantity_tier_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."quantity_tier_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_heads_scope_delete" ON "pricing"."quantity_tier_schedule_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."quantity_tier_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_revisions_scope_select" ON "pricing"."quantity_tier_schedule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tier_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_revisions_scope_insert" ON "pricing"."quantity_tier_schedule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tier_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tier_schedule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_revisions_scope_update" ON "pricing"."quantity_tier_schedule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tier_schedule_revisions_scope_delete" ON "pricing"."quantity_tier_schedule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tiers_scope_select" ON "pricing"."quantity_tiers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."quantity_tiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tiers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tiers_scope_insert" ON "pricing"."quantity_tiers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."quantity_tiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."quantity_tiers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tiers_scope_update" ON "pricing"."quantity_tiers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_quantity_tiers_scope_delete" ON "pricing"."quantity_tiers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
