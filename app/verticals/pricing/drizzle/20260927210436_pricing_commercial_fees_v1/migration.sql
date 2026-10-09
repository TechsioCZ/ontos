CREATE TABLE "pricing"."fee_revisions" (
	"fee_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"amount" numeric(38,9) NOT NULL,
	"currency_code" text NOT NULL,
	"previous_revision_id" uuid,
	"corrected_revision_id" uuid,
	"transition_kind" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fee_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","fee_revision_id"),
	CONSTRAINT "pricing_fee_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","revision_number"),
	CONSTRAINT "pricing_fee_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_fee_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "pricing_fee_revisions_amount_ck" CHECK ("amount" >= 0),
	CONSTRAINT "pricing_fee_revisions_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_fee_revisions_lineage_ck" CHECK (("transition_kind" = 'INITIAL' and "previous_revision_id" is null and "corrected_revision_id" is null) or ("transition_kind" in ('VALUE_ONLY_CURRENT', 'SCHEDULED', 'RETIREMENT') and "previous_revision_id" is not null and "corrected_revision_id" is null) or ("transition_kind" = 'CORRECTION' and "previous_revision_id" is not null and "corrected_revision_id" is not null)),
	CONSTRAINT "pricing_fee_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fee_schedule_acknowledgements" (
	"fee_schedule_acknowledgement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"issued_by_principal_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fee_schedule_acknowledgements_fingerprint_uk" UNIQUE("tenant_id","fingerprint"),
	CONSTRAINT "pricing_fee_schedule_acknowledgements_fingerprint_ck" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_fee_schedule_acknowledgements_payload_ck" CHECK (jsonb_typeof("acknowledgement") = 'object' and "acknowledgement"->>'fingerprint' = "fingerprint")
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fee_schedule_entries" (
	"fee_schedule_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"fee_revision_id" uuid NOT NULL,
	"fee_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	CONSTRAINT "pricing_fee_schedule_entries_revision_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id","fee_revision_id"),
	CONSTRAINT "pricing_fee_schedule_entries_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fee_schedule_heads" (
	"fee_schedule_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"fee_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	CONSTRAINT "pricing_fee_schedule_heads_fee_uk" UNIQUE("tenant_id","legal_entity_id","fee_id"),
	CONSTRAINT "pricing_fee_schedule_heads_revision_ck" CHECK ("schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fee_schedule_revisions" (
	"fee_schedule_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"previous_schedule_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fee_schedule_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id"),
	CONSTRAINT "pricing_fee_schedule_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","schedule_revision"),
	CONSTRAINT "pricing_fee_schedule_revisions_entry_fk_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id","schedule_revision"),
	CONSTRAINT "pricing_fee_schedule_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_fee_schedule_revisions_number_ck" CHECK ("schedule_revision" > 0),
	CONSTRAINT "pricing_fee_schedule_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fees" (
	"fee_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"family" text NOT NULL,
	"product_ref" jsonb NOT NULL,
	"variant_ref" jsonb NOT NULL,
	"channel_id" text NOT NULL,
	"market_id" text NOT NULL,
	"calculation_basis" text NOT NULL,
	"basis_quantity" numeric(38,9),
	"unit_ref" jsonb,
	"currency_code" text NOT NULL,
	"monetary_boundary" text NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fees_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","fee_id"),
	CONSTRAINT "pricing_fees_scope_currency_uk" UNIQUE("tenant_id","legal_entity_id","fee_id","currency_code"),
	CONSTRAINT "pricing_fees_identity_uk" UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","family","product_ref","variant_ref","channel_id","market_id","calculation_basis","basis_quantity","unit_ref","currency_code","monetary_boundary"),
	CONSTRAINT "pricing_fees_invocation_uk" UNIQUE("tenant_id","created_by_action_invocation_id"),
	CONSTRAINT "pricing_fees_family_ck" CHECK ("family" in ('RECYCLING_FEE', 'COPYRIGHT_FEE')),
	CONSTRAINT "pricing_fees_variant_ck" CHECK (jsonb_typeof("product_ref") = 'object' and "product_ref"->>'moduleId' = 'commerce.catalog' and "product_ref"->>'resourceType' = 'commerce.catalog.product' and "product_ref"->>'tenantId' = "tenant_id"::text and jsonb_typeof("variant_ref") = 'object' and "variant_ref"->>'moduleId' = 'commerce.catalog' and "variant_ref"->>'resourceType' = 'commerce.catalog.variant' and "variant_ref"->>'tenantId' = "tenant_id"::text),
	CONSTRAINT "pricing_fees_scope_ck" CHECK ("channel_id" = btrim("channel_id") and length("channel_id") between 1 and 100 and "market_id" = btrim("market_id") and length("market_id") between 1 and 200),
	CONSTRAINT "pricing_fees_basis_ck" CHECK (("calculation_basis" = 'FIXED_PER_LINE' and "basis_quantity" is null and "unit_ref" is null) or ("calculation_basis" = 'FIXED_PER_UNIT' and "basis_quantity" > 0 and jsonb_typeof("unit_ref") = 'object' and "unit_ref"->>'moduleId' = 'commerce.catalog' and "unit_ref"->>'resourceType' = 'commerce.catalog.product-unit' and "unit_ref"->>'tenantId' = "tenant_id"::text)),
	CONSTRAINT "pricing_fees_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_fees_boundary_ck" CHECK ("monetary_boundary" = 'PRE_TAX')
);
--> statement-breakpoint
ALTER TABLE "pricing"."fees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_fee_schedule_entries_at_idx" ON "pricing"."fee_schedule_entries" ("tenant_id","legal_entity_id","fee_id","schedule_revision","effective_from","effective_to");--> statement-breakpoint
ALTER TABLE "pricing"."fee_revisions" ADD CONSTRAINT "pricing_fee_revisions_fee_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id") REFERENCES "pricing"."fees"("tenant_id","legal_entity_id","fee_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_revisions" ADD CONSTRAINT "pricing_fee_revisions_currency_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","currency_code") REFERENCES "pricing"."fees"("tenant_id","legal_entity_id","fee_id","currency_code") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_revisions" ADD CONSTRAINT "pricing_fee_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","previous_revision_id") REFERENCES "pricing"."fee_revisions"("tenant_id","legal_entity_id","fee_id","fee_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_revisions" ADD CONSTRAINT "pricing_fee_revisions_corrected_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","corrected_revision_id") REFERENCES "pricing"."fee_revisions"("tenant_id","legal_entity_id","fee_id","fee_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_acknowledgements" ADD CONSTRAINT "pricing_fee_schedule_acknowledgements_fee_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id") REFERENCES "pricing"."fees"("tenant_id","legal_entity_id","fee_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_entries" ADD CONSTRAINT "pricing_fee_schedule_entries_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","fee_revision_id") REFERENCES "pricing"."fee_revisions"("tenant_id","legal_entity_id","fee_id","fee_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_entries" ADD CONSTRAINT "pricing_fee_schedule_entries_schedule_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id","schedule_revision") REFERENCES "pricing"."fee_schedule_revisions"("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id","schedule_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_heads" ADD CONSTRAINT "pricing_fee_schedule_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id","schedule_revision") REFERENCES "pricing"."fee_schedule_revisions"("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id","schedule_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_revisions" ADD CONSTRAINT "pricing_fee_schedule_revisions_fee_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id") REFERENCES "pricing"."fees"("tenant_id","legal_entity_id","fee_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_schedule_revisions" ADD CONSTRAINT "pricing_fee_schedule_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id","previous_schedule_revision_id") REFERENCES "pricing"."fee_schedule_revisions"("tenant_id","legal_entity_id","fee_id","fee_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_fee_revisions_scope_select" ON "pricing"."fee_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_revisions_scope_insert" ON "pricing"."fee_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_revisions_scope_update" ON "pricing"."fee_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_revisions_scope_delete" ON "pricing"."fee_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_acknowledgements_scope_select" ON "pricing"."fee_schedule_acknowledgements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_acknowledgements_scope_insert" ON "pricing"."fee_schedule_acknowledgements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_acknowledgements_scope_update" ON "pricing"."fee_schedule_acknowledgements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_acknowledgements_scope_delete" ON "pricing"."fee_schedule_acknowledgements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_entries_scope_select" ON "pricing"."fee_schedule_entries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_entries_scope_insert" ON "pricing"."fee_schedule_entries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_entries_scope_update" ON "pricing"."fee_schedule_entries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_entries_scope_delete" ON "pricing"."fee_schedule_entries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_heads_scope_select" ON "pricing"."fee_schedule_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_heads_scope_insert" ON "pricing"."fee_schedule_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_heads_scope_update" ON "pricing"."fee_schedule_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."fee_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."fee_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_heads_scope_delete" ON "pricing"."fee_schedule_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."fee_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_revisions_scope_select" ON "pricing"."fee_schedule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_revisions_scope_insert" ON "pricing"."fee_schedule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_schedule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_revisions_scope_update" ON "pricing"."fee_schedule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_schedule_revisions_scope_delete" ON "pricing"."fee_schedule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_fees_scope_select" ON "pricing"."fees" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fees"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fees"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fees_scope_insert" ON "pricing"."fees" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fees"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fees"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fees_scope_update" ON "pricing"."fees" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fees_scope_delete" ON "pricing"."fees" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);