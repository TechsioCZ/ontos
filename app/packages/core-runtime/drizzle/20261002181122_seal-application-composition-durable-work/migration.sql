CREATE OR REPLACE FUNCTION core.track_application_composition_durable_work(
  p_owner_module_key text,
  p_original_revision text,
  p_work_id text,
  p_pending boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  authority core.application_composition_authority%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Application Composition durable work requires READ COMMITTED' USING ERRCODE = '55000';
  END IF;
  IF p_owner_module_key IS NULL OR p_owner_module_key !~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)*$'
     OR p_original_revision IS NULL OR p_original_revision !~ '^[a-f0-9]{64}$'
     OR p_work_id IS NULL OR length(p_work_id) NOT BETWEEN 1 AND 500
     OR p_pending IS NULL THEN
    RAISE EXCEPTION 'Invalid Application Composition durable work identity' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  SELECT * INTO authority FROM core.application_composition_authority WHERE authority_key = 'active';
  IF NOT FOUND OR authority.revision <> p_original_revision OR authority.valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'Application Composition durable work authority is missing, expired, or superseded' USING ERRCODE = '55000';
  END IF;
  IF authority.phase = 'sealed' THEN
    RAISE EXCEPTION 'Application Composition is sealed' USING ERRCODE = '55000';
  END IF;
  IF p_pending THEN
    IF authority.phase <> 'active' THEN
      RAISE EXCEPTION 'Application Composition is draining' USING ERRCODE = '55000';
    END IF;
    INSERT INTO core.application_composition_durable_work (owner_module_key, original_revision, work_id)
      VALUES (p_owner_module_key, p_original_revision, p_work_id)
      ON CONFLICT (owner_module_key, original_revision, work_id) DO NOTHING;
  ELSE
    DELETE FROM core.application_composition_durable_work
      WHERE owner_module_key = p_owner_module_key AND original_revision = p_original_revision AND work_id = p_work_id;
  END IF;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.track_application_composition_durable_work(text, text, text, boolean) FROM PUBLIC, ontos_runtime;
