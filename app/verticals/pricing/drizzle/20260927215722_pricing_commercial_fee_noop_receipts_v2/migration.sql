CREATE TABLE "pricing"."fee_action_invocation_receipts" (
	"fee_action_invocation_receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"command_fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"result_schedule_revision" integer NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fee_action_invocation_receipts_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_fee_action_invocation_receipts_fingerprint_ck" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_fee_action_invocation_receipts_outcome_ck" CHECK ("outcome" = 'COMMERCIAL_FEE_UNCHANGED'),
	CONSTRAINT "pricing_fee_action_invocation_receipts_schedule_ck" CHECK ("result_schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_action_invocation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."fee_action_invocation_receipts" ADD CONSTRAINT "pricing_fee_action_invocation_receipts_fee_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_id") REFERENCES "pricing"."fees"("tenant_id","legal_entity_id","fee_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_fee_action_invocation_receipts_scope_select" ON "pricing"."fee_action_invocation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_action_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_action_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_action_invocation_receipts_scope_insert" ON "pricing"."fee_action_invocation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_action_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_action_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_action_invocation_receipts_scope_update" ON "pricing"."fee_action_invocation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_action_invocation_receipts_scope_delete" ON "pricing"."fee_action_invocation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);