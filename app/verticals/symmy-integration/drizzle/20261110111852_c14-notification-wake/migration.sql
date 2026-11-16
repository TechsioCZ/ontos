-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION symmy_integration.read_symmy_job_notification_wake(p_tenant uuid, p_job uuid)
RETURNS TABLE(wake_at_ms double precision)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
BEGIN
 IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'invalid notification scope' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 SELECT ceil(extract(epoch FROM CASE WHEN n.state='attempting' THEN n.lease_until ELSE n.next_attempt_at END)*1000)::double precision
 FROM symmy_integration.job_notifications n
 WHERE n.tenant_id=p_tenant AND n.job_id=p_job AND n.state IN ('pending','attempting');
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.read_symmy_job_notification_wake(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.read_symmy_job_notification_wake(uuid,uuid) TO ontos_runtime;
