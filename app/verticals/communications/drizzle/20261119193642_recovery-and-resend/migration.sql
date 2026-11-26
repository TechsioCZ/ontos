CREATE TABLE "communications"."intent_recovery_evaluations" (
	"basis_attempt_id" uuid NOT NULL,
	"code" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"evaluation_seq" integer NOT NULL,
	"intent_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"proven" boolean GENERATED ALWAYS AS (jsonb_path_exists("reasons", '$[*] ? (@.proven == true)')) STORED NOT NULL,
	"reasons" jsonb NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_recovery_evaluations_seq_uk" UNIQUE("tenant_id","intent_id","evaluation_seq"),
	CONSTRAINT "communications_recovery_evaluations_seq_ck" CHECK ("evaluation_seq" > 0),
	CONSTRAINT "communications_recovery_evaluations_outcome_ck" CHECK ("outcome" in ('HALTED', 'STOPPED')),
	CONSTRAINT "communications_recovery_evaluations_code_ck" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{0,79}$'),
	CONSTRAINT "communications_recovery_evaluations_shape_ck" CHECK (jsonb_typeof("reasons") = 'array' and (("outcome" = 'HALTED' and jsonb_array_length("reasons") = 0) or ("outcome" = 'STOPPED' and jsonb_array_length("reasons") > 0)))
);
--> statement-breakpoint
ALTER TABLE "communications"."intent_recovery_evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."provider_observation_conflict_resolutions" (
	"attempt_id" uuid NOT NULL,
	"basis_observation_id" uuid NOT NULL,
	"conflict_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"resolution_id" uuid PRIMARY KEY,
	"resolved_at" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_conflict_resolutions_conflict_uk" UNIQUE("tenant_id","conflict_id"),
	CONSTRAINT "communications_conflict_resolutions_reason_ck" CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]{0,79}$')
);
--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflict_resolutions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflicts" ADD CONSTRAINT "communications_observation_conflicts_identity_uk" UNIQUE("tenant_id","conflict_id");--> statement-breakpoint
CREATE INDEX "communications_conflict_resolutions_intent_idx" ON "communications"."provider_observation_conflict_resolutions" ("tenant_id","intent_id");--> statement-breakpoint
ALTER TABLE "communications"."intent_recovery_evaluations" ADD CONSTRAINT "communications_recovery_evaluations_attempt_fk" FOREIGN KEY ("tenant_id","intent_id","basis_attempt_id") REFERENCES "communications"."delivery_attempts"("tenant_id","intent_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflict_resolutions" ADD CONSTRAINT "communications_conflict_resolutions_conflict_fk" FOREIGN KEY ("tenant_id","conflict_id") REFERENCES "communications"."provider_observation_conflicts"("tenant_id","conflict_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflict_resolutions" ADD CONSTRAINT "communications_conflict_resolutions_attempt_fk" FOREIGN KEY ("tenant_id","intent_id","attempt_id") REFERENCES "communications"."delivery_attempts"("tenant_id","intent_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflict_resolutions" ADD CONSTRAINT "communications_conflict_resolutions_basis_fk" FOREIGN KEY ("tenant_id","basis_observation_id") REFERENCES "communications"."provider_observations"("tenant_id","observation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."intent_resend_links" DROP CONSTRAINT "communications_resend_links_reason_ck", ADD CONSTRAINT "communications_resend_links_reason_ck" CHECK ("reason_code" in ('PRIOR_DELIVERY_FAILED', 'RECIPIENT_NOT_RECEIVED', 'RECIPIENT_REQUESTED_COPY', 'SOURCE_APPROVED_RESEND'));--> statement-breakpoint
CREATE POLICY "intent_recovery_evaluations_select" ON "communications"."intent_recovery_evaluations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."intent_recovery_evaluations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_recovery_evaluations_insert" ON "communications"."intent_recovery_evaluations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."intent_recovery_evaluations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_recovery_evaluations_update" ON "communications"."intent_recovery_evaluations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."intent_recovery_evaluations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."intent_recovery_evaluations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_recovery_evaluations_delete" ON "communications"."intent_recovery_evaluations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."intent_recovery_evaluations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflict_resolutions_select" ON "communications"."provider_observation_conflict_resolutions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."provider_observation_conflict_resolutions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflict_resolutions_insert" ON "communications"."provider_observation_conflict_resolutions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."provider_observation_conflict_resolutions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflict_resolutions_update" ON "communications"."provider_observation_conflict_resolutions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."provider_observation_conflict_resolutions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."provider_observation_conflict_resolutions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflict_resolutions_delete" ON "communications"."provider_observation_conflict_resolutions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."provider_observation_conflict_resolutions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);