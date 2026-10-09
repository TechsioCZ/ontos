CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_catalog_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_compatibility_support" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_effective_intervals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_retirements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_effective_intervals"
ADD CONSTRAINT "price_group_catalog_intervals_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "price_group_id" WITH =,
  "schedule_catalog_revision" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
);
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."reject_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."enforce_catalog_fence"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  current_revision bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.tenant_id::text, 334));

  SELECT coalesce(max(ledger.catalog_revision), 0)
    INTO current_revision
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
   WHERE ledger.tenant_id = NEW.tenant_id;

  IF NEW.expected_catalog_revision <> current_revision
    OR NEW.catalog_revision <> current_revision + 1 THEN
    RAISE EXCEPTION 'stale Price Group catalog revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'price_group_catalog_ledger_fence_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."guard_price_group_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  schedule_operation text;
  schedule_group_id uuid;
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.price_group_id IS DISTINCT FROM NEW.price_group_id
    OR OLD.business_code IS DISTINCT FROM NEW.business_code
    OR OLD.meaning_fingerprint IS DISTINCT FROM NEW.meaning_fingerprint
    OR OLD.classification_purpose IS DISTINCT FROM NEW.classification_purpose
    OR OLD.active_from IS DISTINCT FROM NEW.active_from
    OR OLD.created_at_catalog_revision IS DISTINCT FROM NEW.created_at_catalog_revision
    OR OLD.created_by_action_invocation_id IS DISTINCT FROM NEW.created_by_action_invocation_id
    OR OLD.created_by_principal_id IS DISTINCT FROM NEW.created_by_principal_id
    OR OLD.creation_reason IS DISTINCT FROM NEW.creation_reason
    OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION 'Price Group identity and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle_state = 'RETIRED'
    AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
      OR NEW.retired_effective_at IS DISTINCT FROM OLD.retired_effective_at) THEN
    RAISE EXCEPTION 'RETIRED Price Group is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.current_definition_schedule_revision IS DISTINCT FROM OLD.current_definition_schedule_revision THEN
    IF NEW.current_definition_schedule_revision <= OLD.current_definition_schedule_revision THEN
      RAISE EXCEPTION 'Price Group definition schedule revision must advance'
        USING ERRCODE = '23514';
    END IF;
    SELECT ledger.operation_kind, ledger.price_group_id
      INTO schedule_operation, schedule_group_id
      FROM price_group_catalog.price_group_catalog_ledger AS ledger
     WHERE ledger.tenant_id = NEW.tenant_id
       AND ledger.catalog_revision = NEW.current_definition_schedule_revision;
    IF schedule_operation <> 'CREATE_DEFINITION_REVISION'
      OR schedule_group_id <> NEW.price_group_id THEN
      RAISE EXCEPTION 'Price Group schedule must bind its exact revision ledger entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.lifecycle_state = 'ACTIVE' THEN
    IF NEW.retired_effective_at IS NOT NULL THEN
      RAISE EXCEPTION 'ACTIVE Price Group cannot carry retirement evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.lifecycle_state = 'RETIRED' THEN
    IF NEW.retired_effective_at IS NULL THEN
      RAISE EXCEPTION 'RETIRED Price Group requires an effective instant'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported Price Group lifecycle transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."guard_definition_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  accepted_operation text;
  accepted_group_id uuid;
  accepted_definition_id uuid;
  accepted_trusted_at timestamptz;
  group_state text;
  retirement_at timestamptz;
  predecessor_revision bigint;
