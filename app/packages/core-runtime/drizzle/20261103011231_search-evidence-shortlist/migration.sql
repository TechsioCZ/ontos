-- Additive shortlist only: existing rows and old writers remain eligible for exact fallback.
-- Never relocate an existing extension or alter owner/RLS/role grants.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm' AND n.nspname <> 'public'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'pg_trgm must already reside in public';
  END IF;
END
$$;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    JOIN pg_catalog.pg_depend d ON d.refclassid = 'pg_catalog.pg_extension'::regclass
      AND d.refobjid = e.oid AND d.deptype = 'e'
    JOIN pg_catalog.pg_opclass c ON d.classid = 'pg_catalog.pg_opclass'::regclass AND d.objid = c.oid
    JOIN pg_catalog.pg_am a ON a.oid = c.opcmethod
    WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
      AND c.opcnamespace = n.oid AND c.opcname = 'gin_trgm_ops'
      AND c.opcintype = 'pg_catalog.text'::regtype AND a.amname = 'gin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'public.pg_trgm GIN text operator class is incompatible';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "core"."search_index_entries" ADD COLUMN "search_text_v1" text;--> statement-breakpoint
ALTER TABLE "core"."search_index_entries" ADD COLUMN "search_format_version" integer;--> statement-breakpoint
ALTER TABLE "core"."search_index_entries" ADD COLUMN "search_source_version" bigint;--> statement-breakpoint
CREATE INDEX "core_search_index_entries_text_v1_idx" ON "core"."search_index_entries" USING gin ("search_text_v1" public.gin_trgm_ops) WHERE "deleted" = false and "search_format_version" = 1;