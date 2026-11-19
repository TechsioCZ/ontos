CREATE TABLE "communications"."attempt_retry_links" (
	"attempt_id" uuid PRIMARY KEY,
	"basis_kind" text NOT NULL,
	"basis_observation_id" uuid,
	"intent_id" uuid NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"previous_attempt_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_retry_links_distinct_ck" CHECK ("attempt_id" <> "previous_attempt_id"),
	CONSTRAINT "communications_retry_links_reason_ck" CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]{0,79}$'),
	CONSTRAINT "communications_retry_links_basis_ck" CHECK (("basis_kind" = 'PRIOR_NOT_ATTEMPTED' and "basis_observation_id" is null) or ("basis_kind" = 'RECONCILED_NON_ACCEPTANCE' and "basis_observation_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "communications"."attempt_retry_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."intent_resend_links" (
	"linked_at" timestamp with time zone NOT NULL,
	"original_intent_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"resend_intent_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_resend_links_resend_uk" UNIQUE("tenant_id","resend_intent_id"),
	CONSTRAINT "communications_resend_links_distinct_ck" CHECK ("original_intent_id" <> "resend_intent_id"),
	CONSTRAINT "communications_resend_links_reason_ck" CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]{0,79}$')
);
--> statement-breakpoint
ALTER TABLE "communications"."intent_resend_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."provider_observations" (
	"attempt_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"intent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observation_id" uuid PRIMARY KEY,
	"observation_key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"provider_key" text NOT NULL,
	"provider_ref" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_seq" bigint CONSTRAINT "communications_observations_seq_uk" UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "communications"."provider_observations_recorded_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_observations_tenant_identity_uk" UNIQUE("tenant_id","observation_id"),
	CONSTRAINT "communications_observations_provider_identity_uk" UNIQUE("tenant_id","attempt_id","provider_key","observation_key"),
	CONSTRAINT "communications_observations_kind_ck" CHECK ("kind" in ('ACCEPTANCE_PROVEN', 'DELIVERY_FAILED', 'DELIVERY_PROVEN', 'NON_ACCEPTANCE_PROVEN')),
	CONSTRAINT "communications_observations_keys_ck" CHECK ("observation_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and "provider_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and ("provider_ref" is null or "provider_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')),
	CONSTRAINT "communications_observations_evidence_ck" CHECK (jsonb_typeof("evidence") = 'object' and ("evidence" - array['basis', 'failureClass', 'kind']) = '{}'::jsonb and "evidence" ->> 'kind' = "kind" and ("evidence" ->> 'basis') in ('PROVIDER_EVENT', 'RECONCILIATION') and (("kind" = 'DELIVERY_FAILED') = (("evidence" ->> 'failureClass') is not null)) and ("kind" <> 'DELIVERY_FAILED' or ("evidence" ->> 'failureClass') in ('BOUNCED_PERMANENT', 'BOUNCED_TRANSIENT', 'DROPPED_BY_PROVIDER'))),
	CONSTRAINT "communications_observations_basis_ck" CHECK (("kind" not in ('DELIVERY_PROVEN', 'DELIVERY_FAILED') or ("evidence" ->> 'basis') = 'PROVIDER_EVENT') and ("kind" <> 'NON_ACCEPTANCE_PROVEN' or ("evidence" ->> 'basis') = 'RECONCILIATION'))
);
--> statement-breakpoint
ALTER TABLE "communications"."provider_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."delivery_attempts" ADD CONSTRAINT "communications_attempts_intent_identity_uk" UNIQUE("tenant_id","intent_id","attempt_id");--> statement-breakpoint
CREATE INDEX "communications_retry_links_previous_idx" ON "communications"."attempt_retry_links" ("tenant_id","previous_attempt_id");--> statement-breakpoint
CREATE INDEX "communications_resend_links_original_idx" ON "communications"."intent_resend_links" ("tenant_id","original_intent_id");--> statement-breakpoint
CREATE INDEX "communications_observations_intent_idx" ON "communications"."provider_observations" ("tenant_id","intent_id");--> statement-breakpoint
ALTER TABLE "communications"."attempt_retry_links" ADD CONSTRAINT "communications_retry_links_attempt_fk" FOREIGN KEY ("tenant_id","intent_id","attempt_id") REFERENCES "communications"."delivery_attempts"("tenant_id","intent_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."attempt_retry_links" ADD CONSTRAINT "communications_retry_links_previous_fk" FOREIGN KEY ("tenant_id","intent_id","previous_attempt_id") REFERENCES "communications"."delivery_attempts"("tenant_id","intent_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."attempt_retry_links" ADD CONSTRAINT "communications_retry_links_basis_fk" FOREIGN KEY ("tenant_id","basis_observation_id") REFERENCES "communications"."provider_observations"("tenant_id","observation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."intent_resend_links" ADD CONSTRAINT "communications_resend_links_original_fk" FOREIGN KEY ("tenant_id","original_intent_id") REFERENCES "communications"."message_intents"("tenant_id","intent_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."intent_resend_links" ADD CONSTRAINT "communications_resend_links_resend_fk" FOREIGN KEY ("tenant_id","resend_intent_id") REFERENCES "communications"."message_intents"("tenant_id","intent_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."provider_observations" ADD CONSTRAINT "communications_observations_attempt_fk" FOREIGN KEY ("tenant_id","intent_id","attempt_id") REFERENCES "communications"."delivery_attempts"("tenant_id","intent_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "attempt_retry_links_select" ON "communications"."attempt_retry_links" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."attempt_retry_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attempt_retry_links_insert" ON "communications"."attempt_retry_links" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."attempt_retry_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attempt_retry_links_update" ON "communications"."attempt_retry_links" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."attempt_retry_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."attempt_retry_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attempt_retry_links_delete" ON "communications"."attempt_retry_links" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."attempt_retry_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_resend_links_select" ON "communications"."intent_resend_links" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."intent_resend_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_resend_links_insert" ON "communications"."intent_resend_links" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."intent_resend_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_resend_links_update" ON "communications"."intent_resend_links" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."intent_resend_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."intent_resend_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_resend_links_delete" ON "communications"."intent_resend_links" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."intent_resend_links"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observations_select" ON "communications"."provider_observations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."provider_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observations_insert" ON "communications"."provider_observations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."provider_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observations_update" ON "communications"."provider_observations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."provider_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."provider_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observations_delete" ON "communications"."provider_observations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."provider_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);