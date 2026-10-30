CREATE TABLE "core"."outbox_delivery_resolutions" (
	"outbox_delivery_resolution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"outbox_message_id" uuid NOT NULL,
	"outbox_delivery_id" uuid NOT NULL,
	"worker_key" text NOT NULL,
	"action" text NOT NULL,
	"dead_attempts_count" integer NOT NULL,
	"operator_name" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_by" text DEFAULT session_user NOT NULL,
	"recorded_transaction_id" text DEFAULT (pg_current_xact_id()) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_outbox_delivery_resolutions_action_ck" CHECK ("action" in ('redrive', 'release')),
	CONSTRAINT "core_outbox_delivery_resolutions_operator_ck" CHECK (length(btrim("operator_name")) between 1 and 200),
	CONSTRAINT "core_outbox_delivery_resolutions_reason_ck" CHECK (length(btrim("reason")) between 1 and 2000),
	CONSTRAINT "core_outbox_delivery_resolutions_attempts_ck" CHECK ("dead_attempts_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "core"."outbox_delivery_resolutions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "core_outbox_delivery_resolutions_delivery_idx" ON "core"."outbox_delivery_resolutions" ("outbox_delivery_id","recorded_at");--> statement-breakpoint
ALTER TABLE "core"."outbox_delivery_resolutions" ADD CONSTRAINT "core_outbox_delivery_resolutions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."outbox_delivery_resolutions" ADD CONSTRAINT "core_outbox_delivery_resolutions_delivery_fk" FOREIGN KEY ("outbox_delivery_id") REFERENCES "core"."outbox_deliveries"("outbox_delivery_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."outbox_deliveries" DROP CONSTRAINT "core_outbox_deliveries_status_ck", ADD CONSTRAINT "core_outbox_deliveries_status_ck" CHECK ("status" in ('pending', 'processing', 'done', 'dead', 'released'));--> statement-breakpoint
CREATE POLICY "core_outbox_delivery_resolutions_select" ON "core"."outbox_delivery_resolutions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "core"."outbox_delivery_resolutions" FROM PUBLIC, "ontos_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "core"."outbox_delivery_resolutions" TO "ontos_runtime";
--> statement-breakpoint
-- An operator resolution is append-only evidence about one exact dead delivery. The database, not the
-- caller, stamps the session identity, transaction, and time, and records the consumed attempt count.
CREATE FUNCTION core.record_outbox_delivery_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  delivery core.outbox_deliveries%ROWTYPE;
  message_tenant uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Outbox delivery resolutions are append-only evidence' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO delivery FROM core.outbox_deliveries WHERE outbox_delivery_id = NEW.outbox_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'An Outbox delivery resolution must name one exact delivery' USING ERRCODE = '22023';
  END IF;
  SELECT tenant_id INTO message_tenant FROM core.outbox_messages WHERE outbox_message_id = delivery.outbox_message_id;
  IF delivery.outbox_message_id <> NEW.outbox_message_id OR delivery.worker_key <> NEW.worker_key
     OR message_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'An Outbox delivery resolution must name one exact delivery' USING ERRCODE = '22023';
  END IF;
  IF delivery.status <> 'dead' OR delivery.claimed_by IS NOT NULL THEN
    RAISE EXCEPTION 'Only a dead Outbox delivery can be redriven or released' USING ERRCODE = '55000';
  END IF;
  NEW.dead_attempts_count := delivery.attempts_count;
  NEW.recorded_by := session_user;
  NEW.recorded_transaction_id := pg_current_xact_id()::text;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.record_outbox_delivery_resolution() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_outbox_delivery_resolutions_record
BEFORE INSERT OR UPDATE OR DELETE ON core.outbox_delivery_resolutions
FOR EACH ROW EXECUTE FUNCTION core.record_outbox_delivery_resolution();
--> statement-breakpoint
CREATE TRIGGER core_outbox_delivery_resolutions_no_truncate
BEFORE TRUNCATE ON core.outbox_delivery_resolutions
FOR EACH STATEMENT EXECUTE FUNCTION core.record_outbox_delivery_resolution();
--> statement-breakpoint
-- The recorded decision is applied in the same statement: a redrive returns the delivery to pending
-- with a fresh attempt budget for the normal Worker; a release resolves it without any delivery.
CREATE FUNCTION core.apply_outbox_delivery_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
BEGIN
  IF NEW.action = 'redrive' THEN
    UPDATE core.outbox_deliveries
       SET status = 'pending', attempts_count = 0, available_at = clock_timestamp(),
           claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
     WHERE outbox_delivery_id = NEW.outbox_delivery_id AND status = 'dead';
  ELSE
    UPDATE core.outbox_deliveries SET status = 'released', updated_at = clock_timestamp()
     WHERE outbox_delivery_id = NEW.outbox_delivery_id AND status = 'dead';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The dead Outbox delivery changed before its resolution' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.apply_outbox_delivery_resolution() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_outbox_delivery_resolutions_apply
AFTER INSERT ON core.outbox_delivery_resolutions
FOR EACH ROW EXECUTE FUNCTION core.apply_outbox_delivery_resolution();
--> statement-breakpoint
-- `released` is reachable only from `dead` through a release recorded in the same transaction, and it is
-- terminal. No runtime role can write the resolution ledger, so it cannot fake a release.
CREATE FUNCTION core.guard_outbox_delivery_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
BEGIN
  IF OLD.status = 'released' THEN
    RAISE EXCEPTION 'A released Outbox delivery is terminal operator evidence' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'released' AND (
       OLD.status <> 'dead'
       OR ROW(NEW.outbox_delivery_id, NEW.outbox_message_id, NEW.worker_key, NEW.consumer_module_key,
              NEW.attempts_count, NEW.claimed_by, NEW.claimed_at, NEW.claim_expires_at)
          IS DISTINCT FROM
          ROW(OLD.outbox_delivery_id, OLD.outbox_message_id, OLD.worker_key, OLD.consumer_module_key,
              OLD.attempts_count, OLD.claimed_by, OLD.claimed_at, OLD.claim_expires_at)
       OR NOT EXISTS (SELECT 1 FROM core.outbox_delivery_resolutions r
         WHERE r.outbox_delivery_id = OLD.outbox_delivery_id AND r.action = 'release'
           AND r.recorded_transaction_id = pg_current_xact_id()::text)) THEN
    RAISE EXCEPTION 'Only a recorded operator release can resolve a dead Outbox delivery' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.guard_outbox_delivery_resolution() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_outbox_deliveries_resolution_guard
BEFORE UPDATE ON core.outbox_deliveries
FOR EACH ROW EXECUTE FUNCTION core.guard_outbox_delivery_resolution();
--> statement-breakpoint
-- Completion debt now settles on either a durable acknowledgement or a recorded operator release. The two
-- stay distinguishable: `done` still requires the finished successful attempt, `released` the release record.
CREATE OR REPLACE FUNCTION core.settle_outbox_composition_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  message core.outbox_messages%ROWTYPE;
  authority core.application_composition_authority%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('done', 'released') OR OLD.status IN ('done', 'released') THEN RETURN NEW; END IF;
  SELECT * INTO message FROM core.outbox_messages WHERE outbox_message_id = NEW.outbox_message_id FOR UPDATE;
  IF message.completion_original_revision IS NULL
     OR NEW.consumer_module_key <> message.completion_consumer_module_key THEN RETURN NEW; END IF;
  IF NEW.status = 'done' AND (OLD.status <> 'processing' OR OLD.claimed_by IS NULL OR NEW.claimed_by IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM core.outbox_attempts a WHERE a.outbox_delivery_id = NEW.outbox_delivery_id
         AND a.finished_at IS NOT NULL AND a.error_message IS NULL)
     OR EXISTS (SELECT 1 FROM core.outbox_attempts a WHERE a.outbox_delivery_id = NEW.outbox_delivery_id
         AND a.finished_at IS NULL)) THEN
    RAISE EXCEPTION 'Completion requires the durable delivery acknowledgement' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'released' AND (OLD.status <> 'dead'
     OR NOT EXISTS (SELECT 1 FROM core.outbox_delivery_resolutions r
         WHERE r.outbox_delivery_id = NEW.outbox_delivery_id AND r.action = 'release'
           AND r.recorded_transaction_id = pg_current_xact_id()::text)) THEN
    RAISE EXCEPTION 'Completion release requires a recorded operator release of a dead delivery' USING ERRCODE = '55000';
  END IF;
  IF message.matched_at IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  SELECT * INTO authority FROM core.application_composition_authority WHERE authority_key = 'active';
  IF NOT FOUND OR authority.revision <> message.completion_original_revision
     OR authority.valid_until <= clock_timestamp() OR authority.phase IN ('sealed','migrated') THEN
    RAISE EXCEPTION 'Outbox completion authority is unavailable' USING ERRCODE = '55000';
  END IF;
  -- Every originally admitted intended subscription must have an acknowledged or operator-released
  -- delivery. A missing match, missing delivery, pending, processing, or dead delivery retains debt.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(authority.subscriptions_json) s
      WHERE s->>'producerModuleKey' = message.producer_module_key AND s->>'topic' = message.topic
        AND s->>'consumerModuleKey' = message.completion_consumer_module_key)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(authority.subscriptions_json) s
      WHERE s->>'producerModuleKey' = message.producer_module_key AND s->>'topic' = message.topic
        AND s->>'consumerModuleKey' = message.completion_consumer_module_key
        AND NOT EXISTS (SELECT 1 FROM core.outbox_deliveries d
          WHERE d.outbox_message_id = message.outbox_message_id AND d.worker_key = s->>'workerKey'
            AND d.consumer_module_key = message.completion_consumer_module_key AND d.status IN ('done', 'released')))
    OR EXISTS (SELECT 1 FROM core.outbox_deliveries d WHERE d.outbox_message_id = message.outbox_message_id
        AND d.consumer_module_key = message.completion_consumer_module_key AND d.status NOT IN ('done', 'released')) THEN
    RETURN NEW;
  END IF;
  PERFORM core.track_application_composition_durable_work(message.producer_module_key,
    message.completion_original_revision, 'outbox:' || message.outbox_message_id::text || ':' || message.completion_consumer_module_key, false);
  RETURN NEW;
END;
$function$;
