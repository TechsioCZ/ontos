ALTER TABLE "privacy"."processing_activities" ALTER COLUMN "processing_activity_id" SET DATA TYPE text USING "processing_activity_id"::text;--> statement-breakpoint
ALTER TABLE "privacy"."processing_activities" ALTER COLUMN "processing_activity_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "privacy"."processing_activity_lifecycle_events" ALTER COLUMN "processing_activity_id" SET DATA TYPE text USING "processing_activity_id"::text;
--> statement-breakpoint
ALTER TABLE "privacy"."anti_resurrection_protections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."consent_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_cases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_owner_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."notice_provisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."notice_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."owner_execution_outcomes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."privacy_measure_dispatches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."privacy_subjects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."processing_activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."processing_activity_lifecycle_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."processing_purposes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."purpose_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "privacy"."reject_immutable_ledger_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'privacy immutable ledger % does not allow %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "privacy_consent_decisions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."consent_decisions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_disposition_decisions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."disposition_decisions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_notice_provisions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."notice_provisions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_notice_versions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."notice_versions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_owner_execution_outcomes_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."owner_execution_outcomes"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_processing_activity_lifecycle_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."processing_activity_lifecycle_events"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_purpose_versions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."purpose_versions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
  "privacy"."consent_decisions",
  "privacy"."disposition_decisions",
  "privacy"."notice_provisions",
  "privacy"."notice_versions",
  "privacy"."owner_execution_outcomes",
  "privacy"."processing_activity_lifecycle_events",
  "privacy"."purpose_versions"
FROM "ontos_runtime";
