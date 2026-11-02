-- Search needs every definition and lifecycle period, including future and expired rows.
-- Current-catalog and definition-history reads cannot represent lifecycle-only transitions.
create function commerce_market_catalog.read_market_search_snapshot(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_market_id uuid;
begin
  if p_tenant_id is null or p_legal_entity_id is null then
    raise exception using errcode = '42501', message = 'Market search requires tenant and company scope';
  end if;
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'marketId') <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Market search input is invalid';
  end if;
  if p_payload ? 'marketId' then
    if jsonb_typeof(p_payload->'marketId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Market search identity is invalid';
    end if;
    begin
      v_market_id := (p_payload->>'marketId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Market search identity is invalid';
    end;
  end if;

  return query
  select jsonb_build_object(
    'businessCode', market.business_code,
    'marketId', market.market_id,
    'sellingLegalEntityId', market.selling_legal_entity_id,
    'tenantId', market.tenant_id,
    'definitions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'effectiveFrom', definition.effective_from,
        'effectiveTo', definition.effective_to,
        'purpose', definition.purpose
      ) order by definition.revision_number, definition.market_definition_revision_id)
      from commerce_market_catalog.market_definition_revisions definition
      where definition.tenant_id = p_tenant_id
        and definition.selling_legal_entity_id = p_legal_entity_id
        and definition.market_id = market.market_id
    ), '[]'::jsonb),
    'lifecycles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'effectiveFrom', lifecycle.effective_from,
        'effectiveTo', lifecycle.effective_to,
        'lifecycle', lifecycle.lifecycle
      ) order by lifecycle.revision_number, lifecycle.market_lifecycle_period_id)
      from commerce_market_catalog.market_lifecycle_periods lifecycle
      where lifecycle.tenant_id = p_tenant_id
        and lifecycle.selling_legal_entity_id = p_legal_entity_id
        and lifecycle.market_id = market.market_id
    ), '[]'::jsonb)
  )
  from commerce_market_catalog.markets market
  where market.tenant_id = p_tenant_id
    and market.selling_legal_entity_id = p_legal_entity_id
    and (v_market_id is null or market.market_id = v_market_id)
  order by market.market_id;
end;
$$;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_market_search_snapshot(uuid, uuid, jsonb) from public;
--> statement-breakpoint
grant execute on function commerce_market_catalog.read_market_search_snapshot(uuid, uuid, jsonb) to ontos_runtime;
