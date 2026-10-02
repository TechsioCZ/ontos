create or replace function commerce_market_catalog.read_pricing_current_market_evidence(
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
  v_channel text;
  v_definition commerce_market_catalog.market_definition_revisions%rowtype;
  v_definition_count integer := 0;
  v_effective_at timestamptz;
  v_generation integer;
  v_lifecycle commerce_market_catalog.market_lifecycle_periods%rowtype;
  v_lifecycle_count integer := 0;
  v_market commerce_market_catalog.markets%rowtype;
  v_market_id uuid;
  v_next_boundary timestamptz;
  v_observed_at timestamptz := statement_timestamp();
  v_reason text;
  v_state text;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Pricing Market evidence input must be an object';
  end if;

  begin
    v_channel := p_payload->>'channel';
    v_effective_at := (p_payload->>'effectiveAt')::timestamptz;
    v_market_id := (p_payload->>'marketId')::uuid;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'Pricing Market evidence input is invalid';
  end;
  if v_channel not in ('B2C', 'B2B') or v_effective_at is null or v_market_id is null then
    raise exception using errcode = '22023', message = 'Pricing Market evidence input is incomplete';
  end if;

  select generation into v_generation
  from commerce_market_catalog.market_catalog_completeness_generations
  where tenant_id = p_tenant_id;

  select * into v_market
  from commerce_market_catalog.markets
  where tenant_id = p_tenant_id and market_id = v_market_id;

  if v_effective_at > v_observed_at then
    v_state := 'UNVERIFIABLE';
    v_reason := 'The requested Pricing operation time is later than the owner observation';
  elsif v_generation is null then
    v_state := 'MISSING';
    v_reason := 'Market Catalog completeness generation is unavailable';
  elsif v_market.market_id is null or v_market.selling_legal_entity_id is distinct from p_legal_entity_id then
    v_state := 'ABSENT';
  else
    select count(*)::integer into v_definition_count
    from commerce_market_catalog.market_definition_revisions definition
    where definition.tenant_id = p_tenant_id
      and definition.market_id = v_market_id
      and definition.selling_legal_entity_id = p_legal_entity_id
      and definition.effective_from <= v_effective_at
      and (definition.effective_to is null or definition.effective_to > v_effective_at);

    select count(*)::integer into v_lifecycle_count
    from commerce_market_catalog.market_lifecycle_periods lifecycle
    where lifecycle.tenant_id = p_tenant_id
      and lifecycle.market_id = v_market_id
      and lifecycle.selling_legal_entity_id = p_legal_entity_id
      and lifecycle.effective_from <= v_effective_at
      and (lifecycle.effective_to is null or lifecycle.effective_to > v_effective_at);

    if v_definition_count > 1 or v_lifecycle_count > 1 then
      v_state := 'CONFLICT';
      v_reason := 'Multiple Current Market definition or lifecycle facts match the exact scope';
    elsif v_definition_count = 0 or v_lifecycle_count = 0 then
      v_state := 'MISSING';
      v_reason := 'Current Market definition or lifecycle evidence is incomplete';
    else
      select * into strict v_definition
      from commerce_market_catalog.market_definition_revisions definition
      where definition.tenant_id = p_tenant_id
        and definition.market_id = v_market_id
        and definition.selling_legal_entity_id = p_legal_entity_id
        and definition.effective_from <= v_effective_at
        and (definition.effective_to is null or definition.effective_to > v_effective_at);

      select * into strict v_lifecycle
      from commerce_market_catalog.market_lifecycle_periods lifecycle
      where lifecycle.tenant_id = p_tenant_id
        and lifecycle.market_id = v_market_id
        and lifecycle.selling_legal_entity_id = p_legal_entity_id
        and lifecycle.effective_from <= v_effective_at
        and (lifecycle.effective_to is null or lifecycle.effective_to > v_effective_at);

      v_state := case
        when v_lifecycle.lifecycle = 'ACTIVE' and v_definition.channels ? v_channel then 'PRESENT'
        else 'ABSENT'
      end;
    end if;
  end if;

  if v_market.market_id is not null then
    select min(boundary) into v_next_boundary
    from (
      select candidate.boundary
      from commerce_market_catalog.market_definition_revisions definition
      cross join lateral (values (definition.effective_from), (definition.effective_to)) candidate(boundary)
      where definition.tenant_id = p_tenant_id
        and definition.market_id = v_market_id
        and candidate.boundary > greatest(v_effective_at, v_observed_at)
      union all
      select candidate.boundary
      from commerce_market_catalog.market_lifecycle_periods lifecycle
      cross join lateral (values (lifecycle.effective_from), (lifecycle.effective_to)) candidate(boundary)
      where lifecycle.tenant_id = p_tenant_id
        and lifecycle.market_id = v_market_id
        and candidate.boundary > greatest(v_effective_at, v_observed_at)
    ) future_boundaries;
  end if;

  return query select jsonb_strip_nulls(jsonb_build_object(
    'definitionRevisionRef', case when v_state = 'PRESENT' then v_definition.market_definition_revision_id::text end,
    'effectivePeriod', case when v_state = 'PRESENT' then jsonb_strip_nulls(jsonb_build_object(
      'startsAt', greatest(v_definition.effective_from, v_lifecycle.effective_from),
      'endsAt', case
        when v_definition.effective_to is null and v_lifecycle.effective_to is null then null
        else least(
          coalesce(v_definition.effective_to, 'infinity'::timestamptz),
          coalesce(v_lifecycle.effective_to, 'infinity'::timestamptz)
        )
      end
    )) end,
    'generation', coalesce(v_generation, 0),
    'lifecycleRevisionRef', case when v_state = 'PRESENT' then v_lifecycle.market_lifecycle_period_id::text end,
    'market', case when v_state = 'PRESENT' then jsonb_strip_nulls(jsonb_build_object(
      'channels', v_definition.channels,
      'definitionRevisionRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog',
        'resourceId', v_definition.market_definition_revision_id,
        'resourceType', 'commerce.market-catalog.market-definition-revision',
        'tenantId', p_tenant_id
      ),
      'effectivePeriod', jsonb_strip_nulls(jsonb_build_object(
        'startsAt', v_definition.effective_from,
        'endsAt', v_definition.effective_to
      )),
      'jurisdictions', v_definition.jurisdictions,
      'lifecycle', v_lifecycle.lifecycle,
      'marketCode', v_market.business_code,
      'marketRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog',
        'resourceId', v_market.market_id,
        'resourceType', 'commerce.market-catalog.market',
        'tenantId', p_tenant_id
      ),
      'previousDefinitionRevisionRef', case when v_definition.revision_number > 1 then (
        select jsonb_build_object(
          'moduleId', 'commerce.market-catalog',
          'resourceId', previous.market_definition_revision_id,
          'resourceType', 'commerce.market-catalog.market-definition-revision',
          'tenantId', p_tenant_id
        )
        from commerce_market_catalog.market_definition_revisions previous
        where previous.tenant_id = p_tenant_id
          and previous.market_id = v_market_id
          and previous.revision_number = v_definition.revision_number - 1
      ) end,
      'purpose', v_definition.purpose,
      'revision', v_definition.revision_number,
      'sellingLegalEntityRef', jsonb_build_object(
        'moduleId', 'core.identity',
        'resourceId', p_legal_entity_id,
        'resourceType', 'core.identity.legal-entity',
        'tenantId', p_tenant_id
      ),
      'supportedLocales', v_definition.supported_locales
    )) end,
    'nextApplicabilityBoundary', v_next_boundary,
    'observedAt', v_observed_at,
    'reason', v_reason,
    'state', v_state
  ));
end;
$$;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_pricing_current_market_evidence(uuid, uuid, jsonb) from public;
revoke all on function commerce_market_catalog.read_pricing_current_market_evidence(uuid, uuid, jsonb) from ontos_runtime;
grant execute on function commerce_market_catalog.read_pricing_current_market_evidence(uuid, uuid, jsonb) to ontos_runtime;
