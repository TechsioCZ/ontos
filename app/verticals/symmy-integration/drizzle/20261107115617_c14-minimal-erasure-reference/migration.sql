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
  || CASE WHEN p_effect ? 'executorBindingIncarnation' THEN jsonb_build_object('executorBindingIncarnation',p_effect->'executorBindingIncarnation') ELSE '{}'::jsonb END;
END; $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION symmy_integration.erase_symmy_plan_payload(p_plan jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,symmy_integration,pg_temp AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object(
  'sourceRouteId',CASE WHEN coalesce(p_plan->>'sourceRouteId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_plan->'sourceRouteId' ELSE NULL END,'sourceRouteRevision',p_plan->'sourceRouteRevision',
  'sourceMappingVersion',p_plan->'sourceMappingVersion',
  'items',jsonb_agg(jsonb_build_object(
   'itemId',item.value->'itemId','itemKey','erased.'||(item.value->>'itemId'),
   'effects',(SELECT jsonb_agg(symmy_integration.erase_symmy_effect_payload(effect.value) ORDER BY effect.ordinality)
    FROM jsonb_array_elements(item.value->'effects') WITH ORDINALITY effect(value,ordinality)),
   'unsupportedBranches',(SELECT jsonb_agg(jsonb_build_object('branchId',branch.value->'branchId',
      'branchKey','erased.'||(branch.value->>'branchId'),'kind',branch.value->'kind') ORDER BY branch.ordinality)
     FROM jsonb_array_elements(coalesce(item.value->'unsupportedBranches','[]'::jsonb)) WITH ORDINALITY branch(value,ordinality))
  ) ORDER BY item.ordinality)))
 FROM jsonb_array_elements(p_plan->'items') WITH ORDINALITY item(value,ordinality);
$$;
