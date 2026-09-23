-- Drizzle owns tenant policies; FORCE RLS is the owner boundary even for table owners.
ALTER TABLE "catalog"."product_attribute_applicability" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_attribute_applicability_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Applicability revisions are evidence, never a mutable cache.
CREATE TRIGGER "catalog_product_attribute_applicability_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_attribute_applicability_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
