CREATE TABLE "communications"."privacy_execution_evidence" (
	"confirmation_invocation_id" uuid NOT NULL,
	"evidence_ref" text,
	"idempotency_key" text NOT NULL,
	"phase" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"results" jsonb NOT NULL,
	"scope_digest" text NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "communications_privacy_evidence_pk" PRIMARY KEY("tenant_id","evidence_ref"),
	CONSTRAINT "communications_privacy_evidence_identity_ck" CHECK (btrim("evidence_ref") <> ''),
	CONSTRAINT "communications_privacy_evidence_phase_ck" CHECK ("phase" in ('RECEIVED', 'IN_PROGRESS', 'COMPLETED')),
	CONSTRAINT "communications_privacy_evidence_scope_ck" CHECK ("scope_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "communications_privacy_evidence_results_ck" CHECK (jsonb_typeof("results") = 'array' and ("phase" <> 'RECEIVED' or jsonb_array_length("results") = 0) and not jsonb_path_exists("results", '$[*] ? (@.type() != "object" || !exists(@.contentRef ? (@.type() == "string" && @ != "")) || !exists(@.result ? (@ == "ANONYMIZED" || @ == "FAILED_AFTER_POSSIBLE_MUTATION" || @ == "FAILED_BEFORE_ANY_MUTATION" || @ == "NOT_EXECUTED" || @ == "RECTIFIED" || @ == "REMOVED" || @ == "RESTRICTED")) || exists(@.keyvalue() ? (@.key != "contentRef" && @.key != "result")))'))
);
--> statement-breakpoint
ALTER TABLE "communications"."privacy_execution_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."privacy_measure_handoffs" (
	"handoff_fingerprint" text NOT NULL,
	"idempotency_key" text,
	"measure_id" text NOT NULL,
	"originator_invocation_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"scope_digest" text NOT NULL,
	"source_decision_ref" text NOT NULL,
	"source_decision_revision" integer NOT NULL,
	"target_content_refs" jsonb NOT NULL,
	"task_id" text NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "communications_privacy_handoffs_pk" PRIMARY KEY("tenant_id","idempotency_key"),
	CONSTRAINT "communications_privacy_handoffs_identity_ck" CHECK (btrim("idempotency_key") <> '' and btrim("measure_id") <> '' and btrim("task_id") <> '' and btrim("source_decision_ref") <> ''),
	CONSTRAINT "communications_privacy_handoffs_revision_ck" CHECK ("source_decision_revision" >= 1),
	CONSTRAINT "communications_privacy_handoffs_fingerprint_ck" CHECK ("handoff_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "communications_privacy_handoffs_scope_ck" CHECK ("scope_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "communications_privacy_handoffs_targets_ck" CHECK (jsonb_typeof("target_content_refs") = 'array' and jsonb_array_length("target_content_refs") > 0 and not jsonb_path_exists("target_content_refs", '$[*] ? (@.type() != "string" || @ == "")'))
);
--> statement-breakpoint
ALTER TABLE "communications"."privacy_measure_handoffs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "communications_privacy_evidence_handoff_idx" ON "communications"."privacy_execution_evidence" ("tenant_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "communications"."privacy_execution_evidence" ADD CONSTRAINT "communications_privacy_evidence_handoff_fk" FOREIGN KEY ("tenant_id","idempotency_key") REFERENCES "communications"."privacy_measure_handoffs"("tenant_id","idempotency_key") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "privacy_execution_evidence_select" ON "communications"."privacy_execution_evidence" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."privacy_execution_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_execution_evidence_insert" ON "communications"."privacy_execution_evidence" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."privacy_execution_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_execution_evidence_update" ON "communications"."privacy_execution_evidence" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."privacy_execution_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."privacy_execution_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_execution_evidence_delete" ON "communications"."privacy_execution_evidence" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."privacy_execution_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_handoffs_select" ON "communications"."privacy_measure_handoffs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."privacy_measure_handoffs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_handoffs_insert" ON "communications"."privacy_measure_handoffs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."privacy_measure_handoffs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_handoffs_update" ON "communications"."privacy_measure_handoffs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."privacy_measure_handoffs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."privacy_measure_handoffs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_measure_handoffs_delete" ON "communications"."privacy_measure_handoffs" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."privacy_measure_handoffs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);