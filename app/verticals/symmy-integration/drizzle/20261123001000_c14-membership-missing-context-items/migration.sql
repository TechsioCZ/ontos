-- Unknown source customers have an unsupported outcome, never a fictitious owner effect.
CREATE OR REPLACE FUNCTION symmy_integration.pin_symmy_fixture_plan(
  p_plan jsonb, p_tenant uuid, p_route uuid, p_revision text, p_mapping text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_effect jsonb;
  v_items jsonb := '[]'::jsonb;
  v_effects jsonb;
  v_item_id uuid;
  v_occurrence_id text;
  v_ref jsonb;
  v_branch jsonb;
  v_branches jsonb;
BEGIN
  IF p_plan IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_plan->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_plan->'items') NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'invalid fixture plan' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_plan->'items') LOOP
    IF jsonb_typeof(v_item->'effects') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_item->'effects') NOT BETWEEN 0 AND 32 THEN
      RAISE EXCEPTION 'invalid fixture effects' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_item->'effects') = 0 THEN
      IF jsonb_typeof(v_item->'unsupportedBranches') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'effectless fixture item requires unsupported branches' USING ERRCODE = '22023';
      END IF;
      IF jsonb_array_length(v_item->'unsupportedBranches') NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION 'effectless fixture item requires unsupported branches' USING ERRCODE = '22023';
      END IF;
    END IF;
    v_item_id := gen_random_uuid();
    v_occurrence_id := COALESCE(NULLIF(v_item->>'sourceOccurrenceId',''),gen_random_uuid()::text);
    v_effects := '[]'::jsonb;
    FOR v_effect IN SELECT value FROM jsonb_array_elements(v_item->'effects') LOOP
      v_ref := jsonb_build_object(
        'effectId', gen_random_uuid(), 'mappingVersion', COALESCE(p_plan->>'sourceMappingVersion',p_mapping), 'routeRevision', COALESCE(p_plan->>'sourceRouteRevision',p_revision),
        'operation', jsonb_build_object(
          'moduleId', v_effect#>'{operation,moduleId}',
          'entrypointKey', v_effect#>'{operation,entrypointKey}',
          'schemaVersion', v_effect#>'{operation,schemaVersion}'
        ),
        'occurrence', jsonb_build_object(
          'occurrenceId', v_occurrence_id,
          'record', jsonb_build_object(
            'entityKind', v_item#>'{source,entityKind}', 'issuerId', v_item#>'{source,issuerId}',
            'sourceNamespace', v_item#>'{source,sourceNamespace}',
            'sourceRecordId', v_item#>'{source,sourceRecordId}',
            'route', jsonb_build_object('integrationRouteId', COALESCE(p_plan->'sourceRouteId',to_jsonb(p_route)), 'tenantId', p_tenant)
          )
        )
      );
      IF v_effect ? 'originalTarget' THEN
        IF v_effect#>>'{originalTarget,tenantId}' IS DISTINCT FROM p_tenant::text
          OR v_effect#>>'{originalTarget,moduleId}' IS DISTINCT FROM v_effect#>>'{operation,moduleId}' THEN
          RAISE EXCEPTION 'invalid fixture target scope' USING ERRCODE = '22023';
        END IF;
        v_ref := v_ref || jsonb_build_object('originalTarget', jsonb_build_object(
          'tenantId', p_tenant, 'moduleId', v_effect#>'{originalTarget,moduleId}',
          'resourceType', v_effect#>'{originalTarget,resourceType}',
          'resourceId', v_effect#>'{originalTarget,resourceId}'
        ));
      END IF;
      v_effects := v_effects || jsonb_build_array(jsonb_build_object(
        'effectKey', v_effect->'effectKey', 'itemId', v_item_id, 'ref', v_ref
      ) || CASE WHEN v_effect ? 'dependsOn' THEN jsonb_build_object('dependsOn',v_effect->'dependsOn') ELSE '{}'::jsonb END
        || CASE WHEN v_effect ? 'intent' THEN jsonb_build_object('intent',v_effect->'intent') ELSE '{}'::jsonb END);
    END LOOP;
    v_branches:='[]'::jsonb;
    IF v_item ? 'unsupportedBranches' THEN
      IF jsonb_typeof(v_item->'unsupportedBranches') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'unsupportedBranches')>8 THEN
        RAISE EXCEPTION 'invalid unsupported branches' USING ERRCODE='22023'; END IF;
      FOR v_branch IN SELECT value FROM jsonb_array_elements(v_item->'unsupportedBranches') LOOP
        v_branches:=v_branches||jsonb_build_array(jsonb_build_object('branchId',gen_random_uuid(),'branchKey',v_branch->'branchKey','kind',v_branch->'kind'));
      END LOOP;
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id, 'itemKey', v_item->'itemKey', 'effects', v_effects
    ) || CASE WHEN jsonb_array_length(v_branches)>0 THEN jsonb_build_object('unsupportedBranches',v_branches) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN jsonb_build_object('items', v_items,'sourceRouteId',COALESCE(p_plan->'sourceRouteId',to_jsonb(p_route)),'sourceRouteRevision',COALESCE(p_plan->>'sourceRouteRevision',p_revision),'sourceMappingVersion',COALESCE(p_plan->>'sourceMappingVersion',p_mapping)) || CASE WHEN p_plan ? 'selector' THEN jsonb_build_object('selector',p_plan->'selector') ELSE '{}'::jsonb END || CASE WHEN p_plan ? 'pricingSourceSystem' THEN jsonb_build_object('pricingSourceSystem',p_plan->'pricingSourceSystem') ELSE '{}'::jsonb END || CASE WHEN p_plan ? 'inventoryBackendId' THEN jsonb_build_object('inventoryBackendId',p_plan->'inventoryBackendId') ELSE '{}'::jsonb END;
