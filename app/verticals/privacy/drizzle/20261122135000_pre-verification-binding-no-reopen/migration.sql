-- A withdrawn pre-verification binding is final (#1406 D.8): no update may reopen it, whoever runs it.
CREATE FUNCTION "privacy"."reject_pre_verification_binding_reopen"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'WITHDRAWN' AND NEW.status IS DISTINCT FROM 'WITHDRAWN' THEN
    RAISE EXCEPTION 'A withdrawn pre-verification binding cannot be reopened'
      USING ERRCODE = '23514', CONSTRAINT = 'privacy_pre_verification_bindings_no_reopen_ck';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "privacy_pre_verification_bindings_no_reopen"
BEFORE UPDATE ON "privacy"."pre_verification_bindings"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_pre_verification_binding_reopen"();
