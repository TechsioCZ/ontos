-- Keep the physical enrollment distinct from the exact logical source it actually enrolls.
CREATE OR REPLACE FUNCTION symmy_integration.materialize_demo_group_membership_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE
  v_parent symmy_integration.job_routes%ROWTYPE;
  v_existing symmy_integration.job_routes%ROWTYPE;
  v_route_id uuid;
  v_digest bytea;
  v_plan jsonb;
  v_token integer;
  v_enrollment_route constant uuid := 'f637a6ec-865b-43bc-9c28-57783757f367';
  v_source_route constant uuid := '5a6fb39a-c26e-4186-9dc2-5e410210d36c';
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
    WHERE r.tenant_id=v_tenant AND r.route_id=v_enrollment_route AND r.legal_entity_id=v_company
      AND r.route_key='customerGroupsBatch' AND r.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'demo group source is not enrolled' USING ERRCODE='55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'symmy-route-enrollment:'||v_tenant::text||':'||v_parent.principal_id::text||':customerGroups',0));
  SELECT * INTO v_parent FROM symmy_integration.job_routes r
    WHERE r.tenant_id=v_tenant AND r.route_id=v_enrollment_route AND r.legal_entity_id=v_company
      AND r.route_key='customerGroupsBatch' AND r.active FOR SHARE;
  IF NOT FOUND OR v_parent.fixture_plan->>'sourceRouteId' IS DISTINCT FROM v_source_route::text
    OR v_parent.fixture_plan->>'sourceRouteRevision' IS DISTINCT FROM 'v1'
    OR v_parent.fixture_plan->>'sourceMappingVersion' IS DISTINCT FROM 'v1'
    OR v_parent.route_revision<>'v1' OR v_parent.mapping_version<>'v1'
    OR NEW.source_intent #>> '{payload,source,route,revision}' IS DISTINCT FROM 'v1'
    OR NEW.source_intent #>> '{payload,source,mappingRevision}' IS DISTINCT FROM 'v1'
    OR NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_routes r
      JOIN commerce_customer_context.customer_group_membership_source_routes m
        ON m.tenant_id=r.tenant_id AND m.legal_entity_id=r.legal_entity_id AND m.route_id=r.route_id
          AND m.route_revision=r.route_revision AND m.principal_id=r.principal_id
      WHERE r.tenant_id=v_tenant AND r.legal_entity_id=v_company AND r.route_id=v_source_route::text
        AND r.route_revision='v1' AND r.mapping_revision='v1' AND r.issuer=NEW.issuer AND r.namespace=NEW.namespace
        AND r.active AND m.active AND m.issuer=NEW.issuer AND m.source_namespace=NEW.namespace
        AND (SELECT count(DISTINCT native.principal_id)
          FROM unnest(r.source_reader_principal_ids) AS named(principal_id)
          JOIN core.principals native ON native.tenant_id=r.tenant_id AND native.principal_id=named.principal_id
            AND native.kind='system' AND native.status='active'
          JOIN core.access_workload_bindings binding ON binding.tenant_id=native.tenant_id
            AND binding.principal_id=native.principal_id AND binding.status='active'
            AND binding.workload_key='commerce.customer-context.source-read'
          JOIN core.access_workload_company_bindings company ON company.tenant_id=binding.tenant_id
            AND company.workload_binding_id=binding.binding_id AND company.legal_entity_id=r.legal_entity_id
            AND company.status='active')=1)
    OR NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_groups g
      WHERE g.tenant_id=v_tenant AND g.legal_entity_id=v_company AND g.customer_group_id=NEW.customer_group_id
        AND g.lifecycle='ACTIVE')
  THEN RAISE EXCEPTION 'demo membership source authority is not current' USING ERRCODE='42501'; END IF;

  -- RFC 4122 UUID-v5(group UUID text, groups route UUID), identical to the bootstrap's uuid.v5 call.
  -- pgcrypto is already installed by the required Party/Pricing owner migrations.
  v_digest := public.digest(uuid_send(v_enrollment_route)||convert_to(NEW.customer_group_id::text,'UTF8'),'sha1');
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
