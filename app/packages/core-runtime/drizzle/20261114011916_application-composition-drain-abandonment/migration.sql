CREATE TABLE "core"."application_composition_drain_abandonments" (
	"drain_abandonment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"revision" text NOT NULL,
	"initiated_by" text NOT NULL,
	"operator_name" text NOT NULL,
	"reason" text NOT NULL,
	"lease_valid_until" timestamp with time zone NOT NULL,
	"recorded_by" text DEFAULT session_user NOT NULL,
	"recorded_transaction_id" text DEFAULT (pg_current_xact_id()) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_application_composition_drain_abandonments_revision_ck" CHECK ("revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "core_application_composition_drain_abandonments_initiator_ck" CHECK ("initiated_by" in ('publisher', 'operator')),
	CONSTRAINT "core_application_composition_drain_abandonments_operator_ck" CHECK (length(btrim("operator_name")) between 1 and 200),
	CONSTRAINT "core_application_composition_drain_abandonments_reason_ck" CHECK (length(btrim("reason")) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "core"."application_composition_drain_abandonments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "core_application_composition_drain_abandonments_revision_idx" ON "core"."application_composition_drain_abandonments" ("revision","recorded_at");--> statement-breakpoint
CREATE POLICY "core_application_composition_drain_abandonments_select" ON "core"."application_composition_drain_abandonments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "core"."application_composition_drain_abandonments" FROM PUBLIC, "ontos_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "core"."application_composition_drain_abandonments" TO "ontos_runtime";
--> statement-breakpoint
-- A drain abandonment is append-only evidence that one exact revision went from `draining` back to `active`. It is
-- accepted only under the exclusive authority lock (the lock publication, matching and owner writes take), and only
-- while the authority row is exactly that revision, `draining` and unexpired. Phases only move forward and a seal
-- precedes every publisher-run schema migration, so `draining` also proves nothing was sealed and that migration
-- never started. The database, not the caller, stamps the session identity, transaction, time and the lease found.
CREATE FUNCTION core.record_application_composition_drain_abandonment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  authority core.application_composition_authority%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Application Composition drain abandonments are append-only evidence' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0));
  SELECT * INTO authority FROM core.application_composition_authority WHERE authority_key = 'active' FOR UPDATE;
  IF NOT FOUND OR authority.revision <> NEW.revision THEN
    RAISE EXCEPTION 'A drain abandonment must name the revision that holds the authority' USING ERRCODE = '55000';
  END IF;
  IF authority.phase <> 'draining' THEN
    RAISE EXCEPTION 'Only a draining Application Composition can be returned to active (phase %)', authority.phase
      USING ERRCODE = '55000';
  END IF;
  IF authority.valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'An expired Application Composition lease must be renewed before its drain is abandoned'
      USING ERRCODE = '55000';
  END IF;
  NEW.lease_valid_until := authority.valid_until;
  NEW.recorded_by := session_user;
  NEW.recorded_transaction_id := pg_current_xact_id()::text;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.record_application_composition_drain_abandonment() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_application_composition_drain_abandonments_record
BEFORE INSERT OR UPDATE OR DELETE ON core.application_composition_drain_abandonments
FOR EACH ROW EXECUTE FUNCTION core.record_application_composition_drain_abandonment();
--> statement-breakpoint
CREATE TRIGGER core_application_composition_drain_abandonments_no_truncate
BEFORE TRUNCATE ON core.application_composition_drain_abandonments
FOR EACH STATEMENT EXECUTE FUNCTION core.record_application_composition_drain_abandonment();
--> statement-breakpoint
-- The recorded abandonment is applied in the same statement: the same revision becomes `active` with durable
-- admission open, which re-admits exactly the reads and writes that release held before its drain began.
CREATE FUNCTION core.apply_application_composition_drain_abandonment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
BEGIN
  UPDATE core.application_composition_authority
     SET phase = 'active', durable_work_admission = 'open', updated_at = clock_timestamp()
   WHERE authority_key = 'active' AND revision = NEW.revision AND phase = 'draining'
     AND valid_until > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The draining Application Composition changed before its drain was abandoned' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.apply_application_composition_drain_abandonment() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_application_composition_drain_abandonments_apply
AFTER INSERT ON core.application_composition_drain_abandonments
FOR EACH ROW EXECUTE FUNCTION core.apply_application_composition_drain_abandonment();
--> statement-breakpoint
-- `draining` returns to `active` for the same revision only through a recorded abandonment in the same transaction.
-- A hand-written UPDATE of the authority row can no longer do it unrecorded.
CREATE FUNCTION core.guard_application_composition_drain_abandonment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
BEGIN
  IF OLD.phase = 'draining' AND NEW.phase = 'active' AND NEW.revision = OLD.revision
     AND NOT EXISTS (SELECT 1 FROM core.application_composition_drain_abandonments a
       WHERE a.revision = OLD.revision AND a.recorded_transaction_id = pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Only a recorded drain abandonment can return a draining Application Composition to active'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.guard_application_composition_drain_abandonment() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_application_composition_authority_drain_abandonment_guard
BEFORE UPDATE ON core.application_composition_authority
FOR EACH ROW EXECUTE FUNCTION core.guard_application_composition_drain_abandonment();
