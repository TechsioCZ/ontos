ALTER TABLE "core"."outbox_messages" ADD COLUMN "completion_consumer_module_key" text;--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" ADD COLUMN "completion_original_revision" text;--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" ADD CONSTRAINT "core_outbox_messages_completion_pair_ck" CHECK ((
      "completion_consumer_module_key" is null and "completion_original_revision" is null
    ) or (
      length(btrim("completion_consumer_module_key")) > 0 and
      length(btrim("completion_original_revision")) > 0 and
      "completion_consumer_module_key" is not null and "completion_original_revision" is not null
    ));--> statement-breakpoint
-- Opt-in debt is keyed only by the actual stored message and its declared consumer.
-- No runtime can call the generic durable-work mutation or choose an arbitrary work id.
CREATE FUNCTION core.enroll_outbox_composition_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  authority core.application_composition_authority%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.completion_original_revision IS NOT NULL THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A completion-bound Outbox Message is immutable evidence' USING ERRCODE = '55000';
      END IF;
      IF ROW(NEW.outbox_message_id, NEW.tenant_id, NEW.domain_event_id, NEW.producer_module_key, NEW.topic,
             NEW.completion_original_revision, NEW.completion_consumer_module_key)
         IS DISTINCT FROM
         ROW(OLD.outbox_message_id, OLD.tenant_id, OLD.domain_event_id, OLD.producer_module_key, OLD.topic,
             OLD.completion_original_revision, OLD.completion_consumer_module_key) THEN
        RAISE EXCEPTION 'Outbox completion identity is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_OP = 'UPDATE' AND ROW(NEW.completion_original_revision, NEW.completion_consumer_module_key)
          IS DISTINCT FROM ROW(OLD.completion_original_revision, OLD.completion_consumer_module_key) THEN
      RAISE EXCEPTION 'Legacy Outbox Messages cannot fabricate an original composition' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.completion_original_revision IS NULL AND NEW.completion_consumer_module_key IS NULL THEN RETURN NEW; END IF;
  IF NEW.completion_original_revision IS NULL OR NEW.completion_consumer_module_key IS NULL
     OR NEW.completion_consumer_module_key !~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'Invalid message-bound completion declaration' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  SELECT * INTO authority FROM core.application_composition_authority WHERE authority_key = 'active';
  IF NOT FOUND OR authority.revision <> NEW.completion_original_revision
     OR authority.valid_until <= clock_timestamp() OR authority.phase <> 'active'
     OR authority.durable_work_admission <> 'open' THEN
    RAISE EXCEPTION 'Outbox completion admission is unavailable' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.domain_events e WHERE e.domain_event_id = NEW.domain_event_id
      AND e.tenant_id = NEW.tenant_id AND e.producer_module_key = NEW.producer_module_key
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(authority.subscriptions_json) s
    WHERE s->>'producerModuleKey' = NEW.producer_module_key AND s->>'topic' = NEW.topic
      AND s->>'consumerModuleKey' = NEW.completion_consumer_module_key
  ) THEN
    RAISE EXCEPTION 'Outbox completion requires an exact registered producer and consumer' USING ERRCODE = '55000';
  END IF;
  PERFORM core.track_application_composition_durable_work(NEW.producer_module_key,
    NEW.completion_original_revision, 'outbox:' || NEW.outbox_message_id::text || ':' || NEW.completion_consumer_module_key, true);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.enroll_outbox_composition_completion() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_outbox_messages_completion_enrollment
BEFORE INSERT OR UPDATE OR DELETE ON core.outbox_messages
FOR EACH ROW EXECUTE FUNCTION core.enroll_outbox_composition_completion();
--> statement-breakpoint
CREATE FUNCTION core.settle_outbox_composition_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  message core.outbox_messages%ROWTYPE;
  authority core.application_composition_authority%ROWTYPE;
