CREATE SCHEMA "price_group_catalog";
--> statement-breakpoint
CREATE TABLE "price_group_catalog"."price_group_catalog_ledger" (
	"catalog_ledger_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"expected_catalog_revision" bigint NOT NULL,
	"catalog_revision" bigint NOT NULL,
	"operation_kind" text NOT NULL,
	"price_group_id" uuid NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"trusted_effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_ledger_scope_revision_uk" UNIQUE("tenant_id","catalog_revision"),
	CONSTRAINT "price_group_catalog_ledger_scope_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "price_group_catalog_ledger_revision_ck" CHECK ("expected_catalog_revision" >= 0 and "catalog_revision" = "expected_catalog_revision" + 1),
	CONSTRAINT "price_group_catalog_ledger_operation_ck" CHECK ("operation_kind" in ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION', 'RETIRE_PRICE_GROUP')),
	CONSTRAINT "price_group_catalog_ledger_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_catalog_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_group_catalog"."price_group_compatibility_support" (
	"compatibility_support_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"price_group_id" uuid NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	"contract_id" text NOT NULL,
	"contract_version" bigint NOT NULL,
	"declared_at_catalog_revision" bigint NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_compatibility_exact_contract_uk" UNIQUE("tenant_id","price_group_id","definition_revision_id","contract_id","contract_version"),
	CONSTRAINT "price_group_catalog_compatibility_contract_id_ck" CHECK ("contract_id" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' and length("contract_id") between 1 and 160),
	CONSTRAINT "price_group_catalog_compatibility_contract_version_ck" CHECK ("contract_version" > 0),
	CONSTRAINT "price_group_catalog_compatibility_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_compatibility_support" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_group_catalog"."price_group_definition_effective_intervals" (
	"definition_effective_interval_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"price_group_id" uuid NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	"schedule_catalog_revision" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_intervals_scope_id_uk" UNIQUE("tenant_id","price_group_id","definition_effective_interval_id"),
	CONSTRAINT "price_group_catalog_intervals_revision_uk" UNIQUE("tenant_id","price_group_id","schedule_catalog_revision","definition_revision_id"),
	CONSTRAINT "price_group_catalog_intervals_effective_start_uk" UNIQUE("tenant_id","price_group_id","schedule_catalog_revision","effective_from"),
	CONSTRAINT "price_group_catalog_intervals_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "price_group_catalog_intervals_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_effective_intervals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_group_catalog"."price_group_definition_revisions" (
	"definition_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"price_group_id" uuid NOT NULL,
	"revision_number" bigint NOT NULL,
	"previous_definition_revision_id" uuid,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"classification_purpose" text NOT NULL,
	"meaning_fingerprint" text NOT NULL,
	"accepted_catalog_revision" bigint NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_definitions_scope_id_uk" UNIQUE("tenant_id","price_group_id","definition_revision_id"),
	CONSTRAINT "price_group_catalog_definitions_number_uk" UNIQUE("tenant_id","price_group_id","revision_number"),
	CONSTRAINT "price_group_catalog_definitions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "price_group_catalog_definitions_revision_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "price_group_catalog_definitions_predecessor_ck" CHECK (("revision_number" = 1 and "previous_definition_revision_id" is null) or ("revision_number" > 1 and "previous_definition_revision_id" is not null and "previous_definition_revision_id" <> "definition_revision_id")),
	CONSTRAINT "price_group_catalog_definitions_display_ck" CHECK ("display_name" = btrim("display_name") and length("display_name") between 1 and 160 and "description" = btrim("description") and length("description") between 1 and 2000),
	CONSTRAINT "price_group_catalog_definitions_purpose_ck" CHECK ("classification_purpose" = btrim("classification_purpose") and length("classification_purpose") between 1 and 1000),
	CONSTRAINT "price_group_catalog_definitions_fingerprint_ck" CHECK ("meaning_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "price_group_catalog_definitions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_group_catalog"."price_group_retirements" (
	"price_group_retirement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"price_group_id" uuid NOT NULL,
	"current_definition_revision_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"expected_catalog_revision" bigint NOT NULL,
	"accepted_catalog_revision" bigint NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_retirements_group_uk" UNIQUE("tenant_id","price_group_id"),
	CONSTRAINT "price_group_catalog_retirements_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "price_group_catalog_retirements_fence_ck" CHECK ("expected_catalog_revision" > 0 and "accepted_catalog_revision" = "expected_catalog_revision" + 1),
	CONSTRAINT "price_group_catalog_retirements_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_retirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_group_catalog"."price_groups" (
	"price_group_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"business_code" text NOT NULL,
	"meaning_fingerprint" text NOT NULL,
	"classification_purpose" text NOT NULL,
	"lifecycle_state" text DEFAULT 'ACTIVE' NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"retired_effective_at" timestamp with time zone,
	"current_definition_schedule_revision" bigint NOT NULL,
	"created_at_catalog_revision" bigint NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"creation_reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_groups_scope_id_uk" UNIQUE("tenant_id","price_group_id"),
	CONSTRAINT "price_group_catalog_groups_scope_code_uk" UNIQUE("tenant_id","business_code"),
	CONSTRAINT "price_group_catalog_groups_scope_meaning_uk" UNIQUE("tenant_id","price_group_id","meaning_fingerprint","classification_purpose"),
	CONSTRAINT "price_group_catalog_groups_code_ck" CHECK ("business_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "price_group_catalog_groups_fingerprint_ck" CHECK ("meaning_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "price_group_catalog_groups_purpose_ck" CHECK ("classification_purpose" = btrim("classification_purpose") and length("classification_purpose") between 1 and 1000),
	CONSTRAINT "price_group_catalog_groups_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "price_group_catalog_groups_retirement_ck" CHECK (("lifecycle_state" = 'ACTIVE' and "retired_effective_at" is null) or ("lifecycle_state" = 'RETIRED' and "retired_effective_at" is not null and "retired_effective_at" >= "active_from")),
	CONSTRAINT "price_group_catalog_groups_creation_reason_ck" CHECK ("creation_reason" = btrim("creation_reason") and length("creation_reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "price_group_catalog_ledger_group_idx" ON "price_group_catalog"."price_group_catalog_ledger" ("tenant_id","price_group_id","catalog_revision");--> statement-breakpoint
CREATE INDEX "price_group_catalog_compatibility_lookup_idx" ON "price_group_catalog"."price_group_compatibility_support" ("tenant_id","price_group_id","contract_id","contract_version","definition_revision_id");--> statement-breakpoint
CREATE INDEX "price_group_catalog_intervals_current_lookup_idx" ON "price_group_catalog"."price_group_definition_effective_intervals" ("tenant_id","price_group_id","schedule_catalog_revision","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "price_group_catalog_definitions_history_idx" ON "price_group_catalog"."price_group_definition_revisions" ("tenant_id","price_group_id","revision_number");--> statement-breakpoint
CREATE INDEX "price_group_catalog_groups_lifecycle_idx" ON "price_group_catalog"."price_groups" ("tenant_id","lifecycle_state");--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_compatibility_support" ADD CONSTRAINT "price_group_catalog_compatibility_definition_fk" FOREIGN KEY ("tenant_id","price_group_id","definition_revision_id") REFERENCES "price_group_catalog"."price_group_definition_revisions"("tenant_id","price_group_id","definition_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_compatibility_support" ADD CONSTRAINT "price_group_catalog_compatibility_ledger_fk" FOREIGN KEY ("tenant_id","declared_at_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_effective_intervals" ADD CONSTRAINT "price_group_catalog_intervals_definition_fk" FOREIGN KEY ("tenant_id","price_group_id","definition_revision_id") REFERENCES "price_group_catalog"."price_group_definition_revisions"("tenant_id","price_group_id","definition_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_effective_intervals" ADD CONSTRAINT "price_group_catalog_intervals_schedule_ledger_fk" FOREIGN KEY ("tenant_id","schedule_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" ADD CONSTRAINT "price_group_catalog_definitions_stable_meaning_fk" FOREIGN KEY ("tenant_id","price_group_id","meaning_fingerprint","classification_purpose") REFERENCES "price_group_catalog"."price_groups"("tenant_id","price_group_id","meaning_fingerprint","classification_purpose") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" ADD CONSTRAINT "price_group_catalog_definitions_ledger_fk" FOREIGN KEY ("tenant_id","accepted_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_retirements" ADD CONSTRAINT "price_group_catalog_retirements_group_fk" FOREIGN KEY ("tenant_id","price_group_id") REFERENCES "price_group_catalog"."price_groups"("tenant_id","price_group_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_retirements" ADD CONSTRAINT "price_group_catalog_retirements_definition_fk" FOREIGN KEY ("tenant_id","price_group_id","current_definition_revision_id") REFERENCES "price_group_catalog"."price_group_definition_revisions"("tenant_id","price_group_id","definition_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_retirements" ADD CONSTRAINT "price_group_catalog_retirements_expected_ledger_fk" FOREIGN KEY ("tenant_id","expected_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_retirements" ADD CONSTRAINT "price_group_catalog_retirements_ledger_fk" FOREIGN KEY ("tenant_id","accepted_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ADD CONSTRAINT "price_group_catalog_groups_current_schedule_ledger_fk" FOREIGN KEY ("tenant_id","current_definition_schedule_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ADD CONSTRAINT "price_group_catalog_groups_creation_ledger_fk" FOREIGN KEY ("tenant_id","created_at_catalog_revision") REFERENCES "price_group_catalog"."price_group_catalog_ledger"("tenant_id","catalog_revision") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "price_group_catalog_ledger_scope_select" ON "price_group_catalog"."price_group_catalog_ledger" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_catalog_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_ledger_scope_insert" ON "price_group_catalog"."price_group_catalog_ledger" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_catalog_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_ledger_scope_update" ON "price_group_catalog"."price_group_catalog_ledger" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_catalog_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_catalog_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_ledger_scope_delete" ON "price_group_catalog"."price_group_catalog_ledger" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_catalog_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_compatibility_scope_select" ON "price_group_catalog"."price_group_compatibility_support" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_compatibility_support"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_compatibility_scope_insert" ON "price_group_catalog"."price_group_compatibility_support" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_compatibility_support"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_compatibility_scope_update" ON "price_group_catalog"."price_group_compatibility_support" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_compatibility_support"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_compatibility_support"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_compatibility_scope_delete" ON "price_group_catalog"."price_group_compatibility_support" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_compatibility_support"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_intervals_scope_select" ON "price_group_catalog"."price_group_definition_effective_intervals" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_definition_effective_intervals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_intervals_scope_insert" ON "price_group_catalog"."price_group_definition_effective_intervals" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_definition_effective_intervals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_intervals_scope_update" ON "price_group_catalog"."price_group_definition_effective_intervals" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_definition_effective_intervals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_definition_effective_intervals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_intervals_scope_delete" ON "price_group_catalog"."price_group_definition_effective_intervals" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_definition_effective_intervals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_definitions_scope_select" ON "price_group_catalog"."price_group_definition_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_definitions_scope_insert" ON "price_group_catalog"."price_group_definition_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_definitions_scope_update" ON "price_group_catalog"."price_group_definition_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_definitions_scope_delete" ON "price_group_catalog"."price_group_definition_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_retirements_scope_select" ON "price_group_catalog"."price_group_retirements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_group_retirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_retirements_scope_insert" ON "price_group_catalog"."price_group_retirements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_group_retirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_retirements_scope_update" ON "price_group_catalog"."price_group_retirements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_group_retirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_group_retirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_retirements_scope_delete" ON "price_group_catalog"."price_group_retirements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_group_retirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_groups_scope_select" ON "price_group_catalog"."price_groups" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("price_group_catalog"."price_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_groups_scope_insert" ON "price_group_catalog"."price_groups" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("price_group_catalog"."price_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_groups_scope_update" ON "price_group_catalog"."price_groups" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("price_group_catalog"."price_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("price_group_catalog"."price_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "price_group_catalog_groups_scope_delete" ON "price_group_catalog"."price_groups" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("price_group_catalog"."price_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);