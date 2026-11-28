-- Stable only inside a native writer's transaction; this interlock grants no processing authority.
-- Shared mutation locks let independent Privacy operations run concurrently. Only a consuming transaction
-- that actually needs an atomic evaluation/write window takes the exclusive, company-scoped side.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
CREATE FUNCTION privacy.hold_source_eligibility_stable(p_tenant uuid, p_company uuid) RETURNS TABLE(held boolean)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_tenant IS NULL OR p_company IS NULL OR p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_company IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Source eligibility interlock requires exact company scope' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy.source-eligibility:'||p_tenant::text||':'||p_company::text,0));
 RETURN QUERY SELECT true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION privacy.hold_source_eligibility_stable(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION privacy.hold_source_eligibility_stable(uuid,uuid) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION privacy.serialize_source_eligibility_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy.source-eligibility:'||OLD.tenant_id::text||':'||OLD.legal_entity_id::text,0));
 END IF;
 IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.tenant_id,NEW.legal_entity_id) IS DISTINCT FROM (OLD.tenant_id,OLD.legal_entity_id)) THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy.source-eligibility:'||NEW.tenant_id::text||':'||NEW.legal_entity_id::text,0));
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION privacy.serialize_source_eligibility_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.source_processing_authorizations
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.source_processing_admissions
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.privacy_subjects
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.processing_purposes
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.purpose_versions
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.responsibility_assignments
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.applicability_decisions
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.applicability_policies
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.legal_basis_assignments
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.consent_decisions
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.consent_scope_bindings
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.processing_interventions
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
--> statement-breakpoint
CREATE TRIGGER source_eligibility_change BEFORE INSERT OR UPDATE OR DELETE ON privacy.anti_resurrection_protections
FOR EACH ROW EXECUTE FUNCTION privacy.serialize_source_eligibility_change();
