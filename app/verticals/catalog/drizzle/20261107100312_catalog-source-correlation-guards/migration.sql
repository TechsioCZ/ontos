-- Custom SQL migration file, put your code below! --
ALTER TABLE "catalog"."catalog_source_correlations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_source_correlations_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."catalog_source_correlations"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
