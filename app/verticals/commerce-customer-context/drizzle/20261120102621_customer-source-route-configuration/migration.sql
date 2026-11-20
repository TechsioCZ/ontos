-- One governed writer for the four Commerce source route registries. Runtime source routines only ever
-- read these rows; before this routine nothing but disposable test fixtures could establish them.
CREATE FUNCTION commerce_customer_context.customer_source_route_document(p_route jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT p_route
    || jsonb_build_object('principalId',(p_route->>'principalId')::uuid::text)
    || CASE WHEN p_route->>'_tag'='PROFILE' THEN jsonb_build_object('sourceReaderPrincipalIds',(
         SELECT coalesce(jsonb_agg(r.reader::uuid::text ORDER BY r.ordinal),'[]'::jsonb)
         FROM jsonb_array_elements_text(p_route->'sourceReaderPrincipalIds') WITH ORDINALITY AS r(reader,ordinal)))
       ELSE '{}'::jsonb END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_source_route_document(jsonb) FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.configure_customer_source_route(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE
  v_route jsonb:=commerce_customer_context.customer_source_route_document(p_input->'route');
  v_expected jsonb:=commerce_customer_context.customer_source_route_document(nullif(p_input->'expected','null'::jsonb));
  v_kind text:=p_input->'route'->>'_tag';
  v_id text:=p_input->'route'->'route'->>'id';
  v_current jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF v_id IS NULL OR v_kind IS NULL OR v_kind NOT IN ('PROFILE','GROUP_DEFINITION','MEMBERSHIP','SAVED_ADDRESS') THEN
    RAISE EXCEPTION 'one exact Commerce source route is required' USING ERRCODE = '22023';
  END IF;
  -- Serializes configuration of one route, including its first insert.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('ccc.source-route',p_tenant_id,p_legal_entity_id,v_kind,v_id)::text,0));
  IF v_kind='PROFILE' THEN
    SELECT jsonb_build_object('_tag','PROFILE','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'recordType',r.record_type,
        'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision),
        'sourceReaderPrincipalIds',to_jsonb(r.source_reader_principal_ids::text[]))
      INTO v_current FROM commerce_customer_context.customer_profile_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id FOR UPDATE;
  ELSIF v_kind='GROUP_DEFINITION' THEN
    SELECT jsonb_build_object('_tag','GROUP_DEFINITION','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision))
      INTO v_current FROM commerce_customer_context.customer_group_definition_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id FOR UPDATE;
  ELSIF v_kind='MEMBERSHIP' THEN
    SELECT jsonb_build_object('_tag','MEMBERSHIP','active',r.active,'allowComplete',r.allow_complete,
        'completenessContract',CASE WHEN r.completeness_contract_ref IS NULL AND r.completeness_contract_revision IS NULL
            AND r.completeness_contract_coverage IS NULL THEN 'null'::jsonb
          ELSE jsonb_build_object('coverage',r.completeness_contract_coverage,'ref',r.completeness_contract_ref,
            'revision',r.completeness_contract_revision) END,
        'issuer',r.issuer,'principalId',r.principal_id::text,'route',jsonb_build_object('id',r.route_id,'revision',r.route_revision),
        'sourceNamespace',r.source_namespace)
      INTO v_current FROM commerce_customer_context.customer_group_membership_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_id FOR UPDATE;
  ELSE
    SELECT jsonb_build_object('_tag','SAVED_ADDRESS','active',r.active,'issuer',r.issuer,'mappingRevision',r.mapping_revision,
        'namespace',r.namespace,'principalId',r.principal_id::text,'recordType',r.record_type,
        'route',jsonb_build_object('id',r.route_ref,'revision',r.route_revision))
      INTO v_current FROM commerce_customer_context.saved_address_source_routes r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_ref=v_id FOR UPDATE;
  END IF;
  IF v_current=v_route THEN
    RETURN QUERY SELECT 'UNCHANGED'::text,v_current; RETURN;
  END IF;
  -- An expected route of another registry entry can never equal this one, so it is a mismatch too.
  IF v_current IS DISTINCT FROM v_expected THEN
    RETURN QUERY SELECT 'EXPECTATION_MISMATCH'::text,v_current; RETURN;
  END IF;
  -- A route keeps the source it was configured for; another source needs its own route.
  IF v_current IS NOT NULL AND (v_current->>'issuer',v_current->>'namespace',v_current->>'sourceNamespace',v_current->>'recordType')
     IS DISTINCT FROM (v_route->>'issuer',v_route->>'namespace',v_route->>'sourceNamespace',v_route->>'recordType') THEN
    RETURN QUERY SELECT 'SOURCE_IDENTITY_IMMUTABLE'::text,v_current; RETURN;
  END IF;
  IF v_kind='PROFILE' THEN
    INSERT INTO commerce_customer_context.customer_profile_source_routes(tenant_id,legal_entity_id,route_id,route_revision,
        mapping_revision,issuer,namespace,record_type,principal_id,active,source_reader_principal_ids)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'mappingRevision',v_route->>'issuer',
        v_route->>'namespace',v_route->>'recordType',(v_route->>'principalId')::uuid,(v_route->>'active')::boolean,
        ARRAY(SELECT r.reader::uuid FROM jsonb_array_elements_text(v_route->'sourceReaderPrincipalIds') WITH ORDINALITY AS r(reader,ordinal) ORDER BY r.ordinal))
      ON CONFLICT (tenant_id,legal_entity_id,route_id) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        mapping_revision=EXCLUDED.mapping_revision,principal_id=EXCLUDED.principal_id,active=EXCLUDED.active,
        source_reader_principal_ids=EXCLUDED.source_reader_principal_ids;
  ELSIF v_kind='GROUP_DEFINITION' THEN
    INSERT INTO commerce_customer_context.customer_group_definition_source_routes(tenant_id,legal_entity_id,route_id,route_revision,
        mapping_revision,issuer,namespace,principal_id,active)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'mappingRevision',v_route->>'issuer',
        v_route->>'namespace',(v_route->>'principalId')::uuid,(v_route->>'active')::boolean)
      ON CONFLICT (tenant_id,legal_entity_id,route_id) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        mapping_revision=EXCLUDED.mapping_revision,principal_id=EXCLUDED.principal_id,active=EXCLUDED.active;
  ELSIF v_kind='MEMBERSHIP' THEN
    INSERT INTO commerce_customer_context.customer_group_membership_source_routes(tenant_id,legal_entity_id,route_id,route_revision,
        issuer,source_namespace,principal_id,active,allow_complete,completeness_contract_coverage,completeness_contract_ref,
        completeness_contract_revision)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'issuer',v_route->>'sourceNamespace',
        (v_route->>'principalId')::uuid,(v_route->>'active')::boolean,(v_route->>'allowComplete')::boolean,
        v_route->'completenessContract'->>'coverage',v_route->'completenessContract'->>'ref',v_route->'completenessContract'->>'revision')
      ON CONFLICT (tenant_id,legal_entity_id,route_id) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        principal_id=EXCLUDED.principal_id,active=EXCLUDED.active,allow_complete=EXCLUDED.allow_complete,
        completeness_contract_coverage=EXCLUDED.completeness_contract_coverage,
        completeness_contract_ref=EXCLUDED.completeness_contract_ref,
        completeness_contract_revision=EXCLUDED.completeness_contract_revision;
  ELSE
    INSERT INTO commerce_customer_context.saved_address_source_routes(tenant_id,legal_entity_id,route_ref,route_revision,
        mapping_revision,issuer,namespace,record_type,principal_id,active)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,v_route->'route'->>'revision',v_route->>'mappingRevision',v_route->>'issuer',
        v_route->>'namespace',v_route->>'recordType',(v_route->>'principalId')::uuid,(v_route->>'active')::boolean)
      ON CONFLICT (tenant_id,legal_entity_id,route_ref) DO UPDATE SET route_revision=EXCLUDED.route_revision,
        mapping_revision=EXCLUDED.mapping_revision,principal_id=EXCLUDED.principal_id,active=EXCLUDED.active;
  END IF;
  RETURN QUERY SELECT 'CONFIGURED'::text,v_route;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.configure_customer_source_route(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.configure_customer_source_route(uuid,uuid,jsonb) TO ontos_runtime;
