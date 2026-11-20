-- Route enrollment records are written only by the operator command (administrative login), in the transaction of the
-- route change they record, and are never changed: the runtime role holds no privilege on them, each record is stamped
-- with the database login that wrote it, and an update, delete or truncation is refused for every role.
ALTER TABLE symmy_integration.route_enrollment_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.guard_route_enrollment_record()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, symmy_integration, pg_temp AS $
BEGIN
 IF TG_OP = 'INSERT' THEN
  NEW.database_session_user := session_user;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'route enrollment records are append-only' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.guard_route_enrollment_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER symmy_route_enrollment_records_guard
BEFORE INSERT OR UPDATE OR DELETE ON symmy_integration.route_enrollment_records
FOR EACH ROW EXECUTE FUNCTION symmy_integration.guard_route_enrollment_record();
--> statement-breakpoint
CREATE TRIGGER symmy_route_enrollment_records_no_truncate
BEFORE TRUNCATE ON symmy_integration.route_enrollment_records
FOR EACH STATEMENT EXECUTE FUNCTION symmy_integration.guard_route_enrollment_record();
--> statement-breakpoint
-- Every route row carries a change token, whoever writes it: a new row starts above every token recorded for its route
-- id, and every change of a row raises the token by one, so one token names one state of the route.
CREATE FUNCTION symmy_integration.advance_route_change_token()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, symmy_integration, pg_temp AS $
BEGIN
 IF TG_OP = 'INSERT' THEN
  NEW.change_token := 1 + coalesce((SELECT max(r.change_token) FROM symmy_integration.route_enrollment_records r
    WHERE r.tenant_id = NEW.tenant_id AND r.route_id = NEW.route_id), 0);
  RETURN NEW;
 END IF;
 NEW.change_token := OLD.change_token;
 IF NEW IS DISTINCT FROM OLD THEN
  NEW.change_token := OLD.change_token + 1;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.advance_route_change_token() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER symmy_job_routes_change_token
BEFORE INSERT OR UPDATE ON symmy_integration.job_routes
FOR EACH ROW EXECUTE FUNCTION symmy_integration.advance_route_change_token();
--> statement-breakpoint
-- The change token changes with every change, so the gate compares an enrollment without it, as without active: a
-- deactivation or reactivation alone still keeps the execution epoch.
CREATE OR REPLACE FUNCTION symmy_integration.publish_route_execution_gate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
DECLARE replace_enrollment boolean := true;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    replace_enrollment := (pg_catalog.to_jsonb(NEW) - 'active' - 'change_token')
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'active' - 'change_token');
  END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.tenant_id,OLD.route_id) IS DISTINCT FROM (NEW.tenant_id,NEW.route_id)) THEN
    PERFORM trust.publish_source_execution_gate(OLD.tenant_id,OLD.route_id,'integration.symmy',OLD.principal_id,
      OLD.legal_entity_id,OLD.route_revision,OLD.mapping_version,false,true);
  END IF;
  IF TG_OP<>'DELETE' THEN
    -- Reestablish the immutable policy in schema-only restores before any route can admit work.
    IF TG_OP='INSERT' THEN
      PERFORM trust.register_source_execution_gated_action('integration.symmy.admit-symmy-job','integration.symmy');
      PERFORM trust.register_source_execution_gated_action('integration.symmy.admit-symmy-sync','integration.symmy');
    END IF;
    PERFORM trust.publish_source_execution_gate(NEW.tenant_id,NEW.route_id,'integration.symmy',NEW.principal_id,
      NEW.legal_entity_id,NEW.route_revision,NEW.mapping_version,NEW.active,replace_enrollment);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- An admission locks the route row it read, whole, change token included: any change since its read refuses it.
CREATE OR REPLACE FUNCTION symmy_integration.lock_symmy_enrollment_snapshot(p_tenant uuid,p_route uuid,p_snapshot jsonb)
RETURNS TABLE(allowed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_route symmy_integration.job_routes%ROWTYPE;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_route FROM symmy_integration.job_routes r WHERE r.tenant_id=p_tenant AND r.route_id=p_route FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT false; RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'active',v_route.active,'changeToken',v_route.change_token,'fixtureIds',v_route.fixture_ids,
    'fixturePlan',v_route.fixture_plan,'legalEntityId',v_route.legal_entity_id,'lifecyclePolicy',v_route.lifecycle_policy,
    'mappingVersion',v_route.mapping_version,'principalId',v_route.principal_id,'routeCode',v_route.route_code,
    'routeId',v_route.route_id,'routeKey',v_route.route_key,'routeRevision',v_route.route_revision,
    'tenantId',v_route.tenant_id)=p_snapshot;
END; $$;
