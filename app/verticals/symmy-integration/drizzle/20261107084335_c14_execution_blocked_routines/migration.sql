CREATE OR REPLACE FUNCTION symmy_integration.claim_symmy_job_effect(p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid)
RETURNS TABLE(effect jsonb, mode text, version integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_mode text;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid OR p_token IS NULL THEN
    RAISE EXCEPTION 'invalid execution scope' USING ERRCODE = '42501';
  END IF;
  SELECT e.* INTO v_effect FROM symmy_integration.job_effects e
    JOIN symmy_integration.import_jobs j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND j.execution_plan IS NOT NULL
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.execution_plan->'items') i,
        jsonb_array_elements(i->'effects') pinned WHERE pinned = e.effect)
    FOR UPDATE OF e;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'blocked'::text, 0; RETURN; END IF;
  IF v_effect.state = 'settled' THEN
    RETURN QUERY SELECT v_effect.effect, 'settled'::text, v_effect.version; RETURN;
  END IF;
  IF v_effect.state = 'attempting' AND v_effect.lease_until > clock_timestamp() THEN
    RETURN QUERY SELECT v_effect.effect, 'busy'::text, v_effect.version; RETURN;
  END IF;
  IF v_effect.state IN ('planned', 'blocked') THEN
    IF NOT symmy_integration.symmy_original_route_active(p_tenant, p_job) THEN
      IF v_effect.state <> 'blocked' THEN
        UPDATE symmy_integration.job_effects e SET state = 'blocked',
          outcome = jsonb_build_object('effectId', p_effect, 'owner', e.effect#>>'{ref,operation,moduleId}', 'status', 'denied'),
          version = e.version + 1
          WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect RETURNING e.version INTO v_effect.version;
      END IF;
      RETURN QUERY SELECT v_effect.effect, 'blocked'::text, v_effect.version; RETURN;
    END IF;
    v_mode := 'execute';
  ELSE
    v_mode := 'recover';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'attempting', outcome = NULL, claim_token = p_token,
    lease_until = clock_timestamp() + interval '30 seconds', version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect RETURNING e.version INTO v_effect.version;
  RETURN QUERY SELECT v_effect.effect, v_mode, v_effect.version;
END;
$$;
--> statement-breakpoint
-- A denial before any owner mutation is retryable and visible, distinct from uncertain recovery.
CREATE FUNCTION symmy_integration.mark_symmy_job_effect_blocked(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_version integer
) RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'blocked',
    outcome = jsonb_build_object('effectId', p_effect, 'owner', e.effect#>>'{ref,operation,moduleId}', 'status', 'denied'),
    claim_token = NULL, lease_until = NULL, version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND e.state = 'attempting' AND e.claim_token = p_token AND e.version = p_version
      AND e.lease_until > clock_timestamp();
  RETURN QUERY SELECT FOUND;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.mark_symmy_job_effect_blocked(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.mark_symmy_job_effect_blocked(uuid, uuid, uuid, uuid, integer) TO ontos_runtime;
