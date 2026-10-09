create or replace function commerce_market_catalog.read_market_eligibility_snapshot(
  p_tenant_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_effective_at timestamptz;
  v_allowed_channels text[];
  v_allowed_market_ids uuid[];
  v_allowed_seller_ids uuid[];
  v_channel text;
  v_observed_at timestamptz := statement_timestamp();
  v_selling_legal_entity_id uuid;
  v_storefront_app_id text;
  v_subject_decision text;
  v_subject_identity_ref text;
  v_subject_kind text;
  v_subject_owner_revision text;
  v_subject_profile_state text;
begin
  if p_tenant_id is null
     or p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid then
    raise exception using errcode = '42501', message = 'market eligibility read scope mismatch';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'market eligibility input must be an object';
  end if;

  begin
    v_effective_at := (p_payload->>'effectiveAt')::timestamptz;
    v_channel := p_payload->>'channel';
    v_selling_legal_entity_id := nullif(p_payload->>'sellingLegalEntityId', '')::uuid;
    v_storefront_app_id := p_payload->>'storefrontAppId';
    v_subject_decision := p_payload->>'subjectDecision';
    v_subject_identity_ref := p_payload->>'subjectIdentityRef';
    v_subject_kind := p_payload->>'subjectKind';
    v_subject_owner_revision := p_payload->>'subjectOwnerRevision';
    v_subject_profile_state := p_payload->>'subjectProfileState';
    select array_agg(value::uuid) into v_allowed_seller_ids
    from jsonb_array_elements_text(coalesce(p_payload->'allowedSellerIds', '[]'::jsonb));
    select array_agg(value::uuid) into v_allowed_market_ids
    from jsonb_array_elements_text(coalesce(p_payload->'allowedMarketIds', '[]'::jsonb));
    select array_agg(value) into v_allowed_channels
    from jsonb_array_elements_text(coalesce(p_payload->'allowedChannels', '[]'::jsonb));
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'market eligibility input is invalid';
  end;

  if v_effective_at is null
     or v_channel is null
     or v_channel not in ('B2C', 'B2B')
     or v_storefront_app_id is null
     or v_storefront_app_id <> btrim(v_storefront_app_id)
     or length(v_storefront_app_id) = 0 then
    raise exception using errcode = '22023', message = 'market eligibility input is invalid';
  end if;
  if v_subject_kind is not null and (
    v_subject_kind not in ('RETAIL_PROFILE', 'COUNTERPARTY')
    or v_subject_identity_ref is null
    or v_subject_owner_revision is null
    or v_subject_decision not in ('ALLOWED', 'DENIED')
    or v_subject_profile_state not in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')
    or v_allowed_seller_ids is null
    or v_allowed_channels is null
  ) then
    raise exception using errcode = '22023', message = 'subject restriction evidence is invalid';
  end if;

  return query
  with current_association_candidates as (
    select
      association.*,
      row_number() over (
        partition by association.storefront_association_id
        order by association.revision_number desc, association.storefront_association_revision_id desc
      ) as applicability_rank
    from commerce_market_catalog.storefront_association_revisions association
    where association.tenant_id = p_tenant_id
      and association.effective_from <= v_effective_at
      and (association.effective_to is null or association.effective_to > v_effective_at)
      and (association.removed_at is null or association.removed_at > v_effective_at)
  ),
  current_associations as (
    select association.*
    from current_association_candidates association
    where association.applicability_rank = 1
      and association.storefront_app_id = v_storefront_app_id
      and association.channel = v_channel
      and (v_subject_decision is null or (v_subject_decision = 'ALLOWED' and v_subject_profile_state = 'ACTIVE'))
      and (v_allowed_channels is null or association.channel = any(v_allowed_channels))
      and (v_allowed_market_ids is null or association.market_id = any(v_allowed_market_ids))
      and (v_allowed_seller_ids is null or association.selling_legal_entity_id = any(v_allowed_seller_ids))
      and (
        v_selling_legal_entity_id is null
        or association.selling_legal_entity_id = v_selling_legal_entity_id
      )
  ),
  current_facts as (
    select
      association.storefront_association_id,
      association.revision_number,
      jsonb_build_object(
        'associationId', association.storefront_association_id,
        'associationRevision', association.revision_number,
        'associationChannel', association.channel,
        'marketId', association.market_id,
        'sellingLegalEntityId', association.selling_legal_entity_id,
        'marketDefinitionRevisionId', definition.market_definition_revision_id,
        'lifecycle', lifecycle.lifecycle
      ) as fact
    from current_associations association
    join lateral (
      select definition.channels, definition.market_definition_revision_id
      from commerce_market_catalog.market_definition_revisions definition
      where definition.tenant_id = p_tenant_id
        and definition.market_id = association.market_id
        and definition.effective_from <= v_effective_at
        and (definition.effective_to is null or definition.effective_to > v_effective_at)
      order by definition.revision_number desc, definition.market_definition_revision_id desc
      limit 1
    ) definition on true
    join lateral (
      select lifecycle.lifecycle
      from commerce_market_catalog.market_lifecycle_periods lifecycle
      where lifecycle.tenant_id = p_tenant_id
        and lifecycle.market_id = association.market_id
        and lifecycle.effective_from <= v_effective_at
        and (lifecycle.effective_to is null or lifecycle.effective_to > v_effective_at)
      order by lifecycle.revision_number desc, lifecycle.market_lifecycle_period_id desc
      limit 1
    ) lifecycle on true
    where definition.channels ? association.channel
  ),
  predicate_association_ids as (
    select distinct association.storefront_association_id
    from commerce_market_catalog.storefront_association_revisions association
    where association.tenant_id = p_tenant_id
      and association.storefront_app_id = v_storefront_app_id
      and association.channel = v_channel
      and (v_allowed_market_ids is null or association.market_id = any(v_allowed_market_ids))
      and (v_allowed_seller_ids is null or association.selling_legal_entity_id = any(v_allowed_seller_ids))
      and (
        v_selling_legal_entity_id is null
        or association.selling_legal_entity_id = v_selling_legal_entity_id
      )
  ),
  predicate_association_rows as (
    select association.*
    from commerce_market_catalog.storefront_association_revisions association
    join predicate_association_ids relevant
      on relevant.storefront_association_id = association.storefront_association_id
    where association.tenant_id = p_tenant_id
  ),
  predicate_markets as (
    select distinct association.market_id
    from predicate_association_rows association
  ),
  predicate_material as (
    select
      'subject-restrictions' as material_key,
      jsonb_build_object(
        'kind', 'subject-restrictions',
        'subjectKind', v_subject_kind,
        'subjectIdentityRef', v_subject_identity_ref,
        'ownerRevision', v_subject_owner_revision,
        'decision', v_subject_decision,
        'profileState', v_subject_profile_state,
        'allowedChannels', to_jsonb(v_allowed_channels),
        'allowedMarketIds', to_jsonb(v_allowed_market_ids),
        'allowedSellerIds', to_jsonb(v_allowed_seller_ids)
      ) as material
    where v_subject_kind is not null

    union all

    select
      'association:' || association.storefront_association_id::text || ':' || association.revision_number::text as material_key,
      jsonb_build_object(
        'kind', 'association',
        'associationId', association.storefront_association_id,
        'associationRevisionId', association.storefront_association_revision_id,
        'revision', association.revision_number,
        'marketId', association.market_id,
        'marketDefinitionRevisionId', association.market_definition_revision_id,
        'sellingLegalEntityId', association.selling_legal_entity_id,
        'storefrontAppId', association.storefront_app_id,
        'channel', association.channel,
        'effectiveFrom', association.effective_from,
        'effectiveTo', association.effective_to,
        'removedAt', association.removed_at
      ) as material
    from predicate_association_rows association

    union all

    select
      'definition:' || definition.market_definition_revision_id::text,
      jsonb_build_object(
        'kind', 'definition',
        'marketDefinitionRevisionId', definition.market_definition_revision_id,
        'marketId', definition.market_id,
        'sellingLegalEntityId', definition.selling_legal_entity_id,
        'revision', definition.revision_number,
        'channels', definition.channels,
        'jurisdictions', definition.jurisdictions,
        'supportedLocales', definition.supported_locales,
        'effectiveFrom', definition.effective_from,
        'effectiveTo', definition.effective_to
      )
    from commerce_market_catalog.market_definition_revisions definition
    join predicate_markets relevant on relevant.market_id = definition.market_id
    where definition.tenant_id = p_tenant_id

    union all

    select
      'lifecycle:' || lifecycle.market_lifecycle_period_id::text,
      jsonb_build_object(
        'kind', 'lifecycle',
        'marketLifecyclePeriodId', lifecycle.market_lifecycle_period_id,
        'marketId', lifecycle.market_id,
        'sellingLegalEntityId', lifecycle.selling_legal_entity_id,
        'revision', lifecycle.revision_number,
        'lifecycle', lifecycle.lifecycle,
        'effectiveFrom', lifecycle.effective_from,
        'effectiveTo', lifecycle.effective_to
      )
    from commerce_market_catalog.market_lifecycle_periods lifecycle
    join predicate_markets relevant on relevant.market_id = lifecycle.market_id
    where lifecycle.tenant_id = p_tenant_id
  ),
  future_boundaries as (
    select boundary
    from predicate_association_rows association
    cross join lateral (
      values (association.effective_from), (association.effective_to), (association.removed_at)
    ) candidate(boundary)
    where boundary > greatest(v_effective_at, v_observed_at)

    union all

    select boundary
    from commerce_market_catalog.market_definition_revisions definition
    join predicate_markets relevant on relevant.market_id = definition.market_id
    cross join lateral (values (definition.effective_from), (definition.effective_to)) candidate(boundary)
    where definition.tenant_id = p_tenant_id
      and boundary > greatest(v_effective_at, v_observed_at)

    union all

    select boundary
    from commerce_market_catalog.market_lifecycle_periods lifecycle
    join predicate_markets relevant on relevant.market_id = lifecycle.market_id
    cross join lateral (values (lifecycle.effective_from), (lifecycle.effective_to)) candidate(boundary)
    where lifecycle.tenant_id = p_tenant_id
      and boundary > greatest(v_effective_at, v_observed_at)
  )
  select jsonb_build_object(
    'generation', coalesce(
      (select completeness.generation
       from commerce_market_catalog.market_catalog_completeness_generations completeness
       where completeness.tenant_id = p_tenant_id),
      0
    ),
    'predicateRevision', md5(
      coalesce(
        (select jsonb_agg(material.material order by material.material_key)::text from predicate_material material),
        '[]'
      )
    ),
    'observedAt', v_observed_at,
    'nextApplicabilityBoundary', (select min(boundary) from future_boundaries),
    'facts', coalesce(
      (select jsonb_agg(fact.fact order by fact.storefront_association_id, fact.revision_number) from current_facts fact),
      '[]'::jsonb
    )
  );
end;
$$;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_market_eligibility_snapshot(uuid, jsonb) from public;
revoke all on function commerce_market_catalog.read_market_eligibility_snapshot(uuid, jsonb) from ontos_runtime;
grant execute on function commerce_market_catalog.read_market_eligibility_snapshot(uuid, jsonb) to ontos_runtime;
