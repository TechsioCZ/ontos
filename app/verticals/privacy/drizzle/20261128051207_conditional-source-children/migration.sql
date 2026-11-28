-- This PR introduces the admissions ledger on main. Never silently promote a pre-protocol CHILD in an existing installation.
-- Abort without altering data: that installation needs a separately verified historical reconciliation before cutover.
LOCK TABLE "privacy"."source_processing_admissions" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "privacy"."source_processing_admissions" WHERE role = 'CHILD') THEN
    RAISE EXCEPTION 'Unverified pre-protocol CHILD admissions: reconcile their native job receipts before cutover';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" DROP CONSTRAINT "privacy_source_admissions_source_uk";--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ADD COLUMN "symmy_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ADD COLUMN "symmy_preparation_id" uuid;--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ADD COLUMN "symmy_principal_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_source_admissions_source_uk" ON "privacy"."source_processing_admissions" ("tenant_id","legal_entity_id","source_identity_key") WHERE "symmy_invocation_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_source_admissions_candidate_uk" ON "privacy"."source_processing_admissions" ("tenant_id","legal_entity_id","source_identity_key","symmy_invocation_id","symmy_preparation_id");--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ADD CONSTRAINT "privacy_source_admissions_candidate_ck" CHECK (("role" = 'SUBJECT' and "symmy_invocation_id" is null and "symmy_preparation_id" is null and "symmy_principal_id" is null) or ("role" = 'CHILD' and "symmy_invocation_id" is not null and "symmy_preparation_id" is not null and "symmy_principal_id" is not null));