CREATE TABLE "pricing"."zero_floor_governance_approvals" (
	"zero_floor_governance_approval_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"approval_evidence_ref" text NOT NULL,
	"approval_revision" text NOT NULL,
	"authorization_fingerprint" text NOT NULL,
	"approval_evidence" jsonb NOT NULL,
	"approved_by_principal_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"action_invocation_id" text NOT NULL,
	CONSTRAINT "pricing_zero_floor_governance_approvals_ref_revision_uk" UNIQUE("tenant_id","legal_entity_id","approval_evidence_ref","approval_revision"),
	CONSTRAINT "pricing_zero_floor_governance_approvals_fingerprint_uk" UNIQUE("tenant_id","legal_entity_id","authorization_fingerprint","approval_revision"),
	CONSTRAINT "pricing_zero_floor_governance_approvals_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_zero_floor_governance_approvals_fingerprint_ck" CHECK ("authorization_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_zero_floor_governance_approvals_payload_ck" CHECK (jsonb_typeof("approval_evidence") = 'object'),
	CONSTRAINT "pricing_zero_floor_governance_approvals_validity_ck" CHECK ("valid_until" > "valid_from")
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_governance_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_schedule_acknowledgements" (
	"zero_floor_schedule_acknowledgement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"authorization_ref" text NOT NULL,
	"fingerprint" text NOT NULL,
	"proposed_payload_fingerprint" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"issued_by_principal_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	CONSTRAINT "pricing_zero_floor_schedule_acknowledgements_fingerprint_uk" UNIQUE("tenant_id","fingerprint"),
	CONSTRAINT "pricing_zero_floor_schedule_acknowledgements_fingerprint_ck" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_zero_floor_schedule_acknowledgements_payload_fingerprint_ck" CHECK ("proposed_payload_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_zero_floor_schedule_acknowledgements_payload_ck" CHECK (jsonb_typeof("acknowledgement") = 'object' and "acknowledgement"->>'fingerprint' = "fingerprint"),
	CONSTRAINT "pricing_zero_floor_schedule_acknowledgements_validity_ck" CHECK ("valid_until" > "issued_at")
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_schedule_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_governance_approvals_scope_select" ON "pricing"."zero_floor_governance_approvals" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_governance_approvals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_governance_approvals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_governance_approvals_scope_insert" ON "pricing"."zero_floor_governance_approvals" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_governance_approvals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_governance_approvals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_governance_approvals_scope_update" ON "pricing"."zero_floor_governance_approvals" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_governance_approvals_scope_delete" ON "pricing"."zero_floor_governance_approvals" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_schedule_acknowledgements_scope_select" ON "pricing"."zero_floor_schedule_acknowledgements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_schedule_acknowledgements_scope_insert" ON "pricing"."zero_floor_schedule_acknowledgements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_schedule_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_schedule_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_schedule_acknowledgements_scope_update" ON "pricing"."zero_floor_schedule_acknowledgements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_schedule_acknowledgements_scope_delete" ON "pricing"."zero_floor_schedule_acknowledgements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);