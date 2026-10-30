CREATE TABLE "pricing"."pricing_commitment_confirmation_issuance_receipts" (
	"tenant_id" uuid,
	"legal_entity_id" uuid,
	"action_invocation_id" uuid,
	"principal_id" uuid NOT NULL,
	"confirmation_ref" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_confirmation_issuance_receipts_pk" PRIMARY KEY("tenant_id","legal_entity_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "pricing"."pricing_commitment_confirmation_issuance_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."pricing_commitment_confirmation_issuance_receipts" ADD CONSTRAINT "pricing_confirmation_issuance_receipts_confirmation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","confirmation_ref") REFERENCES "pricing"."pricing_commitment_confirmations"("tenant_id","legal_entity_id","confirmation_ref");--> statement-breakpoint
CREATE POLICY "pricing_confirmation_issuance_receipts_scope_select" ON "pricing"."pricing_commitment_confirmation_issuance_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."pricing_commitment_confirmation_issuance_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."pricing_commitment_confirmation_issuance_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_confirmation_issuance_receipts_scope_insert" ON "pricing"."pricing_commitment_confirmation_issuance_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."pricing_commitment_confirmation_issuance_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."pricing_commitment_confirmation_issuance_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_confirmation_issuance_receipts_scope_update" ON "pricing"."pricing_commitment_confirmation_issuance_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_confirmation_issuance_receipts_scope_delete" ON "pricing"."pricing_commitment_confirmation_issuance_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
--> statement-breakpoint
ALTER TABLE "pricing"."pricing_commitment_confirmation_issuance_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "pricing"."pricing_commitment_confirmation_issuance_receipts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "pricing"."pricing_commitment_confirmation_issuance_receipts" TO "ontos_runtime";
