CREATE TABLE "communications"."provider_observation_conflicts" (
	"attempt_id" uuid NOT NULL,
	"conflict_id" uuid PRIMARY KEY,
	"content_fingerprint" text NOT NULL,
	"intent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observation_id" uuid NOT NULL,
	"observation_key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"provider_key" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_seq" bigint CONSTRAINT "communications_observation_conflicts_seq_uk" UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "communications"."provider_observation_conflicts_recorded_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_observation_conflicts_content_uk" UNIQUE("tenant_id","observation_id","content_fingerprint"),
	CONSTRAINT "communications_observation_conflicts_kind_ck" CHECK ("kind" in ('ACCEPTANCE_PROVEN', 'DELIVERY_FAILED', 'DELIVERY_PROVEN', 'NON_ACCEPTANCE_PROVEN')),
	CONSTRAINT "communications_observation_conflicts_keys_ck" CHECK ("observation_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and "provider_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "communications_observation_conflicts_fingerprint_ck" CHECK ("content_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."provider_observations" DROP CONSTRAINT "communications_observations_provider_identity_uk";--> statement-breakpoint
ALTER TABLE "communications"."provider_observations" ADD CONSTRAINT "communications_observations_provider_identity_uk" UNIQUE("tenant_id","attempt_id","provider_key","observation_key","kind");--> statement-breakpoint
CREATE INDEX "communications_observation_conflicts_intent_idx" ON "communications"."provider_observation_conflicts" ("tenant_id","intent_id");--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflicts" ADD CONSTRAINT "communications_observation_conflicts_attempt_fk" FOREIGN KEY ("tenant_id","intent_id","attempt_id") REFERENCES "communications"."delivery_attempts"("tenant_id","intent_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."provider_observation_conflicts" ADD CONSTRAINT "communications_observation_conflicts_observation_fk" FOREIGN KEY ("tenant_id","observation_id") REFERENCES "communications"."provider_observations"("tenant_id","observation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."attempt_retry_links" DROP CONSTRAINT "communications_retry_links_basis_ck", ADD CONSTRAINT "communications_retry_links_basis_ck" CHECK (("basis_kind" in ('PRIOR_NOT_ATTEMPTED', 'PRIOR_REJECTED') and "basis_observation_id" is null) or ("basis_kind" = 'RECONCILED_NON_ACCEPTANCE' and "basis_observation_id" is not null));--> statement-breakpoint
ALTER TABLE "communications"."intent_resend_links" DROP CONSTRAINT "communications_resend_links_reason_ck", ADD CONSTRAINT "communications_resend_links_reason_ck" CHECK ("reason_code" in ('SOURCE_APPROVED_RESEND'));--> statement-breakpoint
CREATE POLICY "provider_observation_conflicts_select" ON "communications"."provider_observation_conflicts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."provider_observation_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflicts_insert" ON "communications"."provider_observation_conflicts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."provider_observation_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflicts_update" ON "communications"."provider_observation_conflicts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."provider_observation_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."provider_observation_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "provider_observation_conflicts_delete" ON "communications"."provider_observation_conflicts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."provider_observation_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);