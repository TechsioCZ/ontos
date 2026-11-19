-- Move the declared placeholders from the immutable Template Type onto each Template Revision: a change in meaning is a
-- new revision, so a revision declares its own placeholders and the Type keeps identity only. Existing revisions inherit
-- the declaration of their Type; row-level security is lifted for the owner only while that copy runs.
ALTER TABLE "communications"."template_revisions" ADD COLUMN "optional_placeholders" jsonb;--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ADD COLUMN "required_placeholders" jsonb;--> statement-breakpoint
ALTER TABLE "communications"."template_types" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "communications"."template_revisions" AS r SET "optional_placeholders" = t."optional_placeholders", "required_placeholders" = t."required_placeholders" FROM "communications"."template_types" AS t WHERE t."tenant_id" = r."tenant_id" AND t."template_type_id" = r."template_type_id";--> statement-breakpoint
ALTER TABLE "communications"."template_types" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ALTER COLUMN "optional_placeholders" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ALTER COLUMN "required_placeholders" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "communications"."template_types" DROP COLUMN "optional_placeholders";--> statement-breakpoint
ALTER TABLE "communications"."template_types" DROP COLUMN "required_placeholders";--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ADD CONSTRAINT "communications_template_revisions_type_identity_uk" UNIQUE("tenant_id","revision_id","template_type_id");--> statement-breakpoint
ALTER TABLE "communications"."template_types" ADD CONSTRAINT "communications_template_types_scope_identity_uk" UNIQUE("tenant_id","template_type_id","scope_key");--> statement-breakpoint
ALTER TABLE "communications"."template_activations" DROP CONSTRAINT "communications_template_activations_revision_fk", ADD CONSTRAINT "communications_template_activations_revision_fk" FOREIGN KEY ("tenant_id","revision_id","template_type_id") REFERENCES "communications"."template_revisions"("tenant_id","revision_id","template_type_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."template_activations" DROP CONSTRAINT "communications_template_activations_type_fk", ADD CONSTRAINT "communications_template_activations_type_fk" FOREIGN KEY ("tenant_id","template_type_id","scope_key") REFERENCES "communications"."template_types"("tenant_id","template_type_id","scope_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."template_activations" ADD CONSTRAINT "communications_template_activations_scope_ck" CHECK (("scope_key" = 'tenant' and "legal_entity_id" is null) or ("legal_entity_id" is not null and "scope_key" = 'legal-entity:' || "legal_entity_id"::text));--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ADD CONSTRAINT "communications_template_revisions_placeholders_ck" CHECK (jsonb_typeof("required_placeholders") = 'array' and jsonb_typeof("optional_placeholders") = 'array' and jsonb_typeof("placeholders_used") = 'array');