CREATE TABLE "pricing"."currency_support_roots" (
	"currency_support_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL CONSTRAINT "pricing_currency_support_roots_tenant_uk" UNIQUE,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_currency_support_roots_scope_id_uk" UNIQUE("tenant_id","currency_support_id"),
	CONSTRAINT "pricing_currency_support_roots_invocation_uk" UNIQUE("tenant_id","created_by_action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."currency_support_schedule_entries" (
	"currency_support_schedule_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"currency_support_id" uuid NOT NULL,
	"currency_support_revision_id" uuid NOT NULL,
	"currency_support_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	CONSTRAINT "pricing_currency_support_entries_revision_uk" UNIQUE("tenant_id","currency_support_id","currency_support_schedule_revision_id","currency_support_revision_id"),
	CONSTRAINT "pricing_currency_support_entries_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."currency_support_schedule_heads" (
	"currency_support_schedule_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL CONSTRAINT "pricing_currency_support_heads_tenant_uk" UNIQUE,
	"currency_support_id" uuid NOT NULL,
	"currency_support_schedule_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	CONSTRAINT "pricing_currency_support_heads_root_uk" UNIQUE("tenant_id","currency_support_id"),
	CONSTRAINT "pricing_currency_support_heads_revision_ck" CHECK ("schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."currency_support_schedule_revisions" (
	"currency_support_schedule_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"currency_support_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"previous_schedule_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"schedule_acknowledgement" jsonb,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_currency_support_schedule_scope_id_uk" UNIQUE("tenant_id","currency_support_id","currency_support_schedule_revision_id"),
	CONSTRAINT "pricing_currency_support_schedule_number_uk" UNIQUE("tenant_id","currency_support_id","schedule_revision"),
	CONSTRAINT "pricing_currency_support_schedule_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_currency_support_schedule_number_ck" CHECK ("schedule_revision" > 0),
	CONSTRAINT "pricing_currency_support_schedule_acknowledgement_ck" CHECK ("schedule_acknowledgement" is null or jsonb_typeof("schedule_acknowledgement") = 'object'),
	CONSTRAINT "pricing_currency_support_schedule_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."currency_support_value_revisions" (
	"currency_support_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"currency_support_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"pricing_revision" text NOT NULL,
	"supported_currencies" jsonb NOT NULL,
	"previous_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_currency_support_value_scope_id_uk" UNIQUE("tenant_id","currency_support_id","currency_support_revision_id"),
	CONSTRAINT "pricing_currency_support_value_generation_uk" UNIQUE("tenant_id","currency_support_id","generation"),
	CONSTRAINT "pricing_currency_support_value_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_currency_support_value_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "pricing_currency_support_value_revision_ck" CHECK ("pricing_revision" ~ '^pricing-currency-support:[1-9][0-9]*$'),
	CONSTRAINT "pricing_currency_support_value_currencies_ck" CHECK (jsonb_typeof("supported_currencies") = 'array' and jsonb_array_length("supported_currencies") > 0),
	CONSTRAINT "pricing_currency_support_value_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_value_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_currency_support_entries_at_idx" ON "pricing"."currency_support_schedule_entries" ("tenant_id","currency_support_id","schedule_revision","effective_from","effective_to");--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_entries" ADD CONSTRAINT "pricing_currency_support_entries_value_fk" FOREIGN KEY ("tenant_id","currency_support_id","currency_support_revision_id") REFERENCES "pricing"."currency_support_value_revisions"("tenant_id","currency_support_id","currency_support_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_entries" ADD CONSTRAINT "pricing_currency_support_entries_schedule_fk" FOREIGN KEY ("tenant_id","currency_support_id","currency_support_schedule_revision_id") REFERENCES "pricing"."currency_support_schedule_revisions"("tenant_id","currency_support_id","currency_support_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_heads" ADD CONSTRAINT "pricing_currency_support_heads_revision_fk" FOREIGN KEY ("tenant_id","currency_support_id","currency_support_schedule_revision_id") REFERENCES "pricing"."currency_support_schedule_revisions"("tenant_id","currency_support_id","currency_support_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_schedule_revisions" ADD CONSTRAINT "pricing_currency_support_schedule_root_fk" FOREIGN KEY ("tenant_id","currency_support_id") REFERENCES "pricing"."currency_support_roots"("tenant_id","currency_support_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_value_revisions" ADD CONSTRAINT "pricing_currency_support_value_root_fk" FOREIGN KEY ("tenant_id","currency_support_id") REFERENCES "pricing"."currency_support_roots"("tenant_id","currency_support_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_currency_support_roots_tenant_select" ON "pricing"."currency_support_roots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."currency_support_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_roots_tenant_insert" ON "pricing"."currency_support_roots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."currency_support_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_roots_tenant_update" ON "pricing"."currency_support_roots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_roots_tenant_delete" ON "pricing"."currency_support_roots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_entries_tenant_select" ON "pricing"."currency_support_schedule_entries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."currency_support_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_entries_tenant_insert" ON "pricing"."currency_support_schedule_entries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."currency_support_schedule_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_entries_tenant_update" ON "pricing"."currency_support_schedule_entries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_entries_tenant_delete" ON "pricing"."currency_support_schedule_entries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_heads_tenant_select" ON "pricing"."currency_support_schedule_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."currency_support_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_heads_tenant_insert" ON "pricing"."currency_support_schedule_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."currency_support_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_heads_tenant_update" ON "pricing"."currency_support_schedule_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."currency_support_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("pricing"."currency_support_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_heads_tenant_delete" ON "pricing"."currency_support_schedule_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."currency_support_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_schedule_tenant_select" ON "pricing"."currency_support_schedule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."currency_support_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_schedule_tenant_insert" ON "pricing"."currency_support_schedule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."currency_support_schedule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_schedule_tenant_update" ON "pricing"."currency_support_schedule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_schedule_tenant_delete" ON "pricing"."currency_support_schedule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_value_tenant_select" ON "pricing"."currency_support_value_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."currency_support_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_value_tenant_insert" ON "pricing"."currency_support_value_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."currency_support_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_value_tenant_update" ON "pricing"."currency_support_value_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_value_tenant_delete" ON "pricing"."currency_support_value_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);