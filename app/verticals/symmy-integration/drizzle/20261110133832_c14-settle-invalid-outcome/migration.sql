-- Invalid native input is terminal and must settle without retrying its accepted siblings.
CREATE OR REPLACE FUNCTION symmy_integration.settle_symmy_job_effect(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_version integer, p_outcome jsonb
) RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_status text;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_effect FROM symmy_integration.job_effects e
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect FOR UPDATE;
  IF NOT FOUND OR v_effect.state <> 'attempting' OR v_effect.claim_token IS DISTINCT FROM p_token
    OR v_effect.version <> p_version OR v_effect.lease_until <= clock_timestamp() THEN
    RETURN QUERY SELECT false; RETURN;
  END IF;
  v_status := p_outcome->>'status';
  IF v_status IS NULL OR v_status NOT IN (
    'accepted_change', 'accepted_no_change', 'duplicate', 'stale', 'unresolved', 'ambiguous', 'denied', 'conflict', 'invalid', 'unsupported'
  ) OR p_outcome->>'owner' IS DISTINCT FROM v_effect.effect#>>'{ref,operation,moduleId}'
    OR (p_outcome ? 'effectId' AND p_outcome->>'effectId' IS DISTINCT FROM p_effect::text)
    OR (v_status IN ('accepted_change', 'accepted_no_change', 'duplicate') AND NOT p_outcome ? 'effectId')
    OR (v_status = 'duplicate' AND (p_outcome->>'originalStatus' IS NULL
      OR p_outcome->>'originalStatus' NOT IN ('accepted_change', 'accepted_no_change')))
    OR (v_status = 'unsupported' AND (p_outcome->>'reason' IS NULL
      OR p_outcome->>'reason' NOT IN ('missing_context', 'unsupported_meaning', 'owner_not_activated')))
    OR (p_outcome ? 'originalStatus' AND v_status <> 'duplicate')
    OR (p_outcome ? 'reason' AND v_status <> 'unsupported')
    OR (v_status = 'unsupported' AND p_outcome ? 'effectId')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_outcome) k WHERE k NOT IN (
      'owner', 'status', 'effectId', 'originalStatus', 'reason'
    )) THEN
    RAISE EXCEPTION 'invalid effect outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'settled', outcome = p_outcome,
    claim_token = NULL, lease_until = NULL, version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect;
  RETURN QUERY SELECT true;
END;
$$;