BEGIN
  IF NEW.status <> 'done' OR OLD.status = 'done' THEN RETURN NEW; END IF;
  SELECT * INTO message FROM core.outbox_messages WHERE outbox_message_id = NEW.outbox_message_id FOR UPDATE;
  IF message.completion_original_revision IS NULL
     OR NEW.consumer_module_key <> message.completion_consumer_module_key THEN RETURN NEW; END IF;
  IF OLD.status <> 'processing' OR OLD.claimed_by IS NULL OR NEW.claimed_by IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM core.outbox_attempts a WHERE a.outbox_delivery_id = NEW.outbox_delivery_id
         AND a.finished_at IS NOT NULL AND a.error_message IS NULL)
     OR EXISTS (SELECT 1 FROM core.outbox_attempts a WHERE a.outbox_delivery_id = NEW.outbox_delivery_id
         AND a.finished_at IS NULL) THEN
    RAISE EXCEPTION 'Completion requires the durable delivery acknowledgement' USING ERRCODE = '55000';
  END IF;
  IF message.matched_at IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  SELECT * INTO authority FROM core.application_composition_authority WHERE authority_key = 'active';
  IF NOT FOUND OR authority.revision <> message.completion_original_revision
     OR authority.valid_until <= clock_timestamp() OR authority.phase IN ('sealed','migrated') THEN
    RAISE EXCEPTION 'Outbox completion authority is unavailable' USING ERRCODE = '55000';
  END IF;
  -- Every originally admitted intended subscription must have an acknowledged delivery.
  -- A missing match, missing delivery, pending, processing, or dead delivery retains debt.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(authority.subscriptions_json) s
      WHERE s->>'producerModuleKey' = message.producer_module_key AND s->>'topic' = message.topic
        AND s->>'consumerModuleKey' = message.completion_consumer_module_key)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(authority.subscriptions_json) s
      WHERE s->>'producerModuleKey' = message.producer_module_key AND s->>'topic' = message.topic
        AND s->>'consumerModuleKey' = message.completion_consumer_module_key
        AND NOT EXISTS (SELECT 1 FROM core.outbox_deliveries d
          WHERE d.outbox_message_id = message.outbox_message_id AND d.worker_key = s->>'workerKey'
            AND d.consumer_module_key = message.completion_consumer_module_key AND d.status = 'done'))
    OR EXISTS (SELECT 1 FROM core.outbox_deliveries d WHERE d.outbox_message_id = message.outbox_message_id
        AND d.consumer_module_key = message.completion_consumer_module_key AND d.status <> 'done') THEN
    RETURN NEW;
  END IF;
  PERFORM core.track_application_composition_durable_work(message.producer_module_key,
    message.completion_original_revision, 'outbox:' || message.outbox_message_id::text || ':' || message.completion_consumer_module_key, false);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.settle_outbox_composition_completion() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_outbox_deliveries_completion_acknowledgement
AFTER UPDATE OF status ON core.outbox_deliveries
FOR EACH ROW EXECUTE FUNCTION core.settle_outbox_composition_completion();
--> statement-breakpoint
-- A completed acknowledgement cannot be reopened after its composition debt was retired.
CREATE FUNCTION core.guard_outbox_completion_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  message core.outbox_messages%ROWTYPE;
BEGIN
  SELECT * INTO message FROM core.outbox_messages WHERE outbox_message_id = OLD.outbox_message_id;
  IF message.completion_original_revision IS NULL
     OR OLD.consumer_module_key <> message.completion_consumer_module_key THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A completion-bound delivery is immutable evidence' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.outbox_delivery_id,NEW.outbox_message_id,NEW.worker_key,NEW.consumer_module_key)
       IS DISTINCT FROM ROW(OLD.outbox_delivery_id,OLD.outbox_message_id,OLD.worker_key,OLD.consumer_module_key)
     OR (OLD.status = 'done' AND NEW.status <> 'done') THEN
    RAISE EXCEPTION 'Outbox completion delivery identity and acknowledgement are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.guard_outbox_completion_delivery() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER core_outbox_deliveries_completion_guard
BEFORE UPDATE OR DELETE ON core.outbox_deliveries
FOR EACH ROW EXECUTE FUNCTION core.guard_outbox_completion_delivery();
