create or replace function commerce_market_catalog.transition_market_lifecycle(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_market commerce_market_catalog.markets%rowtype;
  v_current commerce_market_catalog.market_lifecycle_periods%rowtype;
  v_market_id uuid := (p_payload->>'marketId')::uuid;
  v_target text := p_payload->>'lifecycle';
  v_effective_at timestamptz := (p_payload->>'effectiveAt')::timestamptz;
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_retirement_impact jsonb := p_payload->'retirementImpactAssessment';
  v_generation integer;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  select * into v_market from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and market_id = v_market_id for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  if v_market.selling_legal_entity_id is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;
  if v_market.aggregate_revision is distinct from (p_payload->>'expectedRevision')::integer
     or v_market.current_definition_revision_id is distinct from (p_payload->>'expectedCurrentDefinitionRevisionId')::uuid then
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_market.aggregate_revision); return;
  end if;
  if v_target = 'RETIRED' and (
       jsonb_typeof(v_retirement_impact) is distinct from 'object'
       or (v_retirement_impact->>'assessedMarketRevision')::integer is distinct from v_market.aggregate_revision
       or (v_retirement_impact->>'effectiveAt')::timestamptz is distinct from v_effective_at
       or v_retirement_impact#>>'{assessedMarketRef,resourceId}' is distinct from v_market_id::text
       or v_retirement_impact#>>'{assessedMarketRef,tenantId}' is distinct from p_tenant_id::text
       or coalesce(v_retirement_impact->>'assessmentDigest', '') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_retirement_impact->'reservation') is distinct from 'object'
       or coalesce(v_retirement_impact#>>'{reservation,token}', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_retirement_impact#>'{reservation,version}') is distinct from 'number'
       or coalesce(v_retirement_impact#>>'{reservation,version}', '') !~ '^[1-9][0-9]*$'
       or jsonb_typeof(v_retirement_impact->'providers') is distinct from 'array'
       or jsonb_array_length(v_retirement_impact->'providers') = 0
     ) then
    return query select jsonb_build_object('_tag', 'replacement_impact_unresolved'); return;
  end if;
  select * into strict v_current from commerce_market_catalog.market_lifecycle_periods
    where tenant_id = p_tenant_id and market_id = v_market_id order by revision_number desc limit 1 for update;
  if v_current.lifecycle = v_target then
    select coalesce(generation, 0) into v_generation from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = p_tenant_id;
    return query select jsonb_build_object('_tag', 'transitioned', 'changed', false,
      'definitionRevisionId', v_market.current_definition_revision_id,
      'generation', coalesce(v_generation, 0), 'lifecycle', v_target, 'revision', v_market.aggregate_revision); return;
  end if;
  if v_current.lifecycle = 'RETIRED' or v_effective_at <= v_current.effective_from then
    return query select jsonb_build_object('_tag', 'invalid_lifecycle_transition'); return;
  end if;
  update commerce_market_catalog.market_lifecycle_periods set effective_to = v_effective_at
    where market_lifecycle_period_id = v_current.market_lifecycle_period_id;
  insert into commerce_market_catalog.market_lifecycle_periods (
    tenant_id, market_id, selling_legal_entity_id, revision_number, lifecycle,
    effective_from, reason, retirement_impact_assessment, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_market_id, p_legal_entity_id, v_current.revision_number + 1, v_target,
    v_effective_at, p_payload->>'reason', case when v_target = 'RETIRED' then v_retirement_impact else null end,
    v_action_id, (p_payload->>'principalId')::uuid, (p_payload->>'recordedAt')::timestamptz
  );
  update commerce_market_catalog.markets set aggregate_revision = aggregate_revision + 1
    where tenant_id = p_tenant_id and market_id = v_market_id
    returning aggregate_revision into v_market.aggregate_revision;
  v_generation := commerce_market_catalog.advance_completeness_generation(p_tenant_id, v_action_id);
  return query select jsonb_build_object('_tag', 'transitioned', 'changed', true,
    'definitionRevisionId', v_market.current_definition_revision_id, 'generation', v_generation,
    'lifecycle', v_target, 'revision', v_market.aggregate_revision);
end;
$$;
