CREATE TABLE "pricing"."contractual_discount_schedule_acknowledgements" (
	"contractual_discount_schedule_acknowledgement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"issued_by_principal_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_discount_schedule_ack_fingerprint_uk" UNIQUE("tenant_id","fingerprint"),
	CONSTRAINT "pricing_discount_schedule_ack_fingerprint_ck" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_discount_schedule_ack_payload_ck" CHECK (jsonb_typeof("acknowledgement") = 'object' and "acknowledgement"->>'fingerprint' = "fingerprint")
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_schedule_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_schedule_acknowledgements" ADD CONSTRAINT "pricing_contractual_discount_schedule_acknowledgements_discount_fk" FOREIGN KEY ("tenant_id","legal_entity_id","discount_id") REFERENCES "pricing"."contractual_discounts"("tenant_id","legal_entity_id","discount_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_acknowledgements_scope_select" ON "pricing"."contractual_discount_schedule_acknowledgements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_acknowledgements_scope_insert" ON "pricing"."contractual_discount_schedule_acknowledgements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_acknowledgements_scope_update" ON "pricing"."contractual_discount_schedule_acknowledgements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_acknowledgements_scope_delete" ON "pricing"."contractual_discount_schedule_acknowledgements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
