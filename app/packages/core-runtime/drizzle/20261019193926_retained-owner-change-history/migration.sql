-- A retained-event reader for reviewed owner SECURITY DEFINER routines only.
-- Runtime callers never receive a global Core event/history browsing capability.
CREATE FUNCTION core.read_committed_owner_change_history_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_owner_module_key text,
  p_subject_ref jsonb,
  p_selectors jsonb,
  p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  selector jsonb;
  binding jsonb;
  seen_event_types text[] := ARRAY[]::text[];
  observed_count integer;
  usable boolean;
  retained_events jsonb;
  outcome text;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR nullif(current_setting('ontos.tenant_id', true), '') IS DISTINCT FROM p_tenant_id::text
    OR nullif(current_setting('ontos.legal_entity_id', true), '') IS DISTINCT FROM p_legal_entity_id::text
    OR NOT EXISTS (SELECT 1 FROM core.legal_entities le
      WHERE le.tenant_id=p_tenant_id AND le.legal_entity_id=p_legal_entity_id) THEN
    RAISE EXCEPTION 'Retained owner history requires the exact installed Tenant and selected legal entity' USING ERRCODE='42501';
  END IF;
  IF p_owner_module_key IS NULL OR length(p_owner_module_key) NOT BETWEEN 1 AND 300
    OR p_owner_module_key !~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)*$'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Invalid retained owner history boundary' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_subject_ref) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Retained owner history requires a canonical owner ResourceRef' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_subject_ref)) <> 4
    OR p_subject_ref->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR p_subject_ref->>'moduleId' IS DISTINCT FROM p_owner_module_key
    OR jsonb_typeof(p_subject_ref->'resourceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_subject_ref->'resourceType') IS DISTINCT FROM 'string'
    OR coalesce(length(p_subject_ref->>'resourceId'),0) NOT BETWEEN 1 AND 300
    OR coalesce(length(p_subject_ref->>'resourceType'),0) NOT BETWEEN 1 AND 300
    OR p_subject_ref->>'resourceId' <> btrim(p_subject_ref->>'resourceId')
    OR p_subject_ref->>'resourceType' <> btrim(p_subject_ref->>'resourceType') THEN
    RAISE EXCEPTION 'Retained owner history ResourceRef does not match its exact owner scope' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_selectors) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Retained owner history requires a bounded declared selector' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_selectors) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'Retained owner history selector bound exceeded' USING ERRCODE='22023';
  END IF;
  FOR selector IN SELECT value FROM jsonb_array_elements(p_selectors) LOOP
    IF jsonb_typeof(selector) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid retained owner history selector' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(selector)) <> 3
      OR jsonb_typeof(selector->'actionKey') IS DISTINCT FROM 'string'
      OR jsonb_typeof(selector->'eventType') IS DISTINCT FROM 'string'
      OR coalesce(length(selector->>'actionKey'),0) NOT BETWEEN 1 AND 300
      OR coalesce(length(selector->>'eventType'),0) NOT BETWEEN 1 AND 300
      OR selector->>'actionKey' <> btrim(selector->>'actionKey')
      OR selector->>'eventType' <> btrim(selector->>'eventType')
      OR selector->>'eventType' = ANY(seen_event_types) THEN
      RAISE EXCEPTION 'Invalid or duplicate retained owner history selector' USING ERRCODE='22023';
    END IF;
    seen_event_types := array_append(seen_event_types,selector->>'eventType');
    binding := selector->'binding';
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid retained owner history reference binding' USING ERRCODE='22023';
    END IF;
    IF binding->>'kind' = 'subject' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(binding)) <> 1 THEN
        RAISE EXCEPTION 'Invalid direct retained owner history binding' USING ERRCODE='22023';
      END IF;
    ELSIF binding->>'kind' = 'payload_refs' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(binding)) <> 4
        OR coalesce(binding->>'aggregateRefKey','') !~ '^[a-zA-Z][a-zA-Z0-9]{0,99}$'
        OR coalesce(binding->>'subjectRefKey','') !~ '^[a-zA-Z][a-zA-Z0-9]{0,99}$'
        OR jsonb_typeof(binding->'subjectResourceType') IS DISTINCT FROM 'string'
        OR coalesce(length(binding->>'subjectResourceType'),0) NOT BETWEEN 1 AND 300
        OR binding->>'subjectResourceType' <> btrim(binding->>'subjectResourceType') THEN
        RAISE EXCEPTION 'Invalid payload retained owner history binding' USING ERRCODE='22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown retained owner history reference binding' USING ERRCODE='22023';
    END IF;
  END LOOP;

  -- The original payload remains owner data. Only declared ResourceRef keys are interpreted.
  -- Each known event type must have its exact succeeded, same-scope invocation/action binding.
  -- A mismatched candidate makes the whole selection unusable instead of disappearing from it.
  WITH selected AS (
    SELECT e.*,a.action_key,a.completed_at,
      coalesce(a.status='succeeded' AND a.completed_at IS NOT NULL
        AND a.tenant_id=e.tenant_id AND a.legal_entity_id IS NOT DISTINCT FROM e.legal_entity_id
        AND a.action_key=s.value->>'actionKey'
        AND e.producer_module_key=p_owner_module_key AND e.subject_module_key=p_owner_module_key
        AND CASE WHEN s.value->'binding'->>'kind'='subject' THEN true ELSE
          e.subject_resource_type=s.value->'binding'->>'subjectResourceType'
          AND e.payload_json->(s.value->'binding'->>'subjectRefKey')=jsonb_build_object(
            'moduleId',p_owner_module_key,'resourceId',e.subject_resource_id,
            'resourceType',s.value->'binding'->>'subjectResourceType','tenantId',p_tenant_id::text)
        END,false) AS valid_binding
    FROM core.domain_events e
    JOIN jsonb_array_elements(p_selectors) s(value) ON e.event_type=s.value->>'eventType'
    LEFT JOIN core.action_invocations a ON a.action_invocation_id=e.action_invocation_id
    WHERE e.tenant_id=p_tenant_id AND e.legal_entity_id=p_legal_entity_id
      AND CASE WHEN s.value->'binding'->>'kind'='subject' THEN
        e.subject_module_key=p_owner_module_key AND e.subject_resource_type=p_subject_ref->>'resourceType'
          AND e.subject_resource_id=p_subject_ref->>'resourceId'
      ELSE e.payload_json->(s.value->'binding'->>'aggregateRefKey')=p_subject_ref END
    ORDER BY e.tenant_sequence_no,e.domain_event_id
    LIMIT p_limit+1
  )
  SELECT count(*)::integer,coalesce(bool_and(valid_binding),true),
    coalesce(jsonb_agg(jsonb_build_object(
      'actionInvocationId',action_invocation_id,'actionKey',action_key,
      'completedAt',to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'domainEventId',domain_event_id,'eventType',event_type,
      'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'payloadJson',payload_json,'producerModuleKey',producer_module_key,
      'subjectModuleKey',subject_module_key,'subjectResourceId',subject_resource_id,
      'subjectResourceType',subject_resource_type,'tenantSequenceNo',tenant_sequence_no::text
    ) ORDER BY tenant_sequence_no,domain_event_id),'[]'::jsonb)
    INTO observed_count,usable,retained_events FROM selected;
  outcome := CASE WHEN observed_count>p_limit THEN 'TRUNCATED'
    WHEN NOT usable THEN 'UNUSABLE_BINDING' ELSE 'READ_COMPLETE' END;
  RETURN jsonb_build_object('events',CASE WHEN outcome='READ_COMPLETE' THEN retained_events ELSE '[]'::jsonb END,
    'legalEntityId',p_legal_entity_id::text,'outcome',outcome,'schemaVersion','1',
    'selectors',p_selectors,'subjectRef',p_subject_ref);
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.read_committed_owner_change_history_v1(uuid,uuid,text,jsonb,jsonb,integer) FROM PUBLIC, ontos_runtime;
