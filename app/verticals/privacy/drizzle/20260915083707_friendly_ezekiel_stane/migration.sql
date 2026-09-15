ALTER TABLE "privacy"."purpose_versions" ADD COLUMN "required_consent_dimensions" jsonb DEFAULT '[]' NOT NULL;
ALTER TABLE "privacy"."purpose_versions" ADD COLUMN "material_scope" jsonb;
