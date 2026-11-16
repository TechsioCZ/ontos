-- Erased optional source targets carry no recovery authority. Preserve native receipt references separately.
-- Opaque source-route strings may themselves be identifying; keep only native UUIDs or an explicit erased marker.
CREATE OR REPLACE FUNCTION symmy_integration.erase_symmy_effect_payload(p_effect jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,symmy_integration,pg_temp AS $$
DECLARE v_ref jsonb; v_id text; v_item text;
BEGIN
 IF p_effect IS NULL THEN RETURN NULL; END IF;
 v_id:=p_effect#>>'{ref,effectId}'; v_item:=p_effect->>'itemId';
 v_ref:=jsonb_set(p_effect->'ref','{occurrence}',jsonb_build_object(
  'occurrenceId','ERASED.'||v_item,'record',jsonb_build_object(
   'entityKind','ERASED','issuerId','ERASED','sourceNamespace','ERASED','sourceRecordId','ERASED.'||v_id,
   'route',jsonb_build_object('tenantId',p_effect#>'{ref,occurrence,record,route,tenantId}',
    'integrationRouteId',CASE WHEN coalesce(p_effect#>>'{ref,occurrence,record,route,integrationRouteId}','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN p_effect#>>'{ref,occurrence,record,route,integrationRouteId}' ELSE 'ERASED.'||v_item END)
  )));
 v_ref:=v_ref-'originalTarget';
 RETURN jsonb_build_object('effectKey','erased.'||v_id,'itemId',v_item,'ref',v_ref)
  || CASE WHEN p_effect ? 'executorPrincipalId' THEN jsonb_build_object('executorPrincipalId',p_effect->'executorPrincipalId') ELSE '{}'::jsonb END
  || CASE WHEN p_effect ? 'executorBindingIncarnation' THEN jsonb_build_object('executorBindingIncarnation',p_effect->'executorBindingIncarnation') ELSE '{}'::jsonb END
  || CASE WHEN coalesce(p_effect->>'requestHash','') ~ '^[a-f0-9]{64}$' THEN jsonb_build_object('requestHash',p_effect->'requestHash') ELSE '{}'::jsonb END
  || CASE WHEN coalesce(p_effect->>'authContextRef','') ~* '^job:integration[.]symmy[.]execute-symmy-job:run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN jsonb_build_object('authContextRef',p_effect->'authContextRef') ELSE '{}'::jsonb END
  || CASE WHEN coalesce(p_effect->>'originalInvocationId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN jsonb_build_object('originalInvocationId',p_effect->'originalInvocationId') ELSE '{}'::jsonb END
  || CASE WHEN p_effect->>'originalInvocationStatus' IN ('received','proposed','rejected','running','succeeded','failed','indeterminate','replayed') THEN jsonb_build_object('originalInvocationStatus',p_effect->'originalInvocationStatus') ELSE '{}'::jsonb END;
END; $$;
