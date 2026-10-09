CREATE SCHEMA "privacy";
--> statement-breakpoint
CREATE TABLE "privacy"."anti_resurrection_protections" (
	"protection_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"subject_ref" text NOT NULL,
	"measure" text NOT NULL,
	"protection_record" jsonb NOT NULL,
	"protected_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "privacy_anti_resurrection_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","protection_id")
);
--> statement-breakpoint
ALTER TABLE "privacy"."anti_resurrection_protections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."consent_decisions" (
	"decision_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"scope_ref" text NOT NULL,
	"decision" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"decision_record" jsonb NOT NULL,
	"idempotency_key" text,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_consent_decisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","decision_id"),
	CONSTRAINT "privacy_consent_decisions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_consent_decisions_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "privacy_consent_decisions_kind_ck" CHECK ("decision" in ('GRANTED', 'REFUSED', 'WITHDRAWN'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."consent_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."disposition_decisions" (
	"decision_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"decision_record" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_disposition_decisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","decision_ref")
);
--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_cases" (
	"case_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_status" text NOT NULL,
	"case_record" jsonb NOT NULL,
	"original_received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_cases_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","case_ref")
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_owner_tasks" (
	"task_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"owning_capability" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"task_record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_owner_tasks_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","task_id"),
	CONSTRAINT "privacy_dsr_owner_tasks_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_owner_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."notice_provisions" (
	"provision_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"notice_version_ref" text NOT NULL,
	"privacy_subject_ref" text,
	"anonymous_context_ref" text,
	"outcome" text NOT NULL,
	"provision_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_notice_provisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","provision_id"),
	CONSTRAINT "privacy_notice_provisions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_notice_provisions_subject_ck" CHECK (("privacy_subject_ref" is null) <> ("anonymous_context_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "privacy"."notice_provisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."notice_versions" (
	"notice_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"language" text NOT NULL,
	"content_identity" text NOT NULL,
	"notice_record" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_notice_versions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","notice_version_id"),
	CONSTRAINT "privacy_notice_versions_number_uk" UNIQUE("tenant_id","legal_entity_id","notice_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "privacy"."notice_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."owner_execution_outcomes" (
	"outcome_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"measure_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"outcome_record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_owner_outcomes_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","outcome_id"),
	CONSTRAINT "privacy_owner_outcomes_attempt_uk" UNIQUE("tenant_id","legal_entity_id","measure_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "privacy"."owner_execution_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."privacy_measure_dispatches" (
	"measure_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"handoff_record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_measure_dispatches_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","measure_id"),
	CONSTRAINT "privacy_measure_dispatches_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "privacy"."privacy_measure_dispatches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."privacy_subjects" (
	"privacy_subject_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_subjects_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","privacy_subject_id"),
	CONSTRAINT "privacy_subjects_kind_ck" CHECK ("subject_kind" in ('DATA_SUBJECT', 'ANONYMOUS'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."privacy_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."processing_activities" (
	"processing_activity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"current_lifecycle" text DEFAULT 'PROPOSED' NOT NULL,
	"activity_record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_processing_activities_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","processing_activity_id"),
	CONSTRAINT "privacy_processing_activities_lifecycle_ck" CHECK ("current_lifecycle" in ('PROPOSED', 'EFFECTIVE', 'SUSPENDED', 'ENDED'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."processing_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."processing_activity_lifecycle_events" (
	"lifecycle_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"processing_activity_id" uuid NOT NULL,
	"from_lifecycle" text,
	"to_lifecycle" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"event_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_activity_lifecycle_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","lifecycle_event_id"),
	CONSTRAINT "privacy_activity_lifecycle_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "privacy"."processing_activity_lifecycle_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."processing_purposes" (
	"processing_purpose_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"business_code" text NOT NULL,
	"governance_owner_id" uuid NOT NULL,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"retired_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_processing_purposes_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","processing_purpose_id"),
	CONSTRAINT "privacy_processing_purposes_scope_code_uk" UNIQUE("tenant_id","legal_entity_id","business_code"),
	CONSTRAINT "privacy_processing_purposes_code_ck" CHECK ("business_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "privacy_processing_purposes_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'RETIRED'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."processing_purposes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."purpose_versions" (
	"purpose_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"processing_purpose_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"meaning" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_purpose_versions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","purpose_version_id"),
	CONSTRAINT "privacy_purpose_versions_number_uk" UNIQUE("tenant_id","legal_entity_id","processing_purpose_id","version_number"),
	CONSTRAINT "privacy_purpose_versions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_purpose_versions_number_ck" CHECK ("version_number" > 0),
	CONSTRAINT "privacy_purpose_versions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."purpose_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."retention_evaluation_work" (
	"work_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"idempotency_ref" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"work_record" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_retention_work_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","work_ref"),
	CONSTRAINT "privacy_retention_work_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_ref")
);
--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "privacy_anti_resurrection_subject_idx" ON "privacy"."anti_resurrection_protections" ("tenant_id","legal_entity_id","subject_ref","active");--> statement-breakpoint
CREATE INDEX "privacy_consent_decisions_current_idx" ON "privacy"."consent_decisions" ("tenant_id","legal_entity_id","scope_ref","effective_at","recorded_at");--> statement-breakpoint
CREATE INDEX "privacy_disposition_decisions_outcome_idx" ON "privacy"."disposition_decisions" ("tenant_id","legal_entity_id","outcome");--> statement-breakpoint
CREATE INDEX "privacy_dsr_cases_status_idx" ON "privacy"."dsr_cases" ("tenant_id","legal_entity_id","case_status");--> statement-breakpoint
CREATE INDEX "privacy_dsr_owner_tasks_case_idx" ON "privacy"."dsr_owner_tasks" ("tenant_id","legal_entity_id","case_ref","status");--> statement-breakpoint
CREATE INDEX "privacy_notice_provisions_subject_idx" ON "privacy"."notice_provisions" ("tenant_id","legal_entity_id","privacy_subject_ref");--> statement-breakpoint
CREATE INDEX "privacy_notice_versions_selection_idx" ON "privacy"."notice_versions" ("tenant_id","legal_entity_id","language");--> statement-breakpoint
CREATE INDEX "privacy_subjects_scope_kind_idx" ON "privacy"."privacy_subjects" ("tenant_id","legal_entity_id","subject_kind");--> statement-breakpoint
CREATE INDEX "privacy_processing_activities_lifecycle_idx" ON "privacy"."processing_activities" ("tenant_id","legal_entity_id","current_lifecycle");--> statement-breakpoint
CREATE INDEX "privacy_activity_lifecycle_history_idx" ON "privacy"."processing_activity_lifecycle_events" ("tenant_id","legal_entity_id","processing_activity_id","recorded_at");--> statement-breakpoint
CREATE INDEX "privacy_purpose_versions_history_idx" ON "privacy"."purpose_versions" ("tenant_id","legal_entity_id","processing_purpose_id","version_number");--> statement-breakpoint
CREATE INDEX "privacy_retention_work_due_idx" ON "privacy"."retention_evaluation_work" ("tenant_id","legal_entity_id","status","due_at");--> statement-breakpoint
CREATE POLICY "privacy_anti_resurrection_scope_select" ON "privacy"."anti_resurrection_protections" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."anti_resurrection_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."anti_resurrection_protections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_anti_resurrection_scope_insert" ON "privacy"."anti_resurrection_protections" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."anti_resurrection_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."anti_resurrection_protections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_anti_resurrection_scope_update" ON "privacy"."anti_resurrection_protections" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."anti_resurrection_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."anti_resurrection_protections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."anti_resurrection_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."anti_resurrection_protections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_anti_resurrection_scope_delete" ON "privacy"."anti_resurrection_protections" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."anti_resurrection_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."anti_resurrection_protections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_decisions_scope_select" ON "privacy"."consent_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."consent_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_decisions_scope_insert" ON "privacy"."consent_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."consent_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_decisions_scope_update" ON "privacy"."consent_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."consent_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."consent_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_decisions_scope_delete" ON "privacy"."consent_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."consent_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_disposition_decisions_scope_select" ON "privacy"."disposition_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."disposition_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."disposition_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_disposition_decisions_scope_insert" ON "privacy"."disposition_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."disposition_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."disposition_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_disposition_decisions_scope_update" ON "privacy"."disposition_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."disposition_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."disposition_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."disposition_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."disposition_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_disposition_decisions_scope_delete" ON "privacy"."disposition_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."disposition_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."disposition_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_cases_scope_select" ON "privacy"."dsr_cases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_cases_scope_insert" ON "privacy"."dsr_cases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_cases_scope_update" ON "privacy"."dsr_cases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_cases_scope_delete" ON "privacy"."dsr_cases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_owner_tasks_scope_select" ON "privacy"."dsr_owner_tasks" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_owner_tasks"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_owner_tasks"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_owner_tasks_scope_insert" ON "privacy"."dsr_owner_tasks" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_owner_tasks"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_owner_tasks"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_owner_tasks_scope_update" ON "privacy"."dsr_owner_tasks" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_owner_tasks"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_owner_tasks"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_owner_tasks"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_owner_tasks"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_owner_tasks_scope_delete" ON "privacy"."dsr_owner_tasks" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_owner_tasks"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_owner_tasks"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_provisions_scope_select" ON "privacy"."notice_provisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."notice_provisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_provisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_provisions_scope_insert" ON "privacy"."notice_provisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."notice_provisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_provisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_provisions_scope_update" ON "privacy"."notice_provisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."notice_provisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_provisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."notice_provisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_provisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_provisions_scope_delete" ON "privacy"."notice_provisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."notice_provisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_provisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_versions_scope_select" ON "privacy"."notice_versions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."notice_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_versions_scope_insert" ON "privacy"."notice_versions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."notice_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_versions_scope_update" ON "privacy"."notice_versions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."notice_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."notice_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_versions_scope_delete" ON "privacy"."notice_versions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."notice_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_outcomes_scope_select" ON "privacy"."owner_execution_outcomes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."owner_execution_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_execution_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_outcomes_scope_insert" ON "privacy"."owner_execution_outcomes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."owner_execution_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_execution_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_outcomes_scope_update" ON "privacy"."owner_execution_outcomes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."owner_execution_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_execution_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."owner_execution_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_execution_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_outcomes_scope_delete" ON "privacy"."owner_execution_outcomes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."owner_execution_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_execution_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_dispatches_scope_select" ON "privacy"."privacy_measure_dispatches" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."privacy_measure_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_measure_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_dispatches_scope_insert" ON "privacy"."privacy_measure_dispatches" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."privacy_measure_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_measure_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_dispatches_scope_update" ON "privacy"."privacy_measure_dispatches" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."privacy_measure_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_measure_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."privacy_measure_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_measure_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_dispatches_scope_delete" ON "privacy"."privacy_measure_dispatches" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."privacy_measure_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_measure_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_subjects_scope_select" ON "privacy"."privacy_subjects" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."privacy_subjects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_subjects"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_subjects_scope_insert" ON "privacy"."privacy_subjects" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."privacy_subjects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_subjects"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_subjects_scope_update" ON "privacy"."privacy_subjects" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."privacy_subjects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_subjects"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."privacy_subjects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_subjects"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_subjects_scope_delete" ON "privacy"."privacy_subjects" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."privacy_subjects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_subjects"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_activities_scope_select" ON "privacy"."processing_activities" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."processing_activities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_activities_scope_insert" ON "privacy"."processing_activities" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."processing_activities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_activities_scope_update" ON "privacy"."processing_activities" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."processing_activities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."processing_activities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_activities_scope_delete" ON "privacy"."processing_activities" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."processing_activities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_activity_lifecycle_scope_select" ON "privacy"."processing_activity_lifecycle_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."processing_activity_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activity_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_activity_lifecycle_scope_insert" ON "privacy"."processing_activity_lifecycle_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."processing_activity_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activity_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_activity_lifecycle_scope_update" ON "privacy"."processing_activity_lifecycle_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."processing_activity_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activity_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."processing_activity_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activity_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_activity_lifecycle_scope_delete" ON "privacy"."processing_activity_lifecycle_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."processing_activity_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_activity_lifecycle_events"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_purposes_scope_select" ON "privacy"."processing_purposes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."processing_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_purposes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_purposes_scope_insert" ON "privacy"."processing_purposes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."processing_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_purposes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_purposes_scope_update" ON "privacy"."processing_purposes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."processing_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_purposes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."processing_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_purposes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_purposes_scope_delete" ON "privacy"."processing_purposes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."processing_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_purposes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_purpose_versions_scope_select" ON "privacy"."purpose_versions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."purpose_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."purpose_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_purpose_versions_scope_insert" ON "privacy"."purpose_versions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."purpose_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."purpose_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_purpose_versions_scope_update" ON "privacy"."purpose_versions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."purpose_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."purpose_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."purpose_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."purpose_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_purpose_versions_scope_delete" ON "privacy"."purpose_versions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."purpose_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."purpose_versions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_work_scope_select" ON "privacy"."retention_evaluation_work" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."retention_evaluation_work"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_evaluation_work"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_work_scope_insert" ON "privacy"."retention_evaluation_work" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."retention_evaluation_work"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_evaluation_work"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_work_scope_update" ON "privacy"."retention_evaluation_work" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."retention_evaluation_work"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_evaluation_work"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."retention_evaluation_work"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_evaluation_work"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_work_scope_delete" ON "privacy"."retention_evaluation_work" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."retention_evaluation_work"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_evaluation_work"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);