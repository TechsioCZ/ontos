CREATE TABLE "commerce_customer_context"."address_book_reconciliation_receipts" (
	"address_book_reconciliation_receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"profile_reconciliation_case_id" uuid NOT NULL,
	"survivor_profile_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"terminal_status" text NOT NULL,
	"member_profile_ids" uuid[] NOT NULL,
	"case_revision_at_receipt" integer NOT NULL,
	"event_version" bigint NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"policy_version" text NOT NULL,
	"resulting_state" text NOT NULL,
	"before_facts_sha256" text NOT NULL,
	"after_facts_sha256" text NOT NULL,
	"postcondition_sha256" text NOT NULL,
	"owner_decision_ref" text,
	"evidence_ref" text NOT NULL,
	"correlation_ref" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_address_reconciliation_receipts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","address_book_reconciliation_receipt_id"),
	CONSTRAINT "ccc_address_reconciliation_receipts_action_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_id","action_invocation_id"),
	CONSTRAINT "ccc_address_reconciliation_receipts_evidence_uk" UNIQUE("tenant_id","legal_entity_id","evidence_ref"),
	CONSTRAINT "ccc_address_reconciliation_receipts_disposition_ck" CHECK ("disposition" in ('EXPLICIT_RECONCILIATION', 'ALREADY_SATISFIED', 'NOT_APPLICABLE')),
	CONSTRAINT "ccc_address_reconciliation_receipts_status_ck" CHECK (("disposition" = 'NOT_APPLICABLE' and "terminal_status" = 'NOT_APPLICABLE') or ("disposition" <> 'NOT_APPLICABLE' and "terminal_status" = 'RESOLVED')),
	CONSTRAINT "ccc_address_reconciliation_receipts_members_ck" CHECK (cardinality("member_profile_ids") >= 2 and array_position("member_profile_ids", null) is null and "survivor_profile_id" = any("member_profile_ids")),
	CONSTRAINT "ccc_address_reconciliation_receipts_revision_ck" CHECK ("case_revision_at_receipt" > 0),
	CONSTRAINT "ccc_address_reconciliation_receipts_event_ck" CHECK ("event_version" >= 0),
	CONSTRAINT "ccc_address_reconciliation_receipts_hashes_ck" CHECK ("before_facts_sha256" ~ '^[0-9a-f]{64}$' and "after_facts_sha256" ~ '^[0-9a-f]{64}$' and "postcondition_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccc_address_reconciliation_receipts_decision_ck" CHECK (("disposition" = 'EXPLICIT_RECONCILIATION' and length(btrim("owner_decision_ref")) > 0) or ("disposition" <> 'EXPLICIT_RECONCILIATION' and "owner_decision_ref" is null)),
	CONSTRAINT "ccc_address_reconciliation_receipts_state_ck" CHECK ("resulting_state" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
	CONSTRAINT "ccc_address_reconciliation_receipts_policy_ck" CHECK ("policy_version" = btrim("policy_version") and length("policy_version") > 0),
	CONSTRAINT "ccc_address_reconciliation_receipts_evidence_ck" CHECK ("evidence_ref" = btrim("evidence_ref") and length("evidence_ref") > 0),
	CONSTRAINT "ccc_address_reconciliation_receipts_correlation_ck" CHECK ("correlation_ref" = btrim("correlation_ref") and length("correlation_ref") > 0),
	CONSTRAINT "ccc_address_reconciliation_receipts_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."address_book_reconciliation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ADD COLUMN "survivor_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ADD COLUMN "resulting_state" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "commerce_customer_context"."profile_reconciliation_owner_outcomes" receipt
   SET "survivor_profile_id"=reconciliation."canonical_profile_id",
       "resulting_state"=reconciliation."resulting_state"
  FROM "commerce_customer_context"."profile_reconciliation_cases" reconciliation
 WHERE reconciliation."tenant_id"=receipt."tenant_id"
   AND reconciliation."legal_entity_id"=receipt."legal_entity_id"
   AND reconciliation."profile_reconciliation_case_id"=receipt."profile_reconciliation_case_id"
   AND reconciliation."lifecycle"='COMPLETED';--> statement-breakpoint
DO $profile_owner_receipt_target_backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "commerce_customer_context"."profile_reconciliation_owner_outcomes"
     WHERE "survivor_profile_id" IS NULL OR "resulting_state" IS NULL
  ) THEN
    RAISE EXCEPTION 'Incomplete legacy reconciliation owner outcomes require an explicit survivor/state migration decision';
  END IF;
END
$profile_owner_receipt_target_backfill$;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ALTER COLUMN "survivor_profile_id" SET NOT NULL;
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ALTER COLUMN "resulting_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."address_book_reconciliation_receipts" ADD CONSTRAINT "ccc_address_reconciliation_receipts_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","profile_reconciliation_case_id") REFERENCES "commerce_customer_context"."profile_reconciliation_cases"("tenant_id","legal_entity_id","profile_reconciliation_case_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."address_book_reconciliation_receipts" ADD CONSTRAINT "ccc_address_reconciliation_receipts_survivor_fk" FOREIGN KEY ("tenant_id","legal_entity_id","survivor_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ADD CONSTRAINT "ccc_reconciliation_owner_outcomes_survivor_fk" FOREIGN KEY ("tenant_id","legal_entity_id","survivor_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" ADD CONSTRAINT "ccc_reconciliation_owner_outcomes_resulting_state_ck" CHECK ("resulting_state" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED'));--> statement-breakpoint
CREATE POLICY "ccc_address_reconciliation_receipts_scope_select" ON "commerce_customer_context"."address_book_reconciliation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_reconciliation_receipts_scope_insert" ON "commerce_customer_context"."address_book_reconciliation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_reconciliation_receipts_scope_update" ON "commerce_customer_context"."address_book_reconciliation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_reconciliation_receipts_scope_delete" ON "commerce_customer_context"."address_book_reconciliation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_reconciliation_receipts_scope_owner_routine" ON "commerce_customer_context"."address_book_reconciliation_receipts" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."address_book_reconciliation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."address_book_reconciliation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_profile_reconciliation_owner_outcome"(uuid,uuid,uuid,uuid,text,text,text,text,integer,bigint,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."reconcile_profile_reconciliation_owner"(uuid,uuid,uuid,text,uuid,text,text,integer,bigint,timestamptz,text,uuid,uuid) FROM PUBLIC;
