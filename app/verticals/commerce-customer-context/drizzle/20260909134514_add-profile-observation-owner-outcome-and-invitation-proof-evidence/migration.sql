CREATE TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" (
	"counterparty_invitation_claim_attempt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"claimant_principal_id" uuid NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_outcome" text NOT NULL,
	CONSTRAINT "ccc_invitation_claim_attempts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_invitation_claim_attempt_id"),
	CONSTRAINT "ccc_invitation_claim_attempts_claimant_uk" UNIQUE("tenant_id","legal_entity_id","invitation_id","claimant_principal_id"),
	CONSTRAINT "ccc_invitation_claim_attempts_count_ck" CHECK ("attempt_count" between 0 and 32767),
	CONSTRAINT "ccc_invitation_claim_attempts_window_ck" CHECK ("last_attempt_at" >= "window_started_at" and ("blocked_until" is null or "blocked_until" >= "last_attempt_at")),
	CONSTRAINT "ccc_invitation_claim_attempts_outcome_ck" CHECK ("last_outcome" in ('INVALID', 'RATE_LIMITED', 'REDEEMED', 'CONSUMED'))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" (
	"counterparty_invitation_claim_proof_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"counterparty_resource_id" text NOT NULL,
	"storefront_resource_id" text,
	"proof_reference" text NOT NULL,
	"secret_digest" text NOT NULL,
	"proof_version" text DEFAULT 'commerce-invitation-proof.v1' NOT NULL,
	"lifecycle" text DEFAULT 'ISSUED' NOT NULL,
	"delivery_state" text DEFAULT 'PENDING' NOT NULL,
	"delivery_method" text NOT NULL,
	"delivery_reference" text NOT NULL,
	"delivery_attempt_count" smallint DEFAULT 0 NOT NULL,
	"intended_permission_codes" jsonb NOT NULL,
	"inviter_principal_id" uuid NOT NULL,
	"claimant_principal_id" uuid,
	"issue_action_invocation_id" uuid NOT NULL,
	"consume_action_invocation_id" uuid,
	"attestation_reference" text,
	"expires_at" timestamp with time zone NOT NULL,
	"delivery_staged_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_invitation_claim_proofs_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_invitation_claim_proof_id"),
	CONSTRAINT "ccc_invitation_claim_proofs_reference_uk" UNIQUE("tenant_id","legal_entity_id","proof_reference"),
	CONSTRAINT "ccc_invitation_claim_proofs_attestation_uk" UNIQUE("tenant_id","legal_entity_id","attestation_reference"),
	CONSTRAINT "ccc_invitation_claim_proofs_issue_action_uk" UNIQUE("tenant_id","legal_entity_id","invitation_id","issue_action_invocation_id"),
	CONSTRAINT "ccc_invitation_claim_proofs_counterparty_ck" CHECK ("counterparty_resource_id" = btrim("counterparty_resource_id") and length("counterparty_resource_id") > 0),
	CONSTRAINT "ccc_invitation_claim_proofs_storefront_ck" CHECK ("storefront_resource_id" is null or ("storefront_resource_id" = btrim("storefront_resource_id") and length("storefront_resource_id") > 0)),
	CONSTRAINT "ccc_invitation_claim_proofs_reference_ck" CHECK ("proof_reference" = btrim("proof_reference") and length("proof_reference") > 0),
	CONSTRAINT "ccc_invitation_claim_proofs_digest_ck" CHECK ("secret_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccc_invitation_claim_proofs_version_ck" CHECK ("proof_version" = 'commerce-invitation-proof.v1'),
	CONSTRAINT "ccc_invitation_claim_proofs_lifecycle_ck" CHECK ("lifecycle" in ('ISSUED', 'VERIFIED', 'CONSUMED', 'REVOKED', 'EXPIRED')),
	CONSTRAINT "ccc_invitation_claim_proofs_delivery_ck" CHECK ("delivery_state" in ('PENDING', 'STAGED', 'FAILED') and "delivery_attempt_count" between 0 and 32767 and (("delivery_state" = 'PENDING' and "delivery_staged_at" is null) or ("delivery_state" = 'STAGED' and "delivery_staged_at" is not null) or ("delivery_state" = 'FAILED' and "delivery_staged_at" is null))),
	CONSTRAINT "ccc_invitation_claim_proofs_delivery_method_ck" CHECK ("delivery_method" in ('VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY')),
	CONSTRAINT "ccc_invitation_claim_proofs_delivery_ref_ck" CHECK ("delivery_reference" = btrim("delivery_reference") and length("delivery_reference") > 0),
	CONSTRAINT "ccc_invitation_claim_proofs_permissions_ck" CHECK (jsonb_typeof("intended_permission_codes") = 'array' and jsonb_array_length("intended_permission_codes") between 1 and 64),
	CONSTRAINT "ccc_invitation_claim_proofs_claimant_ck" CHECK (("lifecycle" = 'ISSUED' and "claimant_principal_id" is null and "redeemed_at" is null) or ("lifecycle" in ('VERIFIED', 'CONSUMED') and "claimant_principal_id" is not null and "redeemed_at" is not null) or ("lifecycle" in ('REVOKED', 'EXPIRED'))),
	CONSTRAINT "ccc_invitation_claim_proofs_consumption_ck" CHECK (("lifecycle" = 'CONSUMED' and "consume_action_invocation_id" is not null and "attestation_reference" is not null and "consumed_at" is not null and "invalidated_at" is null) or ("lifecycle" <> 'CONSUMED' and "consume_action_invocation_id" is null and "attestation_reference" is null and "consumed_at" is null)),
	CONSTRAINT "ccc_invitation_claim_proofs_invalidation_ck" CHECK (("lifecycle" in ('REVOKED', 'EXPIRED') and "invalidated_at" is not null) or ("lifecycle" not in ('REVOKED', 'EXPIRED') and "invalidated_at" is null)),
	CONSTRAINT "ccc_invitation_claim_proofs_expiry_ck" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "ccc_invitation_claim_proofs_attestation_ck" CHECK ("attestation_reference" is null or ("attestation_reference" = btrim("attestation_reference") and length("attestation_reference") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."party_merge_profile_observations" (
	"party_merge_profile_observation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"merge_resource_id" text NOT NULL,
	"source_domain_event_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"event_version" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"policy_version" text NOT NULL,
	"survivor_party_resource_id" text NOT NULL,
	"absorbed_party_resource_ids" text[] NOT NULL,
	"outcome" text NOT NULL,
	"canonicalized_profile_id" uuid,
	"actor_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_party_merge_observations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","party_merge_profile_observation_id"),
	CONSTRAINT "ccc_party_merge_observations_version_uk" UNIQUE("tenant_id","legal_entity_id","merge_resource_id","event_version"),
	CONSTRAINT "ccc_party_merge_observations_event_uk" UNIQUE("tenant_id","legal_entity_id","source_domain_event_id"),
	CONSTRAINT "ccc_party_merge_observations_message_uk" UNIQUE("tenant_id","legal_entity_id","source_message_id"),
	CONSTRAINT "ccc_party_merge_observations_version_ck" CHECK ("event_version" > 0),
	CONSTRAINT "ccc_party_merge_observations_merge_ck" CHECK ("merge_resource_id" = btrim("merge_resource_id") and length("merge_resource_id") > 0),
	CONSTRAINT "ccc_party_merge_observations_policy_ck" CHECK ("policy_version" = btrim("policy_version") and length("policy_version") > 0),
	CONSTRAINT "ccc_party_merge_observations_survivor_ck" CHECK ("survivor_party_resource_id" = btrim("survivor_party_resource_id") and length("survivor_party_resource_id") > 0),
	CONSTRAINT "ccc_party_merge_observations_absorbed_ck" CHECK (cardinality("absorbed_party_resource_ids") > 0 and array_position("absorbed_party_resource_ids", null) is null),
	CONSTRAINT "ccc_party_merge_observations_outcome_ck" CHECK ("outcome" in ('NO_CONFLICTING_PROFILES', 'RECONCILIATIONS_OBSERVED', 'COMPLETED_NO_CHANGE'))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."party_merge_profile_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" (
	"profile_reconciliation_owner_outcome_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"profile_reconciliation_case_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"evidence_ref" text,
	"case_revision" integer NOT NULL,
	"event_version" bigint NOT NULL,
	"correlation_ref" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_reconciliation_owner_outcomes_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_owner_outcome_id"),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_revision_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_id","owner","case_revision"),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_correlation_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_id","owner","correlation_ref"),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_owner_ck" CHECK ("owner" in ('PROFILE_LIFECYCLE', 'CUSTOMER_GROUP_MEMBERSHIP', 'PRICE_GROUP_ASSIGNMENT', 'CURRENCY_PREFERENCE', 'PAYMENT_TERMS', 'ADDRESS_BOOK', 'RETAIL_PORTAL_BINDING', 'COUNTERPARTY_ACCESS', 'PURCHASE_LIMITS', 'APPROVAL', 'CONNECTOR_CORRELATION')),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_status_ck" CHECK ("status" in ('BLOCKED', 'RESOLVED', 'NOT_APPLICABLE')),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_evidence_ck" CHECK (("status" = 'BLOCKED' and ("evidence_ref" is null or length(btrim("evidence_ref")) > 0)) or ("status" in ('RESOLVED', 'NOT_APPLICABLE') and length(btrim("evidence_ref")) > 0)),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_revision_ck" CHECK ("case_revision" > 0),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_event_ck" CHECK ("event_version" >= 0),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_correlation_ck" CHECK ("correlation_ref" = btrim("correlation_ref") and length("correlation_ref") > 0),
	CONSTRAINT "ccc_reconciliation_owner_outcomes_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_reconciliation_open_pair_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_reconciliation_open_pair_uk" ON "commerce_customer_context"."profile_reconciliation_cases" ("tenant_id","legal_entity_id","source_profile_id","colliding_profile_id","merge_resource_id") WHERE "lifecycle" in ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE');--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $counterparty_profile_global_key_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "commerce_customer_context"."counterparty_purchasing_profiles"
     GROUP BY "tenant_id", "counterparty_resource_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot establish tenant-global Counterparty profile identity: duplicate Counterparty references require explicit reconciliation';
  END IF;
END
$counterparty_profile_global_key_preflight$;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" DROP CONSTRAINT "ccc_counterparty_profiles_business_key_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" ADD CONSTRAINT "ccc_counterparty_profiles_business_key_uk" UNIQUE("tenant_id","counterparty_resource_id");--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."ensure_counterparty_profile"(uuid,uuid,text,text,text,text,timestamptz,text,uuid,uuid) TO "ontos_runtime";
CREATE UNIQUE INDEX "ccc_invitation_claim_proofs_current_uk" ON "commerce_customer_context"."counterparty_invitation_claim_proofs" ("tenant_id","legal_entity_id","invitation_id") WHERE "lifecycle" in ('ISSUED', 'VERIFIED');--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" ADD CONSTRAINT "ccc_invitation_claim_attempts_invitation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","invitation_id") REFERENCES "commerce_customer_context"."counterparty_access_invitations"("tenant_id","legal_entity_id","counterparty_access_invitation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" ADD CONSTRAINT "ccc_invitation_claim_proofs_invitation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","invitation_id") REFERENCES "commerce_customer_context"."counterparty_access_invitations"("tenant_id","legal_entity_id","counterparty_access_invitation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."party_merge_profile_observations" ADD CONSTRAINT "ccc_party_merge_observations_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","canonicalized_profile_id") REFERENCES "commerce_customer_context"."retail_customer_profiles"("tenant_id","legal_entity_id","retail_customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ADD CONSTRAINT "ccc_reconciliation_owner_outcomes_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","profile_reconciliation_case_id") REFERENCES "commerce_customer_context"."profile_reconciliation_cases"("tenant_id","legal_entity_id","profile_reconciliation_case_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_attempts_scope_select" ON "commerce_customer_context"."counterparty_invitation_claim_attempts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_attempts_scope_insert" ON "commerce_customer_context"."counterparty_invitation_claim_attempts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_attempts_scope_update" ON "commerce_customer_context"."counterparty_invitation_claim_attempts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_attempts_scope_delete" ON "commerce_customer_context"."counterparty_invitation_claim_attempts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_attempts_scope_owner_routine" ON "commerce_customer_context"."counterparty_invitation_claim_attempts" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_invitation_claim_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_proofs_scope_select" ON "commerce_customer_context"."counterparty_invitation_claim_proofs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_proofs_scope_insert" ON "commerce_customer_context"."counterparty_invitation_claim_proofs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_proofs_scope_update" ON "commerce_customer_context"."counterparty_invitation_claim_proofs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_proofs_scope_delete" ON "commerce_customer_context"."counterparty_invitation_claim_proofs" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_invitation_claim_proofs_scope_owner_routine" ON "commerce_customer_context"."counterparty_invitation_claim_proofs" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_invitation_claim_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_invitation_claim_proofs"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_party_merge_observations_scope_select" ON "commerce_customer_context"."party_merge_profile_observations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_party_merge_observations_scope_insert" ON "commerce_customer_context"."party_merge_profile_observations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_party_merge_observations_scope_update" ON "commerce_customer_context"."party_merge_profile_observations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_party_merge_observations_scope_delete" ON "commerce_customer_context"."party_merge_profile_observations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_party_merge_observations_scope_owner_routine" ON "commerce_customer_context"."party_merge_profile_observations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."party_merge_profile_observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."party_merge_profile_observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_owner_outcomes_scope_select" ON "commerce_customer_context"."profile_reconciliation_owner_outcomes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_owner_outcomes_scope_insert" ON "commerce_customer_context"."profile_reconciliation_owner_outcomes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_owner_outcomes_scope_update" ON "commerce_customer_context"."profile_reconciliation_owner_outcomes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_owner_outcomes_scope_delete" ON "commerce_customer_context"."profile_reconciliation_owner_outcomes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_owner_outcomes_scope_owner_routine" ON "commerce_customer_context"."profile_reconciliation_owner_outcomes" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."profile_reconciliation_owner_outcomes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_owner_outcomes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."register_invitation_claim_proof"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_counterparty_resource_id text, p_storefront_resource_id text,
  p_intended_permission_codes text[], p_inviter_principal_id uuid,
  p_delivery_method text, p_delivery_reference text, p_expires_at timestamptz,
  p_issue_action_invocation_id uuid, p_proof_reference text,
  p_secret_digest text, p_operation text
)
RETURNS TABLE (operation_outcome text, proof_reference text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_counterparty_resource_id text;
  v_existing commerce_customer_context.counterparty_invitation_claim_proofs%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_operation NOT IN ('ISSUE', 'ROTATE')
    OR p_proof_reference IS NULL OR p_secret_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid scoped invitation proof registration' USING ERRCODE = '42501';
  END IF;

  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END IF;

  SELECT profile.counterparty_resource_id INTO v_counterparty_resource_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = v_invitation.tenant_id
    AND profile.legal_entity_id = v_invitation.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id;

  IF NOT FOUND OR v_counterparty_resource_id IS DISTINCT FROM p_counterparty_resource_id
    OR v_invitation.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id
    OR v_invitation.requested_permission_codes IS DISTINCT FROM to_jsonb(p_intended_permission_codes)
    OR v_invitation.actor_principal_id IS DISTINCT FROM p_inviter_principal_id
    OR v_invitation.delivery_method IS DISTINCT FROM p_delivery_method
    OR v_invitation.delivery_reference IS DISTINCT FROM p_delivery_reference
    OR v_invitation.expires_at IS DISTINCT FROM p_expires_at
    OR v_invitation.lifecycle <> 'PENDING' THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END IF;
  IF v_invitation.expires_at <= statement_timestamp() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, NULL::text;
    RETURN;
  END IF;

  SELECT proof.* INTO v_existing
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id
    AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id
    AND proof.issue_action_invocation_id = p_issue_action_invocation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.counterparty_resource_id IS DISTINCT FROM p_counterparty_resource_id
      OR v_existing.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id
      OR v_existing.intended_permission_codes IS DISTINCT FROM to_jsonb(p_intended_permission_codes)
      OR v_existing.inviter_principal_id IS DISTINCT FROM p_inviter_principal_id
      OR v_existing.delivery_method IS DISTINCT FROM p_delivery_method
      OR v_existing.delivery_reference IS DISTINCT FROM p_delivery_reference
      OR v_existing.expires_at IS DISTINCT FROM p_expires_at THEN
      RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    ELSE
      RETURN QUERY SELECT 'REPLAYED'::text, v_existing.proof_reference;
    END IF;
    RETURN;
  END IF;

  IF p_operation = 'ISSUE' AND EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_invitation_claim_proofs AS current_proof
    WHERE current_proof.tenant_id = p_tenant_id
      AND current_proof.legal_entity_id = p_legal_entity_id
      AND current_proof.invitation_id = p_invitation_id
      AND current_proof.lifecycle IN ('ISSUED', 'VERIFIED')
  ) THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END IF;

  IF p_operation = 'ROTATE' THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET lifecycle = 'REVOKED', invalidated_at = statement_timestamp()
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND invitation_id = p_invitation_id AND lifecycle IN ('ISSUED', 'VERIFIED');
  END IF;

  INSERT INTO commerce_customer_context.counterparty_invitation_claim_proofs (
    tenant_id, legal_entity_id, invitation_id, counterparty_resource_id,
    storefront_resource_id, proof_reference, secret_digest, proof_version,
    lifecycle, delivery_state, delivery_method, delivery_reference,
    intended_permission_codes, inviter_principal_id, issue_action_invocation_id, expires_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_invitation_id, p_counterparty_resource_id,
    p_storefront_resource_id, p_proof_reference, p_secret_digest,
    'commerce-invitation-proof.v1', 'ISSUED', 'PENDING', p_delivery_method,
    p_delivery_reference, to_jsonb(p_intended_permission_codes), p_inviter_principal_id,
    p_issue_action_invocation_id, p_expires_at
  );
  RETURN QUERY SELECT 'REGISTERED'::text, p_proof_reference;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."register_invitation_claim_proof"(uuid, uuid, uuid, text, text, text[], uuid, text, text, timestamptz, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."register_invitation_claim_proof"(uuid, uuid, uuid, text, text, text[], uuid, text, text, timestamptz, uuid, text, text, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."stage_invitation_claim_proof_delivery"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_proof_reference text, p_issue_action_invocation_id uuid
)
RETURNS TABLE (operation_outcome text, proof_reference text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_proof commerce_customer_context.counterparty_invitation_claim_proofs%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation proof delivery stage' USING ERRCODE = '42501';
  END IF;
  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.lifecycle <> 'PENDING' THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END IF;
  SELECT proof.* INTO v_proof
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id AND proof.proof_reference = p_proof_reference
    AND proof.issue_action_invocation_id = p_issue_action_invocation_id
  FOR UPDATE;
  IF NOT FOUND OR v_proof.lifecycle <> 'ISSUED'
    OR v_proof.expires_at IS DISTINCT FROM v_invitation.expires_at THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
  ELSIF v_invitation.expires_at <= statement_timestamp() THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET lifecycle = 'EXPIRED', invalidated_at = statement_timestamp()
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND counterparty_invitation_claim_proof_id = v_proof.counterparty_invitation_claim_proof_id;
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
  ELSIF v_proof.delivery_state = 'STAGED' THEN
    RETURN QUERY SELECT 'REPLAYED'::text, v_proof.proof_reference;
  ELSIF v_proof.delivery_state <> 'PENDING' THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
  ELSE
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET delivery_state = 'STAGED', delivery_attempt_count = delivery_attempt_count + 1,
        delivery_staged_at = statement_timestamp()
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND counterparty_invitation_claim_proof_id = v_proof.counterparty_invitation_claim_proof_id;
    RETURN QUERY SELECT 'STAGED'::text, v_proof.proof_reference;
  END IF;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."stage_invitation_claim_proof_delivery"(uuid, uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."stage_invitation_claim_proof_delivery"(uuid, uuid, uuid, text, uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."redeem_invitation_claim_secret"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_proof_reference text, p_secret_digest text, p_claimant_principal_id uuid
)
RETURNS TABLE (
  counterparty_resource_id text, expires_at timestamptz,
  intended_permission_codes jsonb, operation_outcome text,
  proof_reference text, storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_attempt commerce_customer_context.counterparty_invitation_claim_attempts%ROWTYPE;
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_proof commerce_customer_context.counterparty_invitation_claim_proofs%ROWTYPE;
  v_counterparty text;
  v_expires_at timestamptz;
  v_permissions jsonb;
  v_storefront text;
  v_new_count integer;
  v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_claimant_principal_id IS NULL THEN
    RAISE EXCEPTION 'invalid scoped invitation proof redemption' USING ERRCODE = '42501';
  END IF;
  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT profile.counterparty_resource_id INTO v_counterparty
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = v_invitation.tenant_id
    AND profile.legal_entity_id = v_invitation.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_expires_at := v_invitation.expires_at;
  v_permissions := v_invitation.requested_permission_codes;
  v_storefront := v_invitation.storefront_resource_id;

  INSERT INTO commerce_customer_context.counterparty_invitation_claim_attempts (
    tenant_id, legal_entity_id, invitation_id, claimant_principal_id,
    attempt_count, window_started_at, last_attempt_at, last_outcome
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_invitation_id, p_claimant_principal_id,
    0, statement_timestamp(), statement_timestamp(), 'INVALID'
  ) ON CONFLICT (tenant_id, legal_entity_id, invitation_id, claimant_principal_id) DO NOTHING;
  SELECT attempt.* INTO v_attempt
  FROM commerce_customer_context.counterparty_invitation_claim_attempts AS attempt
  WHERE attempt.tenant_id = p_tenant_id AND attempt.legal_entity_id = p_legal_entity_id
    AND attempt.invitation_id = p_invitation_id
    AND attempt.claimant_principal_id = p_claimant_principal_id
  FOR UPDATE;
  IF v_attempt.window_started_at + interval '15 minutes' <= statement_timestamp()
    AND (v_attempt.blocked_until IS NULL OR v_attempt.blocked_until <= statement_timestamp()) THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET attempt_count = 0, window_started_at = statement_timestamp(), blocked_until = NULL
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
    v_attempt.attempt_count := 0;
    v_attempt.blocked_until := NULL;
  END IF;
  IF v_attempt.blocked_until > statement_timestamp() THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET last_attempt_at = statement_timestamp(), last_outcome = 'RATE_LIMITED'
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
    RETURN QUERY SELECT v_counterparty, v_expires_at, v_permissions,
      'RATE_LIMITED'::text, NULL::text, v_storefront;
    RETURN;
  END IF;

  SELECT proof.* INTO v_proof
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id AND proof.proof_reference = p_proof_reference
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.lifecycle <> 'PENDING'
    OR v_proof.secret_digest IS DISTINCT FROM p_secret_digest
    OR v_proof.delivery_state <> 'STAGED'
    OR v_proof.lifecycle NOT IN ('ISSUED', 'VERIFIED')
    OR v_proof.counterparty_resource_id IS DISTINCT FROM v_counterparty
    OR v_proof.storefront_resource_id IS DISTINCT FROM v_storefront
    OR v_proof.intended_permission_codes IS DISTINCT FROM v_permissions
    OR v_proof.inviter_principal_id IS DISTINCT FROM v_invitation.actor_principal_id
    OR v_proof.expires_at IS DISTINCT FROM v_invitation.expires_at THEN
    v_outcome := 'INVALID';
  ELSIF v_proof.expires_at <= statement_timestamp() THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET lifecycle = 'EXPIRED', invalidated_at = statement_timestamp()
    WHERE counterparty_invitation_claim_proof_id = v_proof.counterparty_invitation_claim_proof_id;
    v_outcome := 'EXPIRED';
  ELSIF v_proof.lifecycle = 'VERIFIED' THEN
    v_outcome := CASE WHEN v_proof.claimant_principal_id = p_claimant_principal_id
      THEN 'REPLAYED' ELSE 'INVALID' END;
  ELSE
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET lifecycle = 'VERIFIED', claimant_principal_id = p_claimant_principal_id,
        redeemed_at = statement_timestamp()
    WHERE counterparty_invitation_claim_proof_id = v_proof.counterparty_invitation_claim_proof_id;
    v_outcome := 'REDEEMED';
  END IF;

  IF v_outcome = 'INVALID' THEN
    v_new_count := v_attempt.attempt_count + 1;
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET attempt_count = v_new_count, last_attempt_at = statement_timestamp(),
        last_outcome = 'INVALID',
        blocked_until = CASE WHEN v_new_count >= 5 THEN statement_timestamp() + interval '15 minutes' ELSE NULL END
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
  ELSE
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET attempt_count = 0, window_started_at = statement_timestamp(), blocked_until = NULL,
        last_attempt_at = statement_timestamp(),
        last_outcome = CASE WHEN v_outcome = 'EXPIRED' THEN 'INVALID' ELSE 'REDEEMED' END
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
  END IF;
  RETURN QUERY SELECT v_counterparty, v_expires_at, v_permissions, v_outcome,
    CASE WHEN v_outcome IN ('REDEEMED', 'REPLAYED') THEN p_proof_reference ELSE NULL END,
    v_storefront;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."redeem_invitation_claim_secret"(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."redeem_invitation_claim_secret"(uuid, uuid, uuid, text, text, uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."consume_invitation_claim_proof"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_proof_reference text, p_counterparty_resource_id text,
  p_storefront_resource_id text, p_intended_permission_codes text[],
  p_inviter_principal_id uuid, p_claimant_principal_id uuid,
  p_action_invocation_id uuid, p_attestation_reference text
)
RETURNS TABLE (attestation_reference text, operation_outcome text, verified_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_attempt commerce_customer_context.counterparty_invitation_claim_attempts%ROWTYPE;
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_proof commerce_customer_context.counterparty_invitation_claim_proofs%ROWTYPE;
  v_counterparty_resource_id text;
  v_new_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_claimant_principal_id IS NULL OR p_action_invocation_id IS NULL
    OR p_attestation_reference IS NULL THEN
    RAISE EXCEPTION 'invalid scoped invitation proof consumption' USING ERRCODE = '42501';
  END IF;
  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
    WHERE invitation.tenant_id = p_tenant_id AND invitation.legal_entity_id = p_legal_entity_id
      AND invitation.counterparty_access_invitation_id = p_invitation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT profile.counterparty_resource_id INTO v_counterparty_resource_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = v_invitation.tenant_id
    AND profile.legal_entity_id = v_invitation.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO commerce_customer_context.counterparty_invitation_claim_attempts (
    tenant_id, legal_entity_id, invitation_id, claimant_principal_id,
    attempt_count, window_started_at, last_attempt_at, last_outcome
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_invitation_id, p_claimant_principal_id,
    0, statement_timestamp(), statement_timestamp(), 'INVALID'
  ) ON CONFLICT (tenant_id, legal_entity_id, invitation_id, claimant_principal_id) DO NOTHING;
  SELECT attempt.* INTO v_attempt
  FROM commerce_customer_context.counterparty_invitation_claim_attempts AS attempt
  WHERE attempt.tenant_id = p_tenant_id AND attempt.legal_entity_id = p_legal_entity_id
    AND attempt.invitation_id = p_invitation_id
    AND attempt.claimant_principal_id = p_claimant_principal_id
  FOR UPDATE;
  IF v_attempt.window_started_at + interval '15 minutes' <= statement_timestamp()
    AND (v_attempt.blocked_until IS NULL OR v_attempt.blocked_until <= statement_timestamp()) THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET attempt_count = 0, window_started_at = statement_timestamp(), blocked_until = NULL
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
    v_attempt.attempt_count := 0;
    v_attempt.blocked_until := NULL;
  END IF;
  IF v_attempt.blocked_until > statement_timestamp() THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET last_attempt_at = statement_timestamp(), last_outcome = 'RATE_LIMITED'
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
    RETURN QUERY SELECT NULL::text, 'RATE_LIMITED'::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT proof.* INTO v_proof
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id AND proof.proof_reference = p_proof_reference
  FOR UPDATE;
  IF FOUND AND v_proof.lifecycle = 'CONSUMED' THEN
    IF v_proof.consume_action_invocation_id = p_action_invocation_id
      AND v_proof.claimant_principal_id = p_claimant_principal_id
      AND v_proof.counterparty_resource_id = p_counterparty_resource_id
      AND v_proof.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
      AND v_proof.intended_permission_codes = to_jsonb(p_intended_permission_codes)
      AND v_proof.inviter_principal_id = p_inviter_principal_id THEN
      RETURN QUERY SELECT v_proof.attestation_reference, 'REPLAYED'::text, v_proof.consumed_at;
    ELSE
      RETURN QUERY SELECT NULL::text, 'USED_BY_ANOTHER_ACTION'::text, NULL::timestamptz;
    END IF;
    RETURN;
  END IF;
  IF NOT FOUND OR v_proof.lifecycle <> 'VERIFIED'
    OR v_invitation.lifecycle NOT IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
    OR v_invitation.claimed_by_principal_id IS DISTINCT FROM p_claimant_principal_id
    OR v_counterparty_resource_id IS DISTINCT FROM p_counterparty_resource_id
    OR v_invitation.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id
    OR v_invitation.requested_permission_codes IS DISTINCT FROM to_jsonb(p_intended_permission_codes)
    OR v_invitation.actor_principal_id IS DISTINCT FROM p_inviter_principal_id
    OR v_proof.delivery_state <> 'STAGED'
    OR v_proof.claimant_principal_id IS DISTINCT FROM p_claimant_principal_id
    OR v_proof.counterparty_resource_id IS DISTINCT FROM p_counterparty_resource_id
    OR v_proof.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id
    OR v_proof.intended_permission_codes IS DISTINCT FROM to_jsonb(p_intended_permission_codes)
    OR v_proof.inviter_principal_id IS DISTINCT FROM p_inviter_principal_id THEN
    v_new_count := v_attempt.attempt_count + 1;
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET attempt_count = v_new_count, last_attempt_at = statement_timestamp(),
        last_outcome = 'INVALID',
        blocked_until = CASE WHEN v_new_count >= 5 THEN statement_timestamp() + interval '15 minutes' ELSE NULL END
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
    RETURN QUERY SELECT NULL::text, 'INVALID'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_proof.expires_at <= statement_timestamp() THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET lifecycle = 'EXPIRED', invalidated_at = statement_timestamp()
    WHERE counterparty_invitation_claim_proof_id = v_proof.counterparty_invitation_claim_proof_id;
    UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
    SET last_attempt_at = statement_timestamp(), last_outcome = 'INVALID'
    WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
    RETURN QUERY SELECT NULL::text, 'EXPIRED'::text, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
  SET lifecycle = 'CONSUMED', consume_action_invocation_id = p_action_invocation_id,
      attestation_reference = p_attestation_reference, consumed_at = statement_timestamp()
  WHERE counterparty_invitation_claim_proof_id = v_proof.counterparty_invitation_claim_proof_id;
  UPDATE commerce_customer_context.counterparty_invitation_claim_attempts
  SET attempt_count = 0, window_started_at = statement_timestamp(), blocked_until = NULL,
      last_attempt_at = statement_timestamp(), last_outcome = 'CONSUMED'
  WHERE counterparty_invitation_claim_attempt_id = v_attempt.counterparty_invitation_claim_attempt_id;
  RETURN QUERY SELECT p_attestation_reference, 'CONSUMED'::text, statement_timestamp();
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."consume_invitation_claim_proof"(uuid, uuid, uuid, text, text, text, text[], uuid, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."consume_invitation_claim_proof"(uuid, uuid, uuid, text, text, text, text[], uuid, uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."invalidate_invitation_claim_proofs"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF NEW.lifecycle IN ('REVOKED', 'EXPIRED', 'CLAIMED')
    AND NEW.lifecycle IS DISTINCT FROM OLD.lifecycle THEN
    UPDATE commerce_customer_context.counterparty_invitation_claim_proofs
    SET lifecycle = CASE WHEN NEW.lifecycle = 'EXPIRED' THEN 'EXPIRED' ELSE 'REVOKED' END,
        invalidated_at = statement_timestamp()
    WHERE tenant_id = NEW.tenant_id
      AND legal_entity_id = NEW.legal_entity_id
      AND invitation_id = NEW.counterparty_access_invitation_id
      AND lifecycle IN ('ISSUED', 'VERIFIED');
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."invalidate_invitation_claim_proofs"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "ccc_invitation_claim_proofs_lifecycle_trg"
AFTER UPDATE OF lifecycle ON "commerce_customer_context"."counterparty_access_invitations"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."invalidate_invitation_claim_proofs"();
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."party_merge_profile_observations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "commerce_customer_context"."party_merge_profile_observations" FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "ccc_party_merge_observations_append_only_trg"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."party_merge_profile_observations"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();
CREATE TRIGGER "ccc_reconciliation_owner_outcomes_append_only_trg"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."profile_reconciliation_owner_outcomes"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();
--> statement-breakpoint
DO $hardening$
DECLARE
  protected_relation text;
BEGIN
  FOREACH protected_relation IN ARRAY ARRAY[
    'commerce_customer_context.counterparty_invitation_claim_attempts',
    'commerce_customer_context.counterparty_invitation_claim_proofs',
    'commerce_customer_context.party_merge_profile_observations',
    'commerce_customer_context.profile_reconciliation_owner_outcomes'
  ] LOOP
    IF has_table_privilege('ontos_runtime', protected_relation, 'SELECT')
       OR has_table_privilege('ontos_runtime', protected_relation, 'INSERT')
       OR has_table_privilege('ontos_runtime', protected_relation, 'UPDATE')
       OR has_table_privilege('ontos_runtime', protected_relation, 'DELETE')
       OR has_table_privilege('public', protected_relation, 'SELECT')
       OR has_table_privilege('public', protected_relation, 'INSERT')
       OR has_table_privilege('public', protected_relation, 'UPDATE')
       OR has_table_privilege('public', protected_relation, 'DELETE') THEN
      RAISE EXCEPTION 'Direct runtime/public privilege leaked on %', protected_relation;
    END IF;
  END LOOP;
END
$hardening$;
--> statement-breakpoint
-- Reinstall the fail-closed prefix definitions only after their checkpoint tables exist.
DO $reinstall_profile_routines$
DECLARE
  routine_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'commerce_customer_context.observe_party_merge_reconciliation(uuid,uuid,text,uuid,uuid,bigint,timestamptz,text,text,text[],jsonb,uuid)'::regprocedure
  ) INTO routine_definition;
  EXECUTE routine_definition;

  SELECT pg_get_functiondef(
    'commerce_customer_context.record_profile_reconciliation_owner_outcome(uuid,uuid,uuid,uuid,text,text,text,text,integer,bigint,text,timestamptz,text,uuid,uuid)'::regprocedure
  ) INTO routine_definition;
  EXECUTE routine_definition;
END
$reinstall_profile_routines$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."observe_party_merge_reconciliation"(uuid,uuid,text,uuid,uuid,bigint,timestamptz,text,text,text[],jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_profile_reconciliation_owner_outcome"(uuid,uuid,uuid,uuid,text,text,text,text,integer,bigint,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."ensure_retail_profile"(uuid,uuid,text,text,text,timestamptz,text,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_profile_reconciliation"(uuid,uuid,uuid) TO "ontos_runtime";
