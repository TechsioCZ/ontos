create or replace function commerce_market_catalog.read_current_market_catalog(
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
  v_at timestamptz;
  v_generation integer;
  v_observed_at timestamptz := statement_timestamp();
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'current Market Catalog input must be an object';
  end if;
  begin
    v_at := (p_payload->>'at')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'current Market Catalog instant is invalid';
  end;
  if v_at is null then
    raise exception using errcode = '22023', message = 'current Market Catalog instant is required';
  end if;

  select generation into v_generation
  from commerce_market_catalog.market_catalog_completeness_generations
  where tenant_id = p_tenant_id;
  if v_generation is null and exists (
    select 1 from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and selling_legal_entity_id = p_legal_entity_id
  ) then
    raise exception using errcode = '55000', message = 'Market Catalog completeness generation is unavailable';
  end if;
  v_generation := coalesce(v_generation, 0);

  if exists (
    select 1
    from commerce_market_catalog.markets market
    where market.tenant_id = p_tenant_id
      and market.selling_legal_entity_id = p_legal_entity_id
      and (
        exists (
          select 1 from commerce_market_catalog.market_definition_revisions definition
          where definition.tenant_id = p_tenant_id and definition.market_id = market.market_id
            and definition.effective_from <= v_at
            and (definition.effective_to is null or definition.effective_to > v_at)
        )
        is distinct from
        exists (
          select 1 from commerce_market_catalog.market_lifecycle_periods lifecycle
          where lifecycle.tenant_id = p_tenant_id and lifecycle.market_id = market.market_id
            and lifecycle.effective_from <= v_at
            and (lifecycle.effective_to is null or lifecycle.effective_to > v_at)
        )
      )
  ) then
    raise exception using errcode = '55000', message = 'Current Market definition and lifecycle evidence is incomplete';
  end if;

  if exists (
    select 1
    from (
      select association.*,
        row_number() over (
          partition by association.storefront_association_id
          order by association.revision_number desc, association.storefront_association_revision_id desc
        ) as applicability_rank
      from commerce_market_catalog.storefront_association_revisions association
      where association.tenant_id = p_tenant_id
        and association.selling_legal_entity_id = p_legal_entity_id
        and association.effective_from <= v_at
        and (association.effective_to is null or association.effective_to > v_at)
        and (association.removed_at is null or association.removed_at > v_at)
    ) association
    where association.applicability_rank = 1
      and not exists (
        select 1
        from commerce_market_catalog.market_definition_revisions definition
        join commerce_market_catalog.market_lifecycle_periods lifecycle
          on lifecycle.tenant_id = definition.tenant_id
         and lifecycle.market_id = definition.market_id
         and lifecycle.effective_from <= v_at
         and (lifecycle.effective_to is null or lifecycle.effective_to > v_at)
        where definition.tenant_id = p_tenant_id
          and definition.market_id = association.market_id
          and definition.effective_from <= v_at
          and (definition.effective_to is null or definition.effective_to > v_at)
      )
  ) then
    raise exception using errcode = '55000', message = 'Current Storefront association lacks Current Market evidence';
  end if;

  return query
  with current_definitions as (
    select candidate.*
    from (
      select definition.*,
        row_number() over (
          partition by definition.market_id
          order by definition.revision_number desc, definition.market_definition_revision_id desc
        ) as applicability_rank
      from commerce_market_catalog.market_definition_revisions definition
      where definition.tenant_id = p_tenant_id
        and definition.selling_legal_entity_id = p_legal_entity_id
        and definition.effective_from <= v_at
        and (definition.effective_to is null or definition.effective_to > v_at)
    ) candidate
    where candidate.applicability_rank = 1
  ),
  current_lifecycles as (
    select candidate.*
    from (
      select lifecycle.*,
        row_number() over (
          partition by lifecycle.market_id
          order by lifecycle.revision_number desc, lifecycle.market_lifecycle_period_id desc
        ) as applicability_rank
      from commerce_market_catalog.market_lifecycle_periods lifecycle
      where lifecycle.tenant_id = p_tenant_id
        and lifecycle.selling_legal_entity_id = p_legal_entity_id
        and lifecycle.effective_from <= v_at
        and (lifecycle.effective_to is null or lifecycle.effective_to > v_at)
    ) candidate
    where candidate.applicability_rank = 1
  ),
  current_associations as (
    select candidate.*
    from (
      select association.*,
        row_number() over (
          partition by association.storefront_association_id
          order by association.revision_number desc, association.storefront_association_revision_id desc
        ) as applicability_rank
      from commerce_market_catalog.storefront_association_revisions association
      where association.tenant_id = p_tenant_id
        and association.selling_legal_entity_id = p_legal_entity_id
        and association.effective_from <= v_at
        and (association.effective_to is null or association.effective_to > v_at)
        and (association.removed_at is null or association.removed_at > v_at)
    ) candidate
    where candidate.applicability_rank = 1
  ),
  market_values as (
    select jsonb_strip_nulls(jsonb_build_object(
      'channels', definition.channels,
      'definitionRevisionRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', definition.market_definition_revision_id,
        'resourceType', 'commerce.market-catalog.market-definition-revision', 'tenantId', p_tenant_id
      ),
      'effectivePeriod', jsonb_strip_nulls(jsonb_build_object(
        'startsAt', definition.effective_from, 'endsAt', definition.effective_to
      )),
      'jurisdictions', definition.jurisdictions,
      'lifecycle', lifecycle.lifecycle,
      'marketCode', market.business_code,
      'marketRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', market.market_id,
        'resourceType', 'commerce.market-catalog.market', 'tenantId', p_tenant_id
      ),
      'previousDefinitionRevisionRef', case when definition.revision_number > 1 then (
        select jsonb_build_object(
          'moduleId', 'commerce.market-catalog', 'resourceId', previous.market_definition_revision_id,
          'resourceType', 'commerce.market-catalog.market-definition-revision', 'tenantId', p_tenant_id
        )
        from commerce_market_catalog.market_definition_revisions previous
        where previous.tenant_id = p_tenant_id and previous.market_id = market.market_id
          and previous.revision_number = definition.revision_number - 1
      ) end,
      'purpose', definition.purpose,
      'revision', definition.revision_number,
      'sellingLegalEntityRef', jsonb_build_object(
        'moduleId', 'core.identity', 'resourceId', market.selling_legal_entity_id,
        'resourceType', 'core.identity.legal-entity', 'tenantId', p_tenant_id
      ),
      'supportedLocales', definition.supported_locales
    )) as value, market.market_id
    from commerce_market_catalog.markets market
    join current_definitions definition on definition.market_id = market.market_id
    join current_lifecycles lifecycle on lifecycle.market_id = market.market_id
    where market.tenant_id = p_tenant_id and market.selling_legal_entity_id = p_legal_entity_id
  ),
  association_values as (
    select jsonb_strip_nulls(jsonb_build_object(
      'associationRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', association.storefront_association_id,
        'resourceType', 'commerce.market-catalog.storefront-association', 'tenantId', p_tenant_id
      ),
      'channel', association.channel,
      'effectivePeriod', jsonb_strip_nulls(jsonb_build_object(
        'startsAt', association.effective_from, 'endsAt', association.effective_to
      )),
      'marketDefinitionRevisionRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', association.market_definition_revision_id,
        'resourceType', 'commerce.market-catalog.market-definition-revision', 'tenantId', p_tenant_id
      ),
      'marketRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', association.market_id,
        'resourceType', 'commerce.market-catalog.market', 'tenantId', p_tenant_id
      ),
      'previousAssociationRevision', case when association.revision_number > 1 then association.revision_number - 1 end,
      'provenance', jsonb_build_object(
        'kind', association.provenance_kind, 'reference', association.provenance_reference
      ),
      'revision', association.revision_number,
      'sellingLegalEntityRef', jsonb_build_object(
        'moduleId', 'core.identity', 'resourceId', association.selling_legal_entity_id,
        'resourceType', 'core.identity.legal-entity', 'tenantId', p_tenant_id
      ),
      'storefrontRef', jsonb_build_object('appId', association.storefront_app_id, 'tenantId', p_tenant_id)
    )) as value, association.storefront_association_id
    from current_associations association
  )
  select jsonb_build_object(
    'associations', coalesce((select jsonb_agg(value order by storefront_association_id) from association_values), '[]'::jsonb),
    'completenessEvidence', jsonb_build_object(
      'observedAt', v_observed_at,
      'ownerRevision', 'commerce.market-catalog.current:v1:generation:' || v_generation,
      'scope', jsonb_build_object(
        'kind', 'EXACT_PREDICATE',
        'predicateRef', 'commerce.market-catalog.current:v1:' || p_tenant_id || ':' || p_legal_entity_id || ':' ||
          to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    ),
    'markets', coalesce((select jsonb_agg(value order by market_id) from market_values), '[]'::jsonb),
    'observedAt', v_observed_at
  );
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.read_market_history(
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
  v_market_id uuid;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Market history input must be an object';
  end if;
  begin
    v_market_id := (p_payload->>'marketId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Market history identity is invalid';
  end;
  if v_market_id is null then
    raise exception using errcode = '22023', message = 'Market history identity is required';
  end if;
  if not exists (
    select 1 from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and selling_legal_entity_id = p_legal_entity_id and market_id = v_market_id
  ) then
    return;
  end if;
  if not exists (
    select 1 from commerce_market_catalog.market_definition_revisions
    where tenant_id = p_tenant_id and market_id = v_market_id
  ) then
    raise exception using errcode = '55000', message = 'Market definition history is unavailable';
  end if;
  if exists (
    select 1
    from commerce_market_catalog.market_definition_revisions definition
    where definition.tenant_id = p_tenant_id and definition.market_id = v_market_id
      and not exists (
        select 1 from commerce_market_catalog.market_lifecycle_periods lifecycle
        where lifecycle.tenant_id = p_tenant_id and lifecycle.market_id = v_market_id
          and lifecycle.effective_from <= definition.effective_from
          and (lifecycle.effective_to is null or lifecycle.effective_to > definition.effective_from)
      )
  ) then
    raise exception using errcode = '55000', message = 'Market lifecycle history is incomplete';
  end if;

  return query
  with market_head as (
    select * from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and selling_legal_entity_id = p_legal_entity_id and market_id = v_market_id
  ),
  definition_values as (
    select jsonb_strip_nulls(jsonb_build_object(
      'channels', definition.channels,
      'definitionRevisionRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', definition.market_definition_revision_id,
        'resourceType', 'commerce.market-catalog.market-definition-revision', 'tenantId', p_tenant_id
      ),
      'effectivePeriod', jsonb_strip_nulls(jsonb_build_object(
        'startsAt', definition.effective_from, 'endsAt', definition.effective_to
      )),
      'jurisdictions', definition.jurisdictions,
      'lifecycle', lifecycle.lifecycle,
      'marketCode', market.business_code,
      'marketRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', market.market_id,
        'resourceType', 'commerce.market-catalog.market', 'tenantId', p_tenant_id
      ),
      'previousDefinitionRevisionRef', case when definition.revision_number > 1 then (
        select jsonb_build_object(
          'moduleId', 'commerce.market-catalog', 'resourceId', previous.market_definition_revision_id,
          'resourceType', 'commerce.market-catalog.market-definition-revision', 'tenantId', p_tenant_id
        )
        from commerce_market_catalog.market_definition_revisions previous
        where previous.tenant_id = p_tenant_id and previous.market_id = v_market_id
          and previous.revision_number = definition.revision_number - 1
      ) end,
      'purpose', definition.purpose,
      'revision', definition.revision_number,
      'sellingLegalEntityRef', jsonb_build_object(
        'moduleId', 'core.identity', 'resourceId', market.selling_legal_entity_id,
        'resourceType', 'core.identity.legal-entity', 'tenantId', p_tenant_id
      ),
      'supportedLocales', definition.supported_locales
    )) as value, definition.revision_number
    from market_head market
    join commerce_market_catalog.market_definition_revisions definition
      on definition.tenant_id = p_tenant_id and definition.market_id = market.market_id
    join lateral (
      select lifecycle.lifecycle
      from commerce_market_catalog.market_lifecycle_periods lifecycle
      where lifecycle.tenant_id = p_tenant_id and lifecycle.market_id = market.market_id
        and lifecycle.effective_from <= definition.effective_from
        and (lifecycle.effective_to is null or lifecycle.effective_to > definition.effective_from)
      order by lifecycle.revision_number desc, lifecycle.market_lifecycle_period_id desc
      limit 1
    ) lifecycle on true
  ),
  association_values as (
    select jsonb_strip_nulls(jsonb_build_object(
      'associationRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', association.storefront_association_id,
        'resourceType', 'commerce.market-catalog.storefront-association', 'tenantId', p_tenant_id
      ),
      'channel', association.channel,
      'effectivePeriod', jsonb_strip_nulls(jsonb_build_object(
        'startsAt', association.effective_from, 'endsAt', association.effective_to
      )),
      'marketDefinitionRevisionRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', association.market_definition_revision_id,
        'resourceType', 'commerce.market-catalog.market-definition-revision', 'tenantId', p_tenant_id
      ),
      'marketRef', jsonb_build_object(
        'moduleId', 'commerce.market-catalog', 'resourceId', association.market_id,
        'resourceType', 'commerce.market-catalog.market', 'tenantId', p_tenant_id
      ),
      'previousAssociationRevision', case when association.revision_number > 1 then association.revision_number - 1 end,
      'provenance', jsonb_build_object(
        'kind', association.provenance_kind, 'reference', association.provenance_reference
      ),
      'revision', association.revision_number,
      'sellingLegalEntityRef', jsonb_build_object(
        'moduleId', 'core.identity', 'resourceId', association.selling_legal_entity_id,
        'resourceType', 'core.identity.legal-entity', 'tenantId', p_tenant_id
      ),
      'storefrontRef', jsonb_build_object('appId', association.storefront_app_id, 'tenantId', p_tenant_id)
    )) as value, association.storefront_association_id, association.revision_number
    from commerce_market_catalog.storefront_association_revisions association
    where association.tenant_id = p_tenant_id and association.selling_legal_entity_id = p_legal_entity_id
      and association.market_id = v_market_id
  )
  select jsonb_build_object(
    'associations', coalesce((
      select jsonb_agg(value order by storefront_association_id, revision_number) from association_values
    ), '[]'::jsonb),
    'definitions', (select jsonb_agg(value order by revision_number) from definition_values),
    'marketRef', jsonb_build_object(
      'moduleId', 'commerce.market-catalog', 'resourceId', v_market_id,
      'resourceType', 'commerce.market-catalog.market', 'tenantId', p_tenant_id
    )
  );
end;
$$;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_current_market_catalog(uuid, uuid, jsonb) from public;
revoke all on function commerce_market_catalog.read_market_history(uuid, uuid, jsonb) from public;
revoke all on function commerce_market_catalog.read_current_market_catalog(uuid, uuid, jsonb) from ontos_runtime;
revoke all on function commerce_market_catalog.read_market_history(uuid, uuid, jsonb) from ontos_runtime;
grant execute on function commerce_market_catalog.read_current_market_catalog(uuid, uuid, jsonb) to ontos_runtime;
grant execute on function commerce_market_catalog.read_market_history(uuid, uuid, jsonb) to ontos_runtime;
