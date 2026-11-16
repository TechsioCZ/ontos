ALTER TABLE "symmy_integration"."job_effects" DROP CONSTRAINT "symmy_job_effects_outcome_ck", ADD CONSTRAINT "symmy_job_effects_outcome_ck" CHECK ((("state" in ('settled', 'blocked')) = ("outcome" is not null))
        or ("state" = 'indeterminate' and "outcome"->>'status' is not distinct from 'unavailable'));
--> statement-breakpoint
CREATE FUNCTION symmy_integration.mark_symmy_job_effect_unavailable(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_version integer
) RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'indeterminate', claim_token = NULL,
    outcome = jsonb_build_object('effectId', p_effect, 'owner', e.effect#>>'{ref,operation,moduleId}', 'status', 'unavailable'),
    lease_until = NULL, version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND e.state = 'attempting' AND e.claim_token = p_token AND e.version = p_version
      AND e.lease_until > clock_timestamp();
  RETURN QUERY SELECT FOUND;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.mark_symmy_job_effect_unavailable(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.mark_symmy_job_effect_unavailable(uuid, uuid, uuid, uuid, integer) TO ontos_runtime;
