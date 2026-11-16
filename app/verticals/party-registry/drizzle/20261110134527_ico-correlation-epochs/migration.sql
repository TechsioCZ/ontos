CREATE TABLE "party"."party_ico_correlation_epochs" (
	"tenant_id" uuid PRIMARY KEY,
	"epoch" uuid DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party"."party_ico_correlation_epochs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "party_ico_correlation_epoch_select" ON "party"."party_ico_correlation_epochs" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("party"."party_ico_correlation_epochs"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_ico_correlation_epoch_insert" ON "party"."party_ico_correlation_epochs" AS PERMISSIVE FOR INSERT TO "party_registry_runtime" WITH CHECK ("party"."party_ico_correlation_epochs"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_ico_correlation_epoch_update" ON "party"."party_ico_correlation_epochs" AS PERMISSIVE FOR UPDATE TO "party_registry_runtime" USING ("party"."party_ico_correlation_epochs"."tenant_id" = (select trust.current_tenant_id())) WITH CHECK ("party"."party_ico_correlation_epochs"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "party_ico_correlation_epoch_delete" ON "party"."party_ico_correlation_epochs" AS PERMISSIVE FOR DELETE TO "party_registry_runtime" USING ("party"."party_ico_correlation_epochs"."tenant_id" = (select trust.current_tenant_id()));
--> statement-breakpoint
INSERT INTO party.party_ico_correlation_epochs(tenant_id)
  SELECT DISTINCT tenant_id FROM party.counterparties;
REVOKE ALL ON party.party_ico_correlation_epochs FROM PUBLIC, ontos_runtime, party_registry_runtime;
ALTER TABLE party.party_ico_correlation_epochs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION party.bump_ico_correlation_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ontos.owner-fact.party-ico.correlation:' || v_tenant::text, 0));
  IF TG_OP = 'UPDATE' AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ontos.owner-fact.party-ico.correlation:' || OLD.tenant_id::text, 0));
    INSERT INTO party.party_ico_correlation_epochs(tenant_id) VALUES (OLD.tenant_id)
      ON CONFLICT (tenant_id) DO UPDATE SET epoch = excluded.epoch;
  END IF;
  INSERT INTO party.party_ico_correlation_epochs(tenant_id)
    VALUES (v_tenant)
    ON CONFLICT (tenant_id) DO UPDATE SET epoch = excluded.epoch;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION party.bump_ico_correlation_epoch() FROM PUBLIC, ontos_runtime, party_registry_runtime;
--> statement-breakpoint
CREATE TRIGGER party_ico_correlation_counterparty_change
  AFTER INSERT OR UPDATE OR DELETE ON party.counterparties
  FOR EACH ROW EXECUTE FUNCTION party.bump_ico_correlation_epoch();
CREATE TRIGGER party_ico_correlation_alias_change
  AFTER INSERT OR UPDATE OR DELETE ON party.party_aliases
  FOR EACH ROW EXECUTE FUNCTION party.bump_ico_correlation_epoch();
CREATE TRIGGER party_ico_correlation_party_change
  AFTER UPDATE OF revision, archived_at, current_type, tenant_id OR DELETE ON party.parties
  FOR EACH ROW EXECUTE FUNCTION party.bump_ico_correlation_epoch();
CREATE TRIGGER party_ico_correlation_role_change
  AFTER INSERT OR UPDATE OR DELETE ON party.counterparty_role_periods
  FOR EACH ROW EXECUTE FUNCTION party.bump_ico_correlation_epoch();

CREATE TRIGGER party_ico_correlation_fact_change
  AFTER INSERT OR UPDATE OR DELETE ON party.party_fact_assertions
  FOR EACH ROW EXECUTE FUNCTION party.bump_ico_correlation_epoch();
CREATE TRIGGER party_ico_correlation_identifier_change
  AFTER INSERT OR UPDATE OR DELETE ON party.party_official_identifiers
  FOR EACH ROW EXECUTE FUNCTION party.bump_ico_correlation_epoch();

--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
--> statement-breakpoint
CREATE FUNCTION party.ico_correlation_signature(p_epoch uuid,p_tenant uuid,p_home uuid,p_counterparty uuid)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.hmac(convert_to('party.registry.ico-correlation-proof.v1:'||p_tenant::text||':'||p_home::text||':'||p_counterparty::text,'UTF8'),
                    convert_to(p_epoch::text,'UTF8'),'sha256');
$$;
REVOKE ALL ON FUNCTION party.ico_correlation_signature(uuid,uuid,uuid,uuid) FROM PUBLIC, ontos_runtime, party_registry_runtime;
--> statement-breakpoint
CREATE FUNCTION party.issue_ico_correlation_witness(p_counterparty uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET row_security=on SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
   'counterpartyId',c.counterparty_id,
   'epoch',encode(sha256(convert_to(e.epoch::text,'UTF8')),'hex'),
   'legalEntityId',c.legal_entity_id,
   'signature',encode(party.ico_correlation_signature(e.epoch,c.tenant_id,c.legal_entity_id,c.counterparty_id),'hex')
 )
 FROM party.counterparties c JOIN party.party_ico_correlation_epochs e ON e.tenant_id=c.tenant_id
 WHERE c.tenant_id=trust.current_tenant_id() AND c.legal_entity_id=trust.current_legal_entity_id()
   AND c.counterparty_id=p_counterparty;
$$;
REVOKE ALL ON FUNCTION party.issue_ico_correlation_witness(uuid) FROM PUBLIC, ontos_runtime;
GRANT EXECUTE ON FUNCTION party.issue_ico_correlation_witness(uuid) TO party_registry_runtime;
--> statement-breakpoint
CREATE FUNCTION party.observe_ico_correlation_coverage(p_assertions uuid[],p_witnesses jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security=on SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 v_tenant uuid:=trust.current_tenant_id(); v_epoch uuid; v_public_epoch text; v_counts jsonb; v_matched bigint;
BEGIN
 IF v_tenant IS NULL OR trust.current_legal_entity_id() IS NULL THEN RETURN NULL; END IF;
 SELECT e.epoch INTO v_epoch FROM party.party_ico_correlation_epochs e WHERE e.tenant_id=v_tenant;
 IF v_epoch IS NULL THEN RETURN NULL; END IF;
 v_public_epoch:=encode(sha256(convert_to(v_epoch::text,'UTF8')),'hex');
 IF p_witnesses IS NULL OR jsonb_typeof(p_witnesses)<>'array' OR jsonb_array_length(p_witnesses)>4096 THEN
   RETURN jsonb_build_object('epoch',v_public_epoch);
 END IF;
 WITH proved AS (
   SELECT c.counterparty_id,c.party_id
   FROM jsonb_array_elements(p_witnesses) AS w(value)
   JOIN party.counterparties c ON c.tenant_id=v_tenant
     AND c.counterparty_id::text=w.value->>'counterpartyId'
     AND c.legal_entity_id::text=w.value->>'legalEntityId'
   WHERE w.value->>'epoch'=v_public_epoch AND
     public.hmac(convert_to(coalesce(w.value->>'signature',''),'UTF8'),convert_to(v_epoch::text,'UTF8'),'sha256')=
     public.hmac(convert_to(encode(party.ico_correlation_signature(v_epoch,c.tenant_id,c.legal_entity_id,c.counterparty_id),'hex'),'UTF8'),
                 convert_to(v_epoch::text,'UTF8'),'sha256')
 ), candidate_counts AS (
   SELECT party_id,count(*) AS matches FROM proved GROUP BY party_id
 )
 SELECT (SELECT count(DISTINCT counterparty_id) FROM proved),
        coalesce(jsonb_agg(coalesce(candidate_counts.matches,0) ORDER BY requested.ordinality),'[]'::jsonb)
   INTO v_matched,v_counts
 FROM unnest(p_assertions) WITH ORDINALITY AS requested(assertion_id,ordinality)
 JOIN party.party_official_identifiers a ON a.tenant_id=v_tenant AND a.official_identifier_id=requested.assertion_id AND a.identifier_type_key='ICO'
 LEFT JOIN candidate_counts ON candidate_counts.party_id=a.party_id;
 IF v_matched<>jsonb_array_length(p_witnesses) OR jsonb_array_length(v_counts)<>cardinality(p_assertions) THEN
   RETURN jsonb_build_object('epoch',v_public_epoch);
 END IF;
 RETURN jsonb_build_object('epoch',v_public_epoch,'foreignMatchCounts',v_counts);
END;
$$;
REVOKE ALL ON FUNCTION party.observe_ico_correlation_coverage(uuid[],jsonb) FROM PUBLIC, ontos_runtime;
GRANT EXECUTE ON FUNCTION party.observe_ico_correlation_coverage(uuid[],jsonb) TO party_registry_runtime;