END;
$$;
--> statement-breakpoint
-- Demo-only materialization follows the real owner binding in its own commit. This function grants no
-- writer, company access or Privacy authority; those must already be enrolled for the one source.
CREATE FUNCTION symmy_integration.materialize_demo_group_membership_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE
  v_parent symmy_integration.job_routes%ROWTYPE;
  v_existing symmy_integration.job_routes%ROWTYPE;
  v_route_id uuid;
  v_digest bytea;
  v_plan jsonb;
  v_token integer;
  v_source_route constant uuid := 'f637a6ec-865b-43bc-9c28-57783757f367';
  v_tenant constant uuid := 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
  v_company constant uuid := 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM v_tenant OR NEW.legal_entity_id IS DISTINCT FROM v_company
    OR NEW.issuer IS DISTINCT FROM 'symmy-akros' OR NEW.namespace IS DISTINCT FROM 'akros-erp'
    OR NEW.source_intent #>> '{payload,source,route,id}' IS DISTINCT FROM v_source_route::text
  THEN RETURN NULL; END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR NEW.legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'demo membership source scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_parent FROM symmy_integration.job_routes r
    WHERE r.tenant_id=v_tenant AND r.route_id=v_source_route AND r.legal_entity_id=v_company
      AND r.route_key='customerGroupsBatch' AND r.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'demo group source is not enrolled' USING ERRCODE='55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'symmy-route-enrollment:'||v_tenant::text||':'||v_parent.principal_id::text||':customerGroups',0));
  SELECT * INTO v_parent FROM symmy_integration.job_routes r
    WHERE r.tenant_id=v_tenant AND r.route_id=v_source_route AND r.legal_entity_id=v_company
      AND r.route_key='customerGroupsBatch' AND r.active FOR SHARE;
  IF NOT FOUND OR v_parent.route_revision<>'v1' OR v_parent.mapping_version<>'v1'
    OR NEW.source_intent #>> '{payload,source,route,revision}' IS DISTINCT FROM 'v1'
    OR NEW.source_intent #>> '{payload,source,mappingRevision}' IS DISTINCT FROM 'v1'
    OR NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_routes r
      JOIN commerce_customer_context.customer_group_membership_source_routes m
        ON m.tenant_id=r.tenant_id AND m.legal_entity_id=r.legal_entity_id AND m.route_id=r.route_id
          AND m.route_revision=r.route_revision AND m.principal_id=r.principal_id
      WHERE r.tenant_id=v_tenant AND r.legal_entity_id=v_company AND r.route_id=v_source_route::text
        AND r.route_revision='v1' AND r.mapping_revision='v1' AND r.issuer=NEW.issuer AND r.namespace=NEW.namespace
        AND r.active AND m.active AND m.issuer=NEW.issuer AND m.source_namespace=NEW.namespace
        AND v_parent.principal_id=ANY(r.source_reader_principal_ids))
    OR NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_groups g
      WHERE g.tenant_id=v_tenant AND g.legal_entity_id=v_company AND g.customer_group_id=NEW.customer_group_id
        AND g.lifecycle='ACTIVE')
  THEN RAISE EXCEPTION 'demo membership source authority is not current' USING ERRCODE='42501'; END IF;

  -- RFC 4122 UUID-v5(group UUID text, groups route UUID), identical to the bootstrap's uuid.v5 call.
  -- pgcrypto is already installed by the required Party/Pricing owner migrations.
  v_digest := public.digest(uuid_send(v_source_route)||convert_to(NEW.customer_group_id::text,'UTF8'),'sha1');
  v_digest := set_byte(v_digest,6,(get_byte(v_digest,6)&15)|80);
  v_digest := set_byte(v_digest,8,(get_byte(v_digest,8)&63)|128);
  v_route_id := encode(substring(v_digest FROM 1 FOR 16),'hex')::uuid;
  v_plan := jsonb_build_object(
    'items',jsonb_build_array(jsonb_build_object(
      'itemKey','source-template',
      'source',jsonb_build_object('entityKind','CUSTOMER_GROUP','issuerId',NEW.issuer,
        'sourceNamespace',NEW.namespace,'sourceRecordId','ENROLLMENT_TEMPLATE'),
      'effects',jsonb_build_array(jsonb_build_object('effectKey','operation-0','operation',jsonb_build_object(
        'moduleId','commerce.customer-context',
        'entrypointKey','commerce.customer-context.apply-customer-group-membership-source','schemaVersion','1'))))),
    'sourceRouteId',v_source_route,'sourceRouteRevision','v1','sourceMappingVersion','v1',
    'selector',jsonb_build_object('kind','CUSTOMER_GROUP',
      'source',jsonb_build_object('entityKind','CUSTOMER_GROUP','issuerId',NEW.issuer,
        'sourceNamespace',NEW.namespace,'sourceRecordId',NEW.record_id,
        'route',jsonb_build_object('integrationRouteId',v_source_route,'tenantId',v_tenant)),
      'target',jsonb_build_object('moduleId','commerce.customer-context',
        'resourceType','commerce.customer-context.customer-group','resourceId',NEW.customer_group_id,'tenantId',v_tenant)));
  SELECT * INTO v_existing FROM symmy_integration.job_routes r
    WHERE r.tenant_id=v_tenant AND r.principal_id=v_parent.principal_id AND r.legal_entity_id=v_company
      AND r.route_key='customerGroupCustomersBatch' AND r.route_code=NEW.source_code AND r.active;
  IF FOUND THEN
    IF v_existing.fixture_plan IS DISTINCT FROM v_plan THEN
      RAISE EXCEPTION 'demo membership route conflicts with the owner binding' USING ERRCODE='23505'; END IF;
    RETURN NULL;
  END IF;
  -- Never revive an explicitly retired enrollment or replace its retained execution epoch.
  IF EXISTS(SELECT 1 FROM symmy_integration.job_routes r WHERE r.route_id=v_route_id) THEN
    RAISE EXCEPTION 'demo membership route was explicitly retired' USING ERRCODE='42501'; END IF;
  INSERT INTO symmy_integration.job_routes
    (tenant_id,route_id,principal_id,legal_entity_id,route_key,route_code,route_revision,mapping_version,
      active,fixture_ids,fixture_plan,lifecycle_policy)
    VALUES(v_tenant,v_route_id,v_parent.principal_id,v_company,'customerGroupCustomersBatch',NEW.source_code,
      'v1','v1',true,ARRAY['INTERNAL_C14'],v_plan,
      jsonb_build_object('policyId','akros-symmy-memberships','revision','v1'))
    RETURNING change_token INTO v_token;
  INSERT INTO symmy_integration.route_enrollment_records
    (tenant_id,route_id,legal_entity_id,route_key,route_revision,change,change_token,stated_operator_ref,reason)
    VALUES(v_tenant,v_route_id,v_company,'customerGroupCustomersBatch','v1','enroll',v_token,
      'symmy-demo-source-binding','Automatic demo membership selector for the committed source-owned group');
  RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.materialize_demo_group_membership_route() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER symmy_demo_group_membership_route
AFTER INSERT OR UPDATE ON commerce_customer_context.customer_group_definition_source_bindings
FOR EACH ROW EXECUTE FUNCTION symmy_integration.materialize_demo_group_membership_route();
