create or replace function commerce_market_catalog.assert_operation_scope(p_tenant_id uuid, p_legal_entity_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid
     or p_legal_entity_id is distinct from nullif(current_setting('ontos.legal_entity_id', true), '')::uuid then
    raise exception using errcode = '42501', message = 'market catalog operation scope mismatch';
  end if;
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.advance_completeness_generation(
  p_tenant_id uuid,
  p_action_invocation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_generation integer;
begin
  insert into commerce_market_catalog.market_catalog_completeness_generations (
    tenant_id, generation, last_action_invocation_id, updated_at
  ) values (p_tenant_id, 1, p_action_invocation_id, statement_timestamp())
  on conflict (tenant_id) do update
    set generation = commerce_market_catalog.market_catalog_completeness_generations.generation + 1,
        last_action_invocation_id = excluded.last_action_invocation_id,
        updated_at = excluded.updated_at
  returning generation into v_generation;
  return v_generation;
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.reject_append_only_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'market catalog history is append-only';
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.protect_market_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.market_id is distinct from old.market_id
     or new.tenant_id is distinct from old.tenant_id
     or new.selling_legal_entity_id is distinct from old.selling_legal_entity_id
     or new.business_code is distinct from old.business_code
     or new.created_by_action_invocation_id is distinct from old.created_by_action_invocation_id
     or new.created_by_principal_id is distinct from old.created_by_principal_id
     or new.recorded_at is distinct from old.recorded_at then
    raise exception using errcode = '55000', message = 'market identity is immutable';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.protect_association_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.storefront_association_id is distinct from old.storefront_association_id
     or new.tenant_id is distinct from old.tenant_id
     or new.selling_legal_entity_id is distinct from old.selling_legal_entity_id
     or new.created_by_action_invocation_id is distinct from old.created_by_action_invocation_id
     or new.created_by_principal_id is distinct from old.created_by_principal_id
     or new.recorded_at is distinct from old.recorded_at then
    raise exception using errcode = '55000', message = 'storefront association identity is immutable';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger commerce_market_catalog_definition_revisions_append_only
before update or delete on commerce_market_catalog.market_definition_revisions
for each row execute function commerce_market_catalog.reject_append_only_change();
--> statement-breakpoint
create trigger commerce_market_catalog_association_revisions_append_only
before update or delete on commerce_market_catalog.storefront_association_revisions
for each row execute function commerce_market_catalog.reject_append_only_change();
--> statement-breakpoint
create trigger commerce_market_catalog_markets_identity_immutable
before update on commerce_market_catalog.markets
for each row execute function commerce_market_catalog.protect_market_identity();
--> statement-breakpoint
create trigger commerce_market_catalog_associations_identity_immutable
before update on commerce_market_catalog.storefront_associations
for each row execute function commerce_market_catalog.protect_association_identity();
--> statement-breakpoint
alter table commerce_market_catalog.markets
  add constraint commerce_market_catalog_markets_current_definition_fk
  foreign key (tenant_id, current_definition_revision_id)
  references commerce_market_catalog.market_definition_revisions (tenant_id, market_definition_revision_id)
  on delete restrict
  deferrable initially deferred;
--> statement-breakpoint
create or replace function commerce_market_catalog.create_market(
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
  v_market_id uuid := (p_payload->>'marketId')::uuid;
  v_seller_id uuid := (p_payload#>>'{sellingLegalEntityRef,resourceId}')::uuid;
  v_code text := p_payload->>'marketCode';
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_principal_id uuid := (p_payload->>'principalId')::uuid;
  v_definition_id uuid;
  v_existing commerce_market_catalog.markets%rowtype;
  v_generation integer;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if v_seller_id is distinct from p_legal_entity_id
     or (p_payload#>>'{sellingLegalEntityRef,tenantId}')::uuid is distinct from p_tenant_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;

  select * into v_existing from commerce_market_catalog.markets
  where tenant_id = p_tenant_id and market_id = v_market_id for update;
  if found then
    if v_existing.selling_legal_entity_id is distinct from v_seller_id then
      return query select jsonb_build_object('_tag', 'seller_identity_immutable'); return;
    end if;
    if v_existing.business_code is distinct from v_code then
      return query select jsonb_build_object('_tag', 'market_code_conflict'); return;
    end if;
    select market_definition_revision_id into strict v_definition_id
      from commerce_market_catalog.market_definition_revisions
      where tenant_id = p_tenant_id and market_id = v_market_id and revision_number = 1;
    select coalesce(generation, 0) into v_generation
      from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = p_tenant_id;
    return query select jsonb_build_object(
      '_tag', 'reused', 'changed', false,
      'definitionRevisionId', v_definition_id,
      'generation', coalesce(v_generation, 0), 'revision', 1
    ); return;
  end if;
  if exists (select 1 from commerce_market_catalog.markets where tenant_id = p_tenant_id and business_code = v_code) then
    return query select jsonb_build_object('_tag', 'market_code_conflict'); return;
  end if;

  insert into commerce_market_catalog.markets (
    market_id, tenant_id, selling_legal_entity_id, business_code,
    current_definition_revision, aggregate_revision,
    created_by_action_invocation_id, created_by_principal_id, recorded_at
  ) values (
    v_market_id, p_tenant_id, v_seller_id, v_code, 1, 1,
    v_action_id, v_principal_id, (p_payload->>'recordedAt')::timestamptz
  );
  insert into commerce_market_catalog.market_definition_revisions (
    tenant_id, market_id, selling_legal_entity_id, revision_number, purpose,
    channels, jurisdictions, supported_locales, effective_from, effective_to,
    change_reason, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_market_id, v_seller_id, 1, p_payload->>'purpose',
    p_payload->'channels', p_payload->'jurisdictions', p_payload->'supportedLocales',
    (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
    nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz,
    p_payload->>'reason', v_action_id, v_principal_id, (p_payload->>'recordedAt')::timestamptz
  ) returning market_definition_revision_id into v_definition_id;
  update commerce_market_catalog.markets set current_definition_revision_id = v_definition_id
    where tenant_id = p_tenant_id and market_id = v_market_id;
  insert into commerce_market_catalog.market_lifecycle_periods (
    tenant_id, market_id, selling_legal_entity_id, revision_number, lifecycle,
    effective_from, effective_to, reason, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_market_id, v_seller_id, 1, p_payload->>'lifecycle',
    (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
    nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz,
    p_payload->>'reason', v_action_id, v_principal_id, (p_payload->>'recordedAt')::timestamptz
  );
  v_generation := commerce_market_catalog.advance_completeness_generation(p_tenant_id, v_action_id);
  return query select jsonb_build_object(
    '_tag', 'created', 'changed', true, 'definitionRevisionId', v_definition_id,
    'generation', v_generation, 'revision', 1
  );
exception when unique_violation then
  return query select jsonb_build_object('_tag', 'market_code_conflict');
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.revise_market_definition(
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
  v_current commerce_market_catalog.market_definition_revisions%rowtype;
  v_market_id uuid := (p_payload#>>'{marketRef,resourceId}')::uuid;
  v_expected_id uuid := (p_payload#>>'{expectedCurrentDefinitionRevisionRef,resourceId}')::uuid;
  v_expected_revision integer := (p_payload->>'expectedRevision')::integer;
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_new_id uuid;
  v_generation integer;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if (p_payload#>>'{marketRef,tenantId}')::uuid is distinct from p_tenant_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;
  select * into v_market from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and market_id = v_market_id for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  if v_market.selling_legal_entity_id is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'seller_identity_immutable'); return;
  end if;
  if v_market.current_definition_revision is distinct from v_expected_revision
     or v_market.current_definition_revision_id is distinct from v_expected_id then
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_market.current_definition_revision); return;
  end if;
  select * into strict v_current from commerce_market_catalog.market_definition_revisions
    where tenant_id = p_tenant_id and market_definition_revision_id = v_market.current_definition_revision_id;
  if v_current.purpose = p_payload->>'purpose'
     and v_current.channels = p_payload->'channels'
     and v_current.jurisdictions = p_payload->'jurisdictions'
     and v_current.supported_locales = p_payload->'supportedLocales'
     and v_current.effective_from = (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz
     and v_current.effective_to is not distinct from nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz then
    select coalesce(generation, 0) into v_generation from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = p_tenant_id;
    return query select jsonb_build_object('_tag', 'revised', 'changed', false,
      'definitionRevisionId', v_current.market_definition_revision_id,
      'previousDefinitionRevisionId', v_current.market_definition_revision_id,
      'generation', coalesce(v_generation, 0), 'revision', v_current.revision_number); return;
  end if;
  insert into commerce_market_catalog.market_definition_revisions (
    tenant_id, market_id, selling_legal_entity_id, revision_number, purpose,
    channels, jurisdictions, supported_locales, effective_from, effective_to,
    change_reason, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_market_id, p_legal_entity_id, v_expected_revision + 1, p_payload->>'purpose',
    p_payload->'channels', p_payload->'jurisdictions', p_payload->'supportedLocales',
    (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
    nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz,
    p_payload->>'reason', v_action_id, (p_payload->>'principalId')::uuid,
    (p_payload->>'recordedAt')::timestamptz
  ) returning market_definition_revision_id into v_new_id;
  update commerce_market_catalog.markets set
    current_definition_revision_id = v_new_id,
    current_definition_revision = v_expected_revision + 1,
    aggregate_revision = aggregate_revision + 1
  where tenant_id = p_tenant_id and market_id = v_market_id;
  v_generation := commerce_market_catalog.advance_completeness_generation(p_tenant_id, v_action_id);
  return query select jsonb_build_object('_tag', 'revised', 'changed', true,
    'definitionRevisionId', v_new_id, 'previousDefinitionRevisionId', v_current.market_definition_revision_id,
    'generation', v_generation, 'revision', v_expected_revision + 1);
end;
$$;
--> statement-breakpoint
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
    effective_from, reason, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_market_id, p_legal_entity_id, v_current.revision_number + 1, v_target,
    v_effective_at, p_payload->>'reason', v_action_id, (p_payload->>'principalId')::uuid,
    (p_payload->>'recordedAt')::timestamptz
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
--> statement-breakpoint
create or replace function commerce_market_catalog.associate_storefront(
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
  v_existing commerce_market_catalog.storefront_associations%rowtype;
  v_current commerce_market_catalog.storefront_association_revisions%rowtype;
  v_association_id uuid := (p_payload->>'associationId')::uuid;
  v_market_id uuid := (p_payload#>>'{marketRef,resourceId}')::uuid;
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_generation integer;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if (p_payload#>>'{storefrontRef,tenantId}')::uuid is distinct from p_tenant_id
     or (p_payload#>>'{sellingLegalEntityRef,resourceId}')::uuid is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;
  select * into v_market from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and market_id = v_market_id for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  if v_market.selling_legal_entity_id is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
  end if;
  if v_market.current_definition_revision_id is distinct from (p_payload#>>'{expectedMarketDefinitionRevisionRef,resourceId}')::uuid then
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_market.current_definition_revision); return;
  end if;
  select * into v_existing from commerce_market_catalog.storefront_associations
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id for update;
  if found then
    if v_existing.selling_legal_entity_id is distinct from p_legal_entity_id then
      return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
    end if;
    select * into strict v_current from commerce_market_catalog.storefront_association_revisions
      where tenant_id = p_tenant_id and storefront_association_id = v_association_id
      order by revision_number desc limit 1;
    if v_current.market_id = v_market_id
       and v_current.storefront_app_id = p_payload#>>'{storefrontRef,appId}'
       and v_current.channel = p_payload->>'channel'
       and v_current.effective_from = (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz
       and v_current.effective_to is not distinct from nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz
       and v_current.removed_at is null then
      select coalesce(generation, 0) into v_generation from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = p_tenant_id;
      return query select jsonb_build_object('_tag', 'associated', 'changed', false,
        'generation', coalesce(v_generation, 0), 'revision', v_current.revision_number); return;
    end if;
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_existing.current_revision); return;
  end if;
  if exists (
    select 1 from commerce_market_catalog.storefront_associations a
    join commerce_market_catalog.storefront_association_revisions r
      on r.tenant_id = a.tenant_id and r.storefront_association_id = a.storefront_association_id and r.revision_number = a.current_revision
    where a.tenant_id = p_tenant_id and r.market_id = v_market_id
      and r.storefront_app_id = p_payload#>>'{storefrontRef,appId}' and r.channel = p_payload->>'channel'
      and r.removed_at is null
      and tstzrange(r.effective_from, r.effective_to, '[)') && tstzrange(
        (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
        nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz, '[)'
      )
  ) then return query select jsonb_build_object('_tag', 'overlapping_association'); return; end if;
  insert into commerce_market_catalog.storefront_associations (
    storefront_association_id, tenant_id, selling_legal_entity_id, current_revision,
    created_by_action_invocation_id, created_by_principal_id, recorded_at
  ) values (v_association_id, p_tenant_id, p_legal_entity_id, 1, v_action_id,
    (p_payload->>'principalId')::uuid, (p_payload->>'recordedAt')::timestamptz);
  insert into commerce_market_catalog.storefront_association_revisions (
    tenant_id, storefront_association_id, revision_number, market_id,
    market_definition_revision_id, selling_legal_entity_id, storefront_app_id, channel,
    effective_from, effective_to, provenance_kind, provenance_reference, reason,
    action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_association_id, 1, v_market_id, v_market.current_definition_revision_id,
    p_legal_entity_id, p_payload#>>'{storefrontRef,appId}', p_payload->>'channel',
    (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
    nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz,
    p_payload#>>'{provenance,kind}', p_payload#>>'{provenance,reference}', p_payload->>'reason',
    v_action_id, (p_payload->>'principalId')::uuid, (p_payload->>'recordedAt')::timestamptz
  );
  v_generation := commerce_market_catalog.advance_completeness_generation(p_tenant_id, v_action_id);
  return query select jsonb_build_object('_tag', 'associated', 'changed', true, 'generation', v_generation, 'revision', 1);
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.revise_storefront_association(
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
  v_association commerce_market_catalog.storefront_associations%rowtype;
  v_current commerce_market_catalog.storefront_association_revisions%rowtype;
  v_market commerce_market_catalog.markets%rowtype;
  v_association_id uuid := (p_payload#>>'{associationRef,resourceId}')::uuid;
  v_market_id uuid := (p_payload#>>'{marketRef,resourceId}')::uuid;
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_generation integer;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if (p_payload#>>'{associationRef,tenantId}')::uuid is distinct from p_tenant_id
     or (p_payload#>>'{storefrontRef,tenantId}')::uuid is distinct from p_tenant_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;
  select * into v_association from commerce_market_catalog.storefront_associations
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  if v_association.selling_legal_entity_id is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
  end if;
  if v_association.current_revision is distinct from (p_payload->>'expectedRevision')::integer then
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_association.current_revision); return;
  end if;
  select * into strict v_current from commerce_market_catalog.storefront_association_revisions
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id
    and revision_number = v_association.current_revision;
  select * into v_market from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and market_id = v_market_id;
  if not found or v_market.selling_legal_entity_id is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
  end if;
  if v_current.market_id = v_market_id
     and v_current.storefront_app_id = p_payload#>>'{storefrontRef,appId}'
     and v_current.channel = p_payload->>'channel'
     and v_current.effective_from = (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz
     and v_current.effective_to is not distinct from nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz
     and v_current.removed_at is null then
    select coalesce(generation, 0) into v_generation from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = p_tenant_id;
    return query select jsonb_build_object('_tag', 'revised', 'changed', false,
      'generation', coalesce(v_generation, 0), 'previousRevision', v_current.revision_number,
      'revision', v_current.revision_number); return;
  end if;
  if exists (
    select 1 from commerce_market_catalog.storefront_associations a
    join commerce_market_catalog.storefront_association_revisions r
      on r.tenant_id = a.tenant_id and r.storefront_association_id = a.storefront_association_id and r.revision_number = a.current_revision
    where a.tenant_id = p_tenant_id and a.storefront_association_id <> v_association_id
      and r.market_id = v_market_id and r.storefront_app_id = p_payload#>>'{storefrontRef,appId}'
      and r.channel = p_payload->>'channel' and r.removed_at is null
      and tstzrange(r.effective_from, r.effective_to, '[)') && tstzrange(
        (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
        nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz, '[)'
      )
  ) then return query select jsonb_build_object('_tag', 'overlapping_association'); return; end if;
  insert into commerce_market_catalog.storefront_association_revisions (
    tenant_id, storefront_association_id, revision_number, market_id,
    market_definition_revision_id, selling_legal_entity_id, storefront_app_id, channel,
    effective_from, effective_to, provenance_kind, provenance_reference, reason,
    action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_association_id, v_current.revision_number + 1, v_market_id,
    v_market.current_definition_revision_id, p_legal_entity_id,
    p_payload#>>'{storefrontRef,appId}', p_payload->>'channel',
    (p_payload#>>'{effectivePeriod,startsAt}')::timestamptz,
    nullif(p_payload#>>'{effectivePeriod,endsAt}', '')::timestamptz,
    p_payload#>>'{provenance,kind}', p_payload#>>'{provenance,reference}', p_payload->>'reason',
    v_action_id, (p_payload->>'principalId')::uuid, (p_payload->>'recordedAt')::timestamptz
  );
  update commerce_market_catalog.storefront_associations set current_revision = current_revision + 1
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id;
  v_generation := commerce_market_catalog.advance_completeness_generation(p_tenant_id, v_action_id);
  return query select jsonb_build_object('_tag', 'revised', 'changed', true,
    'generation', v_generation, 'previousRevision', v_current.revision_number,
    'revision', v_current.revision_number + 1);
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.remove_storefront_association(
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
  v_association commerce_market_catalog.storefront_associations%rowtype;
  v_current commerce_market_catalog.storefront_association_revisions%rowtype;
  v_association_id uuid := (p_payload#>>'{associationRef,resourceId}')::uuid;
  v_effective_at timestamptz := (p_payload->>'effectiveAt')::timestamptz;
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_generation integer;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  if (p_payload#>>'{associationRef,tenantId}')::uuid is distinct from p_tenant_id
     or (p_payload#>>'{marketRef,tenantId}')::uuid is distinct from p_tenant_id
     or (p_payload#>>'{storefrontRef,tenantId}')::uuid is distinct from p_tenant_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;
  select * into v_association from commerce_market_catalog.storefront_associations
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  if v_association.selling_legal_entity_id is distinct from p_legal_entity_id
     or v_association.current_revision is distinct from (p_payload->>'expectedRevision')::integer then
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_association.current_revision); return;
  end if;
  select * into strict v_current from commerce_market_catalog.storefront_association_revisions
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id
    and revision_number = v_association.current_revision;
  if v_current.market_id is distinct from (p_payload#>>'{marketRef,resourceId}')::uuid
     or v_current.storefront_app_id is distinct from p_payload#>>'{storefrontRef,appId}' then
    return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
  end if;
  if v_current.removed_at is not null then
    select coalesce(generation, 0) into v_generation from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = p_tenant_id;
    if v_current.removed_at = v_effective_at then
      return query select jsonb_build_object('_tag', 'removed', 'changed', false,
        'generation', coalesce(v_generation, 0), 'revision', v_current.revision_number); return;
    end if;
    return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
  end if;
  if v_effective_at <= v_current.effective_from then
    return query select jsonb_build_object('_tag', 'inconsistent_seller_or_channel'); return;
  end if;
  insert into commerce_market_catalog.storefront_association_revisions (
    tenant_id, storefront_association_id, revision_number, market_id,
    market_definition_revision_id, selling_legal_entity_id, storefront_app_id, channel,
    effective_from, effective_to, provenance_kind, provenance_reference, removed_at, reason,
    action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_association_id, v_current.revision_number + 1, v_current.market_id,
    v_current.market_definition_revision_id, p_legal_entity_id, v_current.storefront_app_id, v_current.channel,
    v_current.effective_from, least(v_effective_at, coalesce(v_current.effective_to, v_effective_at)),
    v_current.provenance_kind, v_current.provenance_reference, v_effective_at, p_payload->>'reason',
    v_action_id, (p_payload->>'principalId')::uuid, (p_payload->>'recordedAt')::timestamptz
  );
  update commerce_market_catalog.storefront_associations set current_revision = current_revision + 1
    where tenant_id = p_tenant_id and storefront_association_id = v_association_id;
  v_generation := commerce_market_catalog.advance_completeness_generation(p_tenant_id, v_action_id);
  return query select jsonb_build_object('_tag', 'removed', 'changed', true,
    'generation', v_generation, 'revision', v_current.revision_number + 1);
end;
$$;
--> statement-breakpoint
alter table commerce_market_catalog.market_catalog_completeness_generations force row level security;
alter table commerce_market_catalog.market_definition_revisions force row level security;
alter table commerce_market_catalog.market_lifecycle_periods force row level security;
alter table commerce_market_catalog.markets force row level security;
alter table commerce_market_catalog.storefront_association_revisions force row level security;
alter table commerce_market_catalog.storefront_associations force row level security;
--> statement-breakpoint
revoke all on schema commerce_market_catalog from public;
revoke all on all tables in schema commerce_market_catalog from public;
revoke all on all functions in schema commerce_market_catalog from public;
revoke all on all tables in schema commerce_market_catalog from ontos_runtime;
grant usage on schema commerce_market_catalog to ontos_runtime;
grant execute on function commerce_market_catalog.create_market(uuid, uuid, jsonb) to ontos_runtime;
grant execute on function commerce_market_catalog.revise_market_definition(uuid, uuid, jsonb) to ontos_runtime;
grant execute on function commerce_market_catalog.transition_market_lifecycle(uuid, uuid, jsonb) to ontos_runtime;
grant execute on function commerce_market_catalog.associate_storefront(uuid, uuid, jsonb) to ontos_runtime;
grant execute on function commerce_market_catalog.revise_storefront_association(uuid, uuid, jsonb) to ontos_runtime;
grant execute on function commerce_market_catalog.remove_storefront_association(uuid, uuid, jsonb) to ontos_runtime;