BEGIN
  SELECT ledger.operation_kind, ledger.price_group_id, ledger.definition_revision_id,
         ledger.trusted_effective_at
    INTO accepted_operation, accepted_group_id, accepted_definition_id, accepted_trusted_at
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
   WHERE ledger.tenant_id = NEW.tenant_id
     AND ledger.catalog_revision = NEW.accepted_catalog_revision;

  IF accepted_operation NOT IN ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION')
    OR accepted_group_id <> NEW.price_group_id
    OR accepted_definition_id <> NEW.definition_revision_id THEN
    RAISE EXCEPTION 'Definition Revision must bind its exact catalog ledger entry'
      USING ERRCODE = '23514';
  END IF;

  SELECT price_group.lifecycle_state, price_group.retired_effective_at
    INTO group_state, retirement_at
    FROM price_group_catalog.price_groups AS price_group
   WHERE price_group.tenant_id = NEW.tenant_id
     AND price_group.price_group_id = NEW.price_group_id;
  IF group_state = 'RETIRED' AND accepted_trusted_at >= retirement_at THEN
    RAISE EXCEPTION 'Definition Revision cannot be accepted at or after the retirement boundary'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.revision_number > 1 THEN
    SELECT predecessor.revision_number
      INTO predecessor_revision
      FROM price_group_catalog.price_group_definition_revisions AS predecessor
     WHERE predecessor.tenant_id = NEW.tenant_id
       AND predecessor.price_group_id = NEW.price_group_id
       AND predecessor.definition_revision_id = NEW.previous_definition_revision_id;
    IF predecessor_revision IS NULL OR predecessor_revision <> NEW.revision_number - 1 THEN
      RAISE EXCEPTION 'Definition Revision predecessor must be the exact prior business revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."guard_interval_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  schedule_operation text;
  schedule_group_id uuid;
  retirement_at timestamptz;
  group_state text;
BEGIN
  SELECT ledger.operation_kind, ledger.price_group_id
    INTO schedule_operation, schedule_group_id
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
   WHERE ledger.tenant_id = NEW.tenant_id
     AND ledger.catalog_revision = NEW.schedule_catalog_revision;
  IF schedule_operation NOT IN ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION')
    OR schedule_group_id <> NEW.price_group_id THEN
    RAISE EXCEPTION 'Definition effective interval must bind an exact schedule ledger entry'
      USING ERRCODE = '23514';
  END IF;

  SELECT price_group.lifecycle_state, price_group.retired_effective_at
    INTO group_state, retirement_at
    FROM price_group_catalog.price_groups AS price_group
   WHERE price_group.tenant_id = NEW.tenant_id
     AND price_group.price_group_id = NEW.price_group_id;
  IF group_state = 'RETIRED'
    AND (NEW.effective_from >= retirement_at
      OR NEW.effective_to IS NULL
      OR NEW.effective_to > retirement_at) THEN
    RAISE EXCEPTION 'Definition effective interval cannot reopen a retired Price Group'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."guard_retirement_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  accepted_expected_revision bigint;
  accepted_operation text;
  accepted_group_id uuid;
  accepted_definition_id uuid;
  accepted_trusted_at timestamptz;
  current_schedule_revision bigint;
  current_definition_count integer;
BEGIN
  SELECT ledger.expected_catalog_revision,
         ledger.operation_kind,
         ledger.price_group_id,
         ledger.definition_revision_id,
         ledger.trusted_effective_at
    INTO accepted_expected_revision,
         accepted_operation,
         accepted_group_id,
         accepted_definition_id,
         accepted_trusted_at
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
   WHERE ledger.tenant_id = NEW.tenant_id
     AND ledger.catalog_revision = NEW.accepted_catalog_revision;

  IF accepted_operation <> 'RETIRE_PRICE_GROUP'
    OR accepted_expected_revision <> NEW.expected_catalog_revision
    OR accepted_group_id <> NEW.price_group_id
    OR accepted_definition_id <> NEW.current_definition_revision_id
    OR accepted_trusted_at > NEW.effective_at THEN
    RAISE EXCEPTION 'Retirement evidence must bind its exact catalog fence and Current definition'
      USING ERRCODE = '23514';
  END IF;

  SELECT price_group.current_definition_schedule_revision
    INTO current_schedule_revision
    FROM price_group_catalog.price_groups AS price_group
   WHERE price_group.tenant_id = NEW.tenant_id
     AND price_group.price_group_id = NEW.price_group_id
     AND price_group.lifecycle_state = 'ACTIVE';

  SELECT count(*)::integer
    INTO current_definition_count
    FROM price_group_catalog.price_group_definition_effective_intervals AS interval
   WHERE interval.tenant_id = NEW.tenant_id
     AND interval.price_group_id = NEW.price_group_id
     AND interval.schedule_catalog_revision = current_schedule_revision
     AND interval.definition_revision_id = NEW.current_definition_revision_id
     AND interval.effective_from <= NEW.effective_at
     AND (interval.effective_to IS NULL OR NEW.effective_at < interval.effective_to);

  IF current_definition_count <> 1 THEN
    RAISE EXCEPTION 'Retirement requires exactly one authoritative Current Definition Revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."verify_retirement_consistency"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  group_state text;
  group_retirement_at timestamptz;
  evidence_retirement_at timestamptz;
