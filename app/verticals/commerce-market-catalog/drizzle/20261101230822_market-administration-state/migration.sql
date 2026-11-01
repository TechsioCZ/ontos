-- Staff market administration state: the Market aggregate revision every lifecycle Action expects, and the newest
-- durable retirement intent of the Market (so a pending retirement is found again after a page reload).
create or replace function commerce_market_catalog.read_market_administration_state(
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
    raise exception using errcode = '22023', message = 'Market administration state input must be an object';
  end if;
  begin
    v_market_id := (p_payload->>'marketId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Market administration state identity is invalid';
  end;
  if v_market_id is null then
    raise exception using errcode = '22023', message = 'Market administration state identity is required';
  end if;
  return query
    select jsonb_strip_nulls(jsonb_build_object(
      'currentDefinitionRevisionId', market.current_definition_revision_id,
      'marketId', market.market_id,
      'retirementIntent', (
        select commerce_market_catalog.market_retirement_intent_payload(intent)
          from commerce_market_catalog.market_retirement_intents intent
         where intent.tenant_id = p_tenant_id
           and intent.selling_legal_entity_id = p_legal_entity_id
           and intent.market_id = market.market_id
         order by intent.requested_at desc, intent.market_retirement_intent_id desc
         limit 1
      ),
      'revision', market.aggregate_revision
    ))
      from commerce_market_catalog.markets market
     where market.tenant_id = p_tenant_id
       and market.selling_legal_entity_id = p_legal_entity_id
       and market.market_id = v_market_id;
end;
$$;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_market_administration_state(uuid, uuid, jsonb) from public;
--> statement-breakpoint
grant execute on function commerce_market_catalog.read_market_administration_state(uuid, uuid, jsonb) to ontos_runtime;
