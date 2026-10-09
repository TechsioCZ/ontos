CREATE TABLE "pricing"."currency_support_recovery_compensation_receipts" (
	"currency_support_recovery_compensation_receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"compensation_action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"committed_action_invocation_id" uuid NOT NULL,
	"currency_support_id" uuid NOT NULL,
	"committed_currency_support_revision_id" uuid NOT NULL,
	"previous_schedule_revision_id" uuid NOT NULL,
	"compensation_schedule_revision_id" uuid NOT NULL,
	"absent_from" timestamp with time zone NOT NULL,
	"request_payload" jsonb NOT NULL,
	"result_payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_currency_support_recovery_compensation_invocation_uk" UNIQUE("tenant_id","compensation_action_invocation_id"),
	CONSTRAINT "pricing_currency_support_recovery_compensation_commit_uk" UNIQUE("tenant_id","committed_action_invocation_id"),
	CONSTRAINT "pricing_currency_support_recovery_compensation_invocation_ck" CHECK ("compensation_action_invocation_id" <> "committed_action_invocation_id"),
	CONSTRAINT "pricing_currency_support_recovery_compensation_payload_ck" CHECK (jsonb_typeof("request_payload") = 'object' and jsonb_typeof("result_payload") = 'object'),
	CONSTRAINT "pricing_currency_support_recovery_compensation_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_recovery_compensation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_recovery_compensation_receipts" ADD CONSTRAINT "pricing_currency_support_recovery_compensation_commit_fk" FOREIGN KEY ("tenant_id","committed_action_invocation_id") REFERENCES "pricing"."currency_support_action_result_receipts"("tenant_id","action_invocation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_recovery_compensation_receipts" ADD CONSTRAINT "pricing_currency_support_recovery_compensation_root_fk" FOREIGN KEY ("tenant_id","currency_support_id") REFERENCES "pricing"."currency_support_roots"("tenant_id","currency_support_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_recovery_compensation_receipts" ADD CONSTRAINT "pricing_currency_support_recovery_compensation_value_fk" FOREIGN KEY ("tenant_id","currency_support_id","committed_currency_support_revision_id") REFERENCES "pricing"."currency_support_value_revisions"("tenant_id","currency_support_id","currency_support_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_recovery_compensation_receipts" ADD CONSTRAINT "pricing_currency_support_recovery_compensation_previous_schedule_fk" FOREIGN KEY ("tenant_id","currency_support_id","previous_schedule_revision_id") REFERENCES "pricing"."currency_support_schedule_revisions"("tenant_id","currency_support_id","currency_support_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."currency_support_recovery_compensation_receipts" ADD CONSTRAINT "pricing_currency_support_recovery_compensation_schedule_fk" FOREIGN KEY ("tenant_id","currency_support_id","compensation_schedule_revision_id") REFERENCES "pricing"."currency_support_schedule_revisions"("tenant_id","currency_support_id","currency_support_schedule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_currency_support_recovery_compensation_tenant_select" ON "pricing"."currency_support_recovery_compensation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."currency_support_recovery_compensation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_recovery_compensation_tenant_insert" ON "pricing"."currency_support_recovery_compensation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."currency_support_recovery_compensation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_recovery_compensation_tenant_update" ON "pricing"."currency_support_recovery_compensation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_currency_support_recovery_compensation_tenant_delete" ON "pricing"."currency_support_recovery_compensation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);