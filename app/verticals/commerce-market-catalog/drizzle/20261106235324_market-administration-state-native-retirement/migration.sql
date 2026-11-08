-- Forward-only convergence of the two Market retirement histories. This folder joins the branched snapshot
-- heads (`..._market_retirement_admission` and `..._market-search-snapshot`); every earlier migration and its
-- snapshot stay byte-identical, and the archived `market_retirement_intents` table and its rows stay in place.
-- Nothing here is a live cutover: applying it only converges the schema, and the retirement runtime no longer
-- reads or writes the legacy intent archive.

-- Refuse to strand already accepted legacy intents: the native admission protocol cannot settle an intent that
-- is still non-terminal, so the migration stops instead of silently abandoning it.
do $$
begin
  if exists (
    select 1
      from commerce_market_catalog.market_retirement_intents intent
     where intent.stage not in ('COMPLETED', 'FAILED')
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'legacy Market retirement intents are still pending; settle or fail them before the native cutover';
  end if;
end;
$$;
--> statement-breakpoint
-- Fence new legacy intent writes atomically. `create or replace` keeps the existing execute grant, so the
-- request routine stays callable while it refuses to create another durable intent.
create or replace function commerce_market_catalog.request_market_retirement(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  raise exception using
    errcode = 'P0001',
    message = 'durable Market retirement intents are retired; retire through the native Market admission';
end;
$$;
--> statement-breakpoint
-- The administration state reports the native retirement admission of the Market instead of the archived
-- legacy intent, so a reload finds a committed retirement again without joining the intent archive.
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
      'retirementAdmission', (
        select jsonb_strip_nulls(jsonb_build_object(
                 'result', admission.committed_result,
                 'sourceActionInvocationId', admission.source_action_invocation_id,
                 'status', admission.status
               ))
          from commerce_market_catalog.market_retirement_admissions admission
         where admission.tenant_id = p_tenant_id
           and admission.selling_legal_entity_id = p_legal_entity_id
           and admission.market_id = market.market_id
         order by admission.recorded_at desc, admission.source_action_invocation_id desc
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
revoke all on function commerce_market_catalog.request_market_retirement(uuid, uuid, jsonb) from public;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_market_administration_state(uuid, uuid, jsonb) from public;
--> statement-breakpoint
grant execute on function commerce_market_catalog.request_market_retirement(uuid, uuid, jsonb) to ontos_runtime;
--> statement-breakpoint
grant execute on function commerce_market_catalog.read_market_administration_state(uuid, uuid, jsonb) to ontos_runtime;
