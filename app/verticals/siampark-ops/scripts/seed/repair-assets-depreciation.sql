-- Idempotent, assets-only correction of the original LE0021 demo fixture.
-- Do not full-reseed: live inventories, templates and user-entered assets must survive.
-- Run: docker exec -i ontos-demo-db psql -v ON_ERROR_STOP=1 -U ontos_admin -d siampark_demo < this-file
begin;
do $repair$
declare
  original jsonb;
  repaired jsonb;
  asset_row record;
  plan_row record;
  entry_row record;
  history_row record;
  plan_path text[];
  old_at text;
  corrected_at constant text := '2026-04-30T14:00:00.000Z';
begin
  select state into strict original from demo_siampark_ops.agenda_states
    where tenant_id = '70000000-0000-4000-8000-000000000020'
      and legal_entity_id = '71000000-0000-4000-8000-000000000021'
      and agenda = 'assets' for update;
  repaired := original;
  for asset_row in select value, ordinality - 1 as idx from jsonb_array_elements(original->'assets') with ordinality
    where value->>'inventoryNumber' = 'VYB-008' and value->>'id' = 'siampark-asset-023'
  loop
    for plan_row in select value, ordinality - 1 as idx from jsonb_array_elements(asset_row.value->'depreciationPlans') with ordinality
      where value->>'id' = 'seed-plan-0115'
    loop
      plan_path := array['assets', asset_row.idx::text, 'depreciationPlans', plan_row.idx::text];
      for entry_row in select value, ordinality - 1 as idx from jsonb_array_elements(plan_row.value->'entries') with ordinality
        where value->>'id' = 'seed-entry-0114' and value->>'period' = '2026' and value->>'documentRef' = 'PS-2026-04'
          and (value->>'at')::timestamptz > '2026-10-20T23:59:59Z'::timestamptz
      loop
        old_at := entry_row.value->>'at';
        repaired := jsonb_set(repaired, plan_path || array['entries', entry_row.idx::text, 'at'], to_jsonb(corrected_at));
        for history_row in select value, ordinality - 1 as idx from jsonb_array_elements(plan_row.value->'history') with ordinality
          where value->>'change' = 'entry_recorded' and value->>'note' = '2026' and value->>'at' = old_at
        loop
          repaired := jsonb_set(repaired, plan_path || array['history', history_row.idx::text, 'at'], to_jsonb(corrected_at));
        end loop;
      end loop;
    end loop;
  end loop;
  if repaired is distinct from original then
    update demo_siampark_ops.agenda_states set state = repaired, revision = revision + 1, updated_at = now()
      where tenant_id = '70000000-0000-4000-8000-000000000020'
        and legal_entity_id = '71000000-0000-4000-8000-000000000021' and agenda = 'assets';
    raise notice 'Corrected VYB-008 entry and its history; all other live data preserved';
  else
    raise notice 'No correction needed';
  end if;
end $repair$;
commit;
