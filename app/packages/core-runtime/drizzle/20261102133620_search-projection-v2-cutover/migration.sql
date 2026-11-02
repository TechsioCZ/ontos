-- Core Search v2 stores exact terms. Legacy normalized bodies cannot recover those terms.
-- Retire only projection rows; retain source identity, projection versions and rebuild floors.
-- The active-row constraint also fences old v1 writers during the deploy cutover.
DO $cutover$
DECLARE
  current_document_check text;
  legacy_document_check text;
  v2_document_check text;
BEGIN
  IF to_regclass('"core"."search_index_entries"') IS NULL
     OR to_regclass('"core"."search_projection_generations"') IS NULL
     OR to_regclass('"core"."search_projection_rebuilds"') IS NULL THEN
    RAISE EXCEPTION 'Core Search v2 cutover requires the existing projection tables' USING ERRCODE = '55000';
  END IF;

  LOCK TABLE "core"."search_projection_generations",
             "core"."search_projection_rebuilds",
             "core"."search_index_entries" IN ACCESS EXCLUSIVE MODE;

  IF row_security_active('"core"."search_index_entries"'::regclass) THEN
    RAISE EXCEPTION 'Core Search v2 cutover requires unfiltered migration-owner access' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid IN ('"core"."search_index_entries"'::regclass,
                      '"core"."search_projection_generations"'::regclass,
                      '"core"."search_projection_rebuilds"'::regclass)
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Core Search v2 cutover refuses unexpected projection triggers' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('search_index_entry_id', 'uuid', true),
      ('tenant_id', 'uuid', true),
      ('legal_entity_id', 'uuid', false),
      ('source_module_key', 'text', true),
      ('source_resource_type', 'text', true),
      ('source_resource_id', 'text', true),
      ('title', 'text', true),
      ('body_text', 'text', true),
      ('deleted', 'boolean', true),
      ('facets_json', 'jsonb', true),
      ('projection_version', 'bigint', true),
      ('created_at', 'timestamp with time zone', true),
      ('updated_at', 'timestamp with time zone', true)
    ) AS expected(name, type_name, required)
    LEFT JOIN pg_attribute actual
      ON actual.attrelid = '"core"."search_index_entries"'::regclass
     AND actual.attname = expected.name
     AND actual.attnum > 0 AND NOT actual.attisdropped
    WHERE actual.attname IS NULL
       OR format_type(actual.atttypid, actual.atttypmod) <> expected.type_name
       OR actual.attnotnull <> expected.required
  ) THEN
    RAISE EXCEPTION 'Core Search v2 cutover refuses an unexpected projection row shape' USING ERRCODE = '55000';
  END IF;

  -- Let PostgreSQL normalize both expressions. Do not depend on hand-formatted deparser output.
  CREATE TEMP TABLE ontos_search_v2_expected (
    deleted boolean, title text, body_text text, facets_json jsonb,
    CONSTRAINT legacy_document CHECK (
      deleted OR (length(btrim(title)) > 0 AND length(title) <= 300 AND length(body_text) <= 40000)
    ),
    CONSTRAINT v2_document CHECK (
      deleted OR (coalesce(facets_json->'schemaVersion' = '"2"'::jsonb, false)
        AND length(btrim(title)) > 0 AND length(title) <= 300 AND length(body_text) <= 10818202)
    )
  ) ON COMMIT DROP;
  SELECT pg_get_expr(conbin, conrelid) INTO legacy_document_check
    FROM pg_constraint WHERE conrelid = 'pg_temp.ontos_search_v2_expected'::regclass AND conname = 'legacy_document';
  SELECT pg_get_expr(conbin, conrelid) INTO v2_document_check
    FROM pg_constraint WHERE conrelid = 'pg_temp.ontos_search_v2_expected'::regclass AND conname = 'v2_document';
  SELECT pg_get_expr(conbin, conrelid) INTO current_document_check
    FROM pg_constraint
    WHERE conrelid = '"core"."search_index_entries"'::regclass
      AND conname = 'core_search_index_entries_document_ck' AND contype = 'c' AND convalidated;
  IF current_document_check IS NULL
     OR current_document_check NOT IN (legacy_document_check, v2_document_check) THEN
    RAISE EXCEPTION 'Core Search v2 cutover requires the exact reviewed document constraint' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "core"."search_index_entries"
    WHERE projection_version <= 0
       OR (NOT deleted AND NOT coalesce(facets_json->'schemaVersion' IN ('"1"'::jsonb, '"2"'::jsonb), false))
  ) OR EXISTS (
    SELECT 1 FROM "core"."search_projection_generations" WHERE generation <= 0
  ) OR EXISTS (
    SELECT 1 FROM "core"."search_projection_rebuilds"
    WHERE rebuild_version <= 0 OR fingerprint !~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION 'Core Search v2 cutover refuses unknown payloads or invalid ordering evidence' USING ERRCODE = '55000';
  END IF;

  UPDATE "core"."search_index_entries"
  SET deleted = true, title = '', body_text = '', facets_json = '{"schemaVersion":"2"}'::jsonb,
      legal_entity_id = NULL, updated_at = now()
  WHERE facets_json->'schemaVersion' = '"1"'::jsonb;

  IF current_document_check <> v2_document_check THEN
    ALTER TABLE "core"."search_index_entries"
      DROP CONSTRAINT "core_search_index_entries_document_ck",
      ADD CONSTRAINT "core_search_index_entries_document_ck" CHECK (
        deleted OR (coalesce(facets_json->'schemaVersion' = '"2"'::jsonb, false)
          AND length(btrim(title)) > 0 AND length(title) <= 300 AND length(body_text) <= 10818202)
      );
  END IF;
END
$cutover$;
