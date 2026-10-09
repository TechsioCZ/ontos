CREATE TABLE "assortment"."assortment_commitment_confirmations" (
	"commitment_confirmation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"attempt_module_id" text NOT NULL,
	"attempt_resource_id" text NOT NULL,
	"attempt_resource_type" text NOT NULL,
	"prospective_meaning_json" jsonb NOT NULL,
	"constituent_fingerprint" text NOT NULL,
	"constituent_json" jsonb NOT NULL,
	"candidate_json" jsonb NOT NULL,
	"decision_evidence_json" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_commitment_confirmations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","commitment_confirmation_id"),
	CONSTRAINT "assortment_commitment_confirmations_attempt_module_ck" CHECK ("attempt_module_id" = btrim("attempt_module_id") and length("attempt_module_id") between 1 and 200),
	CONSTRAINT "assortment_commitment_confirmations_attempt_id_ck" CHECK ("attempt_resource_id" = btrim("attempt_resource_id") and length("attempt_resource_id") between 1 and 200),
	CONSTRAINT "assortment_commitment_confirmations_attempt_type_ck" CHECK ("attempt_resource_type" = btrim("attempt_resource_type") and length("attempt_resource_type") between 1 and 200),
	CONSTRAINT "assortment_commitment_confirmations_fingerprint_ck" CHECK ("constituent_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assortment_commitment_confirmations_validity_ck" CHECK ("expires_at" > "issued_at" and "expires_at" <= "issued_at" + interval '30 seconds')
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_commitment_confirmations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_commitment_confirmations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER "assortment_commitment_confirmations_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_commitment_confirmations" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();--> statement-breakpoint
CREATE INDEX "assortment_commitment_confirmations_active_idx" ON "assortment"."assortment_commitment_confirmations" ("tenant_id","legal_entity_id","attempt_module_id","attempt_resource_id","attempt_resource_type","constituent_fingerprint","expires_at");--> statement-breakpoint
CREATE POLICY "assortment_commitment_confirmations_scope_select" ON "assortment"."assortment_commitment_confirmations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_commitment_confirmations_scope_insert" ON "assortment"."assortment_commitment_confirmations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_commitment_confirmations_scope_update" ON "assortment"."assortment_commitment_confirmations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_commitment_confirmations_scope_delete" ON "assortment"."assortment_commitment_confirmations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
