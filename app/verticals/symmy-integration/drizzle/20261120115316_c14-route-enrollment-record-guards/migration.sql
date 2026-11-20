-- Route enrollment records are written only by the operator command (administrative login) and are never changed:
-- the runtime role holds no privilege on them, and an update or delete of a record is refused for every role.
ALTER TABLE symmy_integration.route_enrollment_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.reject_route_enrollment_record_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,symmy_integration,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'route enrollment records are append-only' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.reject_route_enrollment_record_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER symmy_route_enrollment_records_append_only
BEFORE UPDATE OR DELETE ON symmy_integration.route_enrollment_records
FOR EACH ROW EXECUTE FUNCTION symmy_integration.reject_route_enrollment_record_change();