BEGIN
  SELECT price_group.lifecycle_state, price_group.retired_effective_at
    INTO group_state, group_retirement_at
    FROM price_group_catalog.price_groups AS price_group
   WHERE price_group.tenant_id = NEW.tenant_id
     AND price_group.price_group_id = NEW.price_group_id;

  SELECT retirement.effective_at
    INTO evidence_retirement_at
    FROM price_group_catalog.price_group_retirements AS retirement
   WHERE retirement.tenant_id = NEW.tenant_id
     AND retirement.price_group_id = NEW.price_group_id;

  IF group_state = 'RETIRED' AND evidence_retirement_at IS DISTINCT FROM group_retirement_at THEN
    RAISE EXCEPTION 'terminal retirement state and evidence must agree'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'price_group_retirements' THEN
    IF group_state <> 'RETIRED' OR group_retirement_at IS DISTINCT FROM NEW.effective_at THEN
      RAISE EXCEPTION 'retirement evidence requires matching terminal Price Group state'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_ledger_fence"
BEFORE INSERT ON "price_group_catalog"."price_group_catalog_ledger"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."enforce_catalog_fence"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_ledger_append_only"
BEFORE UPDATE OR DELETE ON "price_group_catalog"."price_group_catalog_ledger"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_definitions_guard_insert"
BEFORE INSERT ON "price_group_catalog"."price_group_definition_revisions"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."guard_definition_insert"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_definitions_append_only"
BEFORE UPDATE OR DELETE ON "price_group_catalog"."price_group_definition_revisions"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_intervals_guard_insert"
BEFORE INSERT ON "price_group_catalog"."price_group_definition_effective_intervals"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."guard_interval_insert"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_intervals_append_only"
BEFORE UPDATE OR DELETE ON "price_group_catalog"."price_group_definition_effective_intervals"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_compatibility_append_only"
BEFORE UPDATE OR DELETE ON "price_group_catalog"."price_group_compatibility_support"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_retirements_guard_insert"
BEFORE INSERT ON "price_group_catalog"."price_group_retirements"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."guard_retirement_insert"();
--> statement-breakpoint
CREATE TRIGGER "price_group_catalog_retirements_append_only"
BEFORE UPDATE OR DELETE ON "price_group_catalog"."price_group_retirements"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "price_groups_guard_update"
BEFORE UPDATE ON "price_group_catalog"."price_groups"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."guard_price_group_update"();
--> statement-breakpoint
CREATE TRIGGER "price_groups_no_delete"
BEFORE DELETE ON "price_group_catalog"."price_groups"
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "price_groups_retirement_consistency"
AFTER UPDATE OF "lifecycle_state", "retired_effective_at" ON "price_group_catalog"."price_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."lifecycle_state" = 'RETIRED')
EXECUTE FUNCTION "price_group_catalog"."verify_retirement_consistency"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "price_group_retirements_consistency"
AFTER INSERT ON "price_group_catalog"."price_group_retirements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "price_group_catalog"."verify_retirement_consistency"();
--> statement-breakpoint
REVOKE ALL ON SCHEMA "price_group_catalog" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "price_group_catalog" FROM "ontos_runtime";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "price_group_catalog" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "price_group_catalog" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "price_group_catalog" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "price_group_catalog" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "price_group_catalog" REVOKE ALL ON TABLES FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "price_group_catalog" REVOKE ALL ON SEQUENCES FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "price_group_catalog" REVOKE ALL ON FUNCTIONS FROM PUBLIC, "ontos_runtime";
