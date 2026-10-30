CREATE TABLE "commerce_order"."finalization_intents" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intent_id" text NOT NULL,
	"buyer_principal_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"business_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"attempt_id" text,
	"data" jsonb NOT NULL,
	"result" jsonb,
	"proof_ref" text,
	"status" text NOT NULL,
	CONSTRAINT "order_finalization_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","intent_id"),
	CONSTRAINT "order_finalization_business_uk" UNIQUE("tenant_id","legal_entity_id","buyer_principal_id","stage","business_key"),
	CONSTRAINT "order_finalization_proof_uk" UNIQUE("tenant_id","legal_entity_id","proof_ref"),
	CONSTRAINT "order_finalization_stage_ck" CHECK ("stage" in ('PREPARE','PROOF') and ("stage" = 'PROOF') = ("attempt_id" is not null)),
	CONSTRAINT "order_finalization_result_ck" CHECK ("status" in ('PENDING','COMPLETE','FAILED') and ("status" <> 'PENDING') = ("result" is not null) and ("proof_ref" is not null) = ("stage" = 'PROOF' and "status" = 'COMPLETE')),
	CONSTRAINT "order_finalization_hash_ck" CHECK ("input_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "commerce_order"."finalization_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_order"."finalization_intents" ADD CONSTRAINT "order_finalization_attempt_fk" FOREIGN KEY ("tenant_id","legal_entity_id","attempt_id") REFERENCES "commerce_order"."commitment_attempts"("tenant_id","legal_entity_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "order_finalization_select" ON "commerce_order"."finalization_intents" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_order"."finalization_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."finalization_intents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_finalization_insert" ON "commerce_order"."finalization_intents" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_order"."finalization_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."finalization_intents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_finalization_update" ON "commerce_order"."finalization_intents" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_order"."finalization_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."finalization_intents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_order"."finalization_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."finalization_intents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_finalization_delete" ON "commerce_order"."finalization_intents" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_order"."finalization_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."finalization_intents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);