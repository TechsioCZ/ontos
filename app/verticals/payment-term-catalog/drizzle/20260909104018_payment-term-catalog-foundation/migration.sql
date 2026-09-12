CREATE SCHEMA "payment_term_catalog";
--> statement-breakpoint
CREATE TABLE "payment_term_catalog"."payment_term_aliases" (
	"payment_term_alias_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"alias_payment_term_id" uuid NOT NULL,
	"canonical_payment_term_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_aliases_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_term_alias_id"),
	CONSTRAINT "payment_term_catalog_aliases_alias_uk" UNIQUE("tenant_id","legal_entity_id","alias_payment_term_id"),
	CONSTRAINT "payment_term_catalog_aliases_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "payment_term_catalog_aliases_not_self_ck" CHECK ("alias_payment_term_id" <> "canonical_payment_term_id"),
	CONSTRAINT "payment_term_catalog_aliases_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_term_catalog"."payment_term_lifecycle_events" (
	"payment_term_lifecycle_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"payment_term_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_lifecycle_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_term_lifecycle_event_id"),
	CONSTRAINT "payment_term_catalog_lifecycle_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "payment_term_catalog_lifecycle_kind_ck" CHECK ("event_kind" in ('ACTIVATED', 'RETIRED')),
	CONSTRAINT "payment_term_catalog_lifecycle_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_lifecycle_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_term_catalog"."payment_term_revisions" (
	"payment_term_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"payment_term_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"change_kind" text NOT NULL,
	"display_name" text NOT NULL,
	"explanation" text NOT NULL,
	"semantic_kind" text NOT NULL,
	"net_days" integer,
	"due_date_anchor" text,
	"calendar_rule" text NOT NULL,
	"calculation_rule_version" integer DEFAULT 1 NOT NULL,
	"compatibility_key" text NOT NULL,
	"semantic_fingerprint" text NOT NULL,
	"change_reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_term_revision_id"),
	CONSTRAINT "payment_term_catalog_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","payment_term_id","revision_number"),
	CONSTRAINT "payment_term_catalog_revisions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "payment_term_catalog_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "payment_term_catalog_revisions_change_kind_ck" CHECK ("change_kind" in ('CREATED', 'COSMETIC_CORRECTION')),
	CONSTRAINT "payment_term_catalog_revisions_display_ck" CHECK ("display_name" = btrim("display_name") and length("display_name") between 1 and 160 and "explanation" = btrim("explanation") and length("explanation") between 1 and 2000),
	CONSTRAINT "payment_term_catalog_revisions_semantic_kind_ck" CHECK ("semantic_kind" in ('IMMEDIATE', 'NET_DAYS')),
	CONSTRAINT "payment_term_catalog_revisions_semantics_ck" CHECK (("semantic_kind" = 'IMMEDIATE' and "net_days" is null and "due_date_anchor" is null and "calendar_rule" = 'NOT_APPLICABLE') or ("semantic_kind" = 'NET_DAYS' and "net_days" between 0 and 3650 and "due_date_anchor" = 'INVOICE_ISSUED_AT' and "calendar_rule" = 'CALENDAR_DAYS_UTC')),
	CONSTRAINT "payment_term_catalog_revisions_calculation_version_ck" CHECK ("calculation_rule_version" = 1),
	CONSTRAINT "payment_term_catalog_revisions_compatibility_ck" CHECK ("compatibility_key" ~ '^[a-z][a-z0-9._-]{0,99}$'),
	CONSTRAINT "payment_term_catalog_revisions_fingerprint_ck" CHECK ("semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_term_catalog_revisions_reason_ck" CHECK ("change_reason" = btrim("change_reason") and length("change_reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_term_catalog"."payment_terms" (
	"payment_term_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"business_code" text NOT NULL,
	"lifecycle_state" text DEFAULT 'ACTIVE' NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"retired_effective_at" timestamp with time zone,
	"retirement_reason" text,
	"retired_by_action_invocation_id" uuid,
	"retired_by_principal_id" uuid,
	"creation_reason" text NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_terms_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_term_id"),
	CONSTRAINT "payment_term_catalog_terms_scope_code_uk" UNIQUE("tenant_id","legal_entity_id","business_code"),
	CONSTRAINT "payment_term_catalog_terms_code_ck" CHECK ("business_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "payment_term_catalog_terms_creation_reason_ck" CHECK ("creation_reason" = btrim("creation_reason") and length("creation_reason") between 1 and 1000),
	CONSTRAINT "payment_term_catalog_terms_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "payment_term_catalog_terms_effective_period_ck" CHECK ("retired_effective_at" is null or "retired_effective_at" >= "active_from"),
	CONSTRAINT "payment_term_catalog_terms_retirement_ck" CHECK (("lifecycle_state" = 'ACTIVE' and "retired_effective_at" is null and "retirement_reason" is null and "retired_by_action_invocation_id" is null and "retired_by_principal_id" is null) or ("lifecycle_state" = 'RETIRED' and "retired_effective_at" is not null and "retirement_reason" = btrim("retirement_reason") and length("retirement_reason") between 1 and 500 and "retired_by_action_invocation_id" is not null and "retired_by_principal_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_term_catalog_aliases_pair_uk" ON "payment_term_catalog"."payment_term_aliases" ("tenant_id","legal_entity_id","alias_payment_term_id","canonical_payment_term_id");--> statement-breakpoint
CREATE INDEX "payment_term_catalog_lifecycle_history_idx" ON "payment_term_catalog"."payment_term_lifecycle_events" ("tenant_id","legal_entity_id","payment_term_id","effective_at");--> statement-breakpoint
CREATE INDEX "payment_term_catalog_revisions_history_idx" ON "payment_term_catalog"."payment_term_revisions" ("tenant_id","legal_entity_id","payment_term_id","revision_number");--> statement-breakpoint
CREATE INDEX "payment_term_catalog_revisions_semantics_idx" ON "payment_term_catalog"."payment_term_revisions" ("tenant_id","legal_entity_id","semantic_fingerprint");--> statement-breakpoint
CREATE INDEX "payment_term_catalog_terms_current_idx" ON "payment_term_catalog"."payment_terms" ("tenant_id","legal_entity_id","lifecycle_state");--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_aliases" ADD CONSTRAINT "payment_term_catalog_aliases_alias_fk" FOREIGN KEY ("tenant_id","legal_entity_id","alias_payment_term_id") REFERENCES "payment_term_catalog"."payment_terms"("tenant_id","legal_entity_id","payment_term_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_aliases" ADD CONSTRAINT "payment_term_catalog_aliases_canonical_fk" FOREIGN KEY ("tenant_id","legal_entity_id","canonical_payment_term_id") REFERENCES "payment_term_catalog"."payment_terms"("tenant_id","legal_entity_id","payment_term_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_lifecycle_events" ADD CONSTRAINT "payment_term_catalog_lifecycle_term_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_term_id") REFERENCES "payment_term_catalog"."payment_terms"("tenant_id","legal_entity_id","payment_term_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_revisions" ADD CONSTRAINT "payment_term_catalog_revisions_term_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_term_id") REFERENCES "payment_term_catalog"."payment_terms"("tenant_id","legal_entity_id","payment_term_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "payment_term_catalog_aliases_scope_select" ON "payment_term_catalog"."payment_term_aliases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_aliases_scope_insert" ON "payment_term_catalog"."payment_term_aliases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_aliases_scope_update" ON "payment_term_catalog"."payment_term_aliases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_aliases_scope_delete" ON "payment_term_catalog"."payment_term_aliases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_lifecycle_scope_select" ON "payment_term_catalog"."payment_term_lifecycle_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_lifecycle_scope_insert" ON "payment_term_catalog"."payment_term_lifecycle_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_lifecycle_scope_update" ON "payment_term_catalog"."payment_term_lifecycle_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_lifecycle_scope_delete" ON "payment_term_catalog"."payment_term_lifecycle_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_revisions_scope_select" ON "payment_term_catalog"."payment_term_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_revisions_scope_insert" ON "payment_term_catalog"."payment_term_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_revisions_scope_update" ON "payment_term_catalog"."payment_term_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_revisions_scope_delete" ON "payment_term_catalog"."payment_term_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_terms_scope_select" ON "payment_term_catalog"."payment_terms" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_terms"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_terms"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_terms_scope_insert" ON "payment_term_catalog"."payment_terms" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_terms"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_terms"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_terms_scope_update" ON "payment_term_catalog"."payment_terms" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_terms"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_terms"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_terms"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_terms"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_terms_scope_delete" ON "payment_term_catalog"."payment_terms" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_terms"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_terms"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);