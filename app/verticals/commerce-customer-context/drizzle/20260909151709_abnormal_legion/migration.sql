CREATE TABLE "commerce_customer_context"."payment_term_retirement_reservations" (
	"payment_term_retirement_reservation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"payment_term_resource_ids" text[] NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"lifecycle" text DEFAULT 'RESERVED' NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_payment_term_retirement_reservations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_term_retirement_reservation_id"),
	CONSTRAINT "ccc_payment_term_retirement_reservations_action_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "ccc_payment_term_retirement_reservations_ids_ck" CHECK (cardinality("payment_term_resource_ids") between 1 and 200 and array_position("payment_term_resource_ids", null) is null),
	CONSTRAINT "ccc_payment_term_retirement_reservations_lifecycle_ck" CHECK ("lifecycle" in ('RESERVED', 'COMMITTED', 'RELEASED')),
	CONSTRAINT "ccc_payment_term_retirement_reservations_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."payment_term_retirement_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."payment_term_retirement_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" (
	"retail_portal_profile_binding_permission_mutation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"retail_portal_profile_binding_id" uuid NOT NULL,
	"retail_customer_profile_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	"operation" text NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"finalized_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_portal_binding_permission_mutations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","retail_portal_profile_binding_permission_mutation_id"),
	CONSTRAINT "ccc_portal_binding_permission_mutations_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","retail_portal_profile_binding_id","action_invocation_id","operation","permission_code"),
	CONSTRAINT "ccc_portal_binding_permission_mutations_operation_ck" CHECK ("operation" in ('grant', 'revoke')),
	CONSTRAINT "ccc_portal_binding_permission_mutations_state_ck" CHECK ("state" in ('PENDING_GRANT', 'PENDING_REVOKE', 'ACTIVE', 'REVOKED', 'RECONCILIATION_REQUIRED') and (("operation" = 'grant' and "state" in ('PENDING_GRANT', 'ACTIVE', 'RECONCILIATION_REQUIRED')) or ("operation" = 'revoke' and "state" in ('PENDING_REVOKE', 'REVOKED', 'RECONCILIATION_REQUIRED')))),
	CONSTRAINT "ccc_portal_binding_permission_mutations_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_portal_binding_permission_mutations_finalized_ck" CHECK (("state" in ('ACTIVE', 'REVOKED') and "finalized_at" is not null) or ("state" not in ('ACTIVE', 'REVOKED') and "finalized_at" is null)),
	CONSTRAINT "ccc_portal_binding_permission_mutations_permission_ck" CHECK ("permission_code" = btrim("permission_code") and length("permission_code") > 0),
	CONSTRAINT "ccc_portal_binding_permission_mutations_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD COLUMN "claim_origin_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD COLUMN "claim_origin_action_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD COLUMN "claim_origin_proof_reference" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD COLUMN "authorization_operation" text DEFAULT 'grant' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD COLUMN "authorization_state" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" ADD CONSTRAINT "ccc_portal_binding_permission_mutations_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","retail_portal_profile_binding_id") REFERENCES "commerce_customer_context"."retail_portal_profile_bindings"("tenant_id","legal_entity_id","retail_portal_profile_binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" ADD CONSTRAINT "ccc_portal_binding_permission_mutations_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","retail_customer_profile_id") REFERENCES "commerce_customer_context"."retail_customer_profiles"("tenant_id","legal_entity_id","retail_customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD CONSTRAINT "ccc_access_invitations_claim_origin_proof_ck" CHECK ("claim_origin_proof_reference" is null or ("claim_origin_proof_reference" = btrim("claim_origin_proof_reference") and length("claim_origin_proof_reference") > 0));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD CONSTRAINT "ccc_access_invitations_claim_origin_ck" CHECK (("claim_origin_principal_id" is null and "claim_origin_action_invocation_id" is null and "claim_origin_proof_reference" is null) or ("claim_origin_principal_id" is not null and "claim_origin_action_invocation_id" is not null and "claim_origin_proof_reference" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD CONSTRAINT "ccc_portal_bindings_authorization_operation_ck" CHECK ("authorization_operation" in ('grant', 'revoke'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD CONSTRAINT "ccc_portal_bindings_authorization_state_ck" CHECK ("authorization_state" in ('ACTIVE', 'REVOKED', 'PENDING_GRANT', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED'));--> statement-breakpoint
CREATE POLICY "ccc_payment_term_retirement_reservations_scope_select" ON "commerce_customer_context"."payment_term_retirement_reservations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_retirement_reservations_scope_insert" ON "commerce_customer_context"."payment_term_retirement_reservations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_retirement_reservations_scope_update" ON "commerce_customer_context"."payment_term_retirement_reservations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_retirement_reservations_scope_delete" ON "commerce_customer_context"."payment_term_retirement_reservations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_retirement_reservations_scope_owner_routine" ON "commerce_customer_context"."payment_term_retirement_reservations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."payment_term_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_permission_mutations_scope_select" ON "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_permission_mutations_scope_insert" ON "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_permission_mutations_scope_update" ON "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_permission_mutations_scope_delete" ON "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_permission_mutations_scope_owner_routine" ON "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_permission_mutations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
