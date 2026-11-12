-- Narrow factual liveness query; request logins gain no direct access to the dispatch ledger.
CREATE FUNCTION trust.registered_workload_delivery_is_active(p_delivery_id uuid, p_claim_id text, p_worker_key text, p_module_key text, p_tenant_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid := trust.current_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM trust.gateway_audience_roles a WHERE a.role_name = SESSION_USER) THEN
      RETURN false;
    END IF;
    v_tenant_id := nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid;
  END IF;
  IF v_tenant_id IS NULL OR v_tenant_id IS DISTINCT FROM p_tenant_id THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM core.outbox_deliveries d
    JOIN core.outbox_messages m ON m.outbox_message_id=d.outbox_message_id
    WHERE d.outbox_delivery_id=p_delivery_id AND d.claimed_by=p_claim_id AND d.worker_key=p_worker_key
      AND d.consumer_module_key=p_module_key AND m.producer_module_key=p_module_key AND m.tenant_id=p_tenant_id
      AND d.status='processing' AND d.claim_expires_at>pg_catalog.statement_timestamp()
  );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trust.registered_workload_delivery_is_active(uuid,text,text,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trust.registered_workload_delivery_is_active(uuid,text,text,text,uuid) TO ontos_runtime, party_registry_runtime;
