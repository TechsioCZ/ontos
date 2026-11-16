-- Quiesce old Symmy admission and execution processes until both Core and Symmy migrations
-- have completed. Once registered, legacy ungated admission and receiving writes fail closed.
-- This migration never reopens a cancelled fence.
SELECT trust.register_source_execution_gated_action('integration.symmy.admit-symmy-job','integration.symmy');
--> statement-breakpoint
SELECT trust.register_source_execution_gated_action('integration.symmy.admit-symmy-sync','integration.symmy');
--> statement-breakpoint
-- The route is writable only to the migration/operator role. The trigger is invoker-rights, so it
-- cannot delegate gate publication to any runtime role even if route privileges are later widened.
CREATE FUNCTION symmy_integration.publish_route_execution_gate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
DECLARE replace_enrollment boolean := true;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    replace_enrollment := (pg_catalog.to_jsonb(NEW) - 'active') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'active');
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
REVOKE ALL ON FUNCTION symmy_integration.publish_route_execution_gate() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER symmy_job_route_publish_execution_gate AFTER INSERT OR UPDATE OR DELETE ON symmy_integration.job_routes
FOR EACH ROW EXECUTE FUNCTION symmy_integration.publish_route_execution_gate();
--> statement-breakpoint
SELECT trust.publish_source_execution_gate(r.tenant_id,r.route_id,'integration.symmy',r.principal_id,
  r.legal_entity_id,r.route_revision,r.mapping_version,r.active,false) FROM symmy_integration.job_routes r;

-- Legacy rows remain available for governed receipt reconciliation.
-- Their original exact enrollment was not proved and must not be rebound for writes.
