CREATE TABLE "symmy_integration"."privacy_measure_executions" (
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"governance_legal_entity_id" uuid NOT NULL,
	"handoff_fingerprint" text NOT NULL,
	"idempotency_digest" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"receipt_id" uuid PRIMARY KEY,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"retention_status" text NOT NULL,
	"target_legal_entity_id" uuid,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "symmy_privacy_executions_scope_key_uq" UNIQUE("tenant_id","governance_legal_entity_id","idempotency_digest"),
	CONSTRAINT "symmy_privacy_executions_digests_ck" CHECK ("handoff_fingerprint" ~ '^[a-f0-9]{64}$' and "idempotency_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "symmy_privacy_executions_kind_ck" CHECK ("resource_kind" in ('JOB','SYNC') and "retention_status" in ('PURGED','ALREADY_PURGED','BLOCKED')),
	CONSTRAINT "symmy_privacy_executions_outcome_ck" CHECK ("outcome"->>'owningCapability' = 'integration.symmy' and "outcome"->>'status' in ('SUCCEEDED','BLOCKED'))
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."privacy_measure_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "symmy_privacy_executions_scope_select" ON "symmy_integration"."privacy_measure_executions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "symmy_integration"."privacy_measure_executions"."governance_legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_privacy_executions_scope_insert" ON "symmy_integration"."privacy_measure_executions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "symmy_integration"."privacy_measure_executions"."governance_legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_privacy_executions_scope_update" ON "symmy_integration"."privacy_measure_executions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "symmy_integration"."privacy_measure_executions"."governance_legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("symmy_integration"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "symmy_integration"."privacy_measure_executions"."governance_legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_privacy_executions_scope_delete" ON "symmy_integration"."privacy_measure_executions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "symmy_integration"."privacy_measure_executions"."governance_legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);