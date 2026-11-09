-- #1151/#1153 TECH-01: an INDETERMINATE Payment Operation is admitted execution whose monetary effect is
-- unknown; it has neither a proven outcome nor a safe durable checkpoint. It is tracked as Core durable
-- work of payment.core under the runtime revision of the invocation that made the effect unknown, so the
-- existing Core fence refuses to drain or seal that release until the unknown is resolved by proven
-- evidence or a governed reconciliation decision. Business waiting (PENDING) is never tracked here.
-- The work is cleared under the exact revision it was tracked with; Core keeps that revision active
-- while the work exists, so no unknown effect is relabelled to another revision.
CREATE FUNCTION "payment"."track_indeterminate_operation_work"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, payment, pg_temp
AS $function$
DECLARE
  operation_work_id text := 'payment-operation:' || NEW.tenant_id || ':' || NEW.operation_id;
  tracked_revision text;
BEGIN
  IF NEW.from_outcome = 'INDETERMINATE' THEN
    FOR tracked_revision IN
      SELECT work.original_revision
      FROM core.application_composition_durable_work AS work
      WHERE work.owner_module_key = 'payment.core' AND work.work_id = operation_work_id
    LOOP
      PERFORM core.track_application_composition_durable_work('payment.core', tracked_revision, operation_work_id, false);
    END LOOP;
  END IF;
  IF NEW.to_outcome = 'INDETERMINATE' THEN
    PERFORM core.track_application_composition_durable_work(
      'payment.core', NEW.composition_revision, operation_work_id, true
    );
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment"."track_indeterminate_operation_work"() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER "payment_outcome_transitions_durable_work"
AFTER INSERT ON "payment"."operation_outcome_transitions"
FOR EACH ROW EXECUTE FUNCTION "payment"."track_indeterminate_operation_work"();
