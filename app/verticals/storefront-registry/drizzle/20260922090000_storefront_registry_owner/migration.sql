create schema if not exists storefront_registry;

create table storefront_registry.storefront_applications (
  storefront_application_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  storefront_app_id text not null,
  current_revision integer not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint storefront_registry_applications_scope_id_uk unique (tenant_id, storefront_application_id),
  constraint storefront_registry_applications_app_id_uk unique (tenant_id, storefront_app_id),
  constraint storefront_registry_applications_revision_ck check (current_revision > 0),
  constraint storefront_registry_applications_app_id_ck check (storefront_app_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table storefront_registry.storefront_application_revisions (
  storefront_application_revision_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  storefront_application_id uuid not null,
  revision_number integer not null,
  allowed_channels jsonb not null,
  lifecycle text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  reason text not null,
  action_invocation_id uuid not null,
  acting_principal_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint storefront_registry_revisions_scope_id_uk unique (tenant_id, storefront_application_revision_id),
  constraint storefront_registry_revisions_number_uk unique (tenant_id, storefront_application_id, revision_number),
  constraint storefront_registry_revisions_invocation_uk unique (tenant_id, action_invocation_id),
  constraint storefront_registry_revisions_application_fk foreign key (tenant_id, storefront_application_id)
    references storefront_registry.storefront_applications (tenant_id, storefront_application_id) on delete restrict,
  constraint storefront_registry_revisions_number_ck check (revision_number > 0),
  constraint storefront_registry_revisions_lifecycle_ck check (lifecycle in ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED')),
  constraint storefront_registry_revisions_period_ck check (effective_to is null or effective_to > effective_from),
  constraint storefront_registry_revisions_channels_ck check (
    jsonb_typeof(allowed_channels) = 'array' and jsonb_array_length(allowed_channels) > 0
  ),
  constraint storefront_registry_revisions_reason_ck check (
    reason = btrim(reason) and length(reason) between 1 and 500
  )
);

create index storefront_registry_revisions_effective_idx
  on storefront_registry.storefront_application_revisions (tenant_id, storefront_application_id, effective_from);

create table storefront_registry.storefront_registry_generations (
  tenant_id uuid primary key,
  generation integer not null default 0,
  last_action_invocation_id uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint storefront_registry_generations_generation_ck check (generation >= 0)
);

alter table storefront_registry.storefront_applications enable row level security;
alter table storefront_registry.storefront_applications force row level security;
alter table storefront_registry.storefront_application_revisions enable row level security;
alter table storefront_registry.storefront_application_revisions force row level security;
alter table storefront_registry.storefront_registry_generations enable row level security;
alter table storefront_registry.storefront_registry_generations force row level security;

create policy storefront_registry_applications_tenant_select on storefront_registry.storefront_applications
  for select to ontos_runtime using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_applications_tenant_insert on storefront_registry.storefront_applications
  for insert to ontos_runtime with check (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_applications_tenant_update on storefront_registry.storefront_applications
  for update to ontos_runtime using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_applications_tenant_delete on storefront_registry.storefront_applications
  for delete to ontos_runtime using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);

create policy storefront_registry_revisions_tenant_select on storefront_registry.storefront_application_revisions
  for select to ontos_runtime using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_revisions_tenant_insert on storefront_registry.storefront_application_revisions
  for insert to ontos_runtime with check (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_revisions_tenant_update on storefront_registry.storefront_application_revisions
  for update to ontos_runtime using (false) with check (false);
create policy storefront_registry_revisions_tenant_delete on storefront_registry.storefront_application_revisions
  for delete to ontos_runtime using (false);

create policy storefront_registry_generations_tenant_select on storefront_registry.storefront_registry_generations
  for select to ontos_runtime using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_generations_tenant_insert on storefront_registry.storefront_registry_generations
  for insert to ontos_runtime with check (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_generations_tenant_update on storefront_registry.storefront_registry_generations
  for update to ontos_runtime using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
create policy storefront_registry_generations_tenant_delete on storefront_registry.storefront_registry_generations
  for delete to ontos_runtime using (false);

create or replace function storefront_registry.reject_revision_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Storefront application revision history is append-only';
end;
$$;

create trigger storefront_registry_revisions_append_only
before update or delete on storefront_registry.storefront_application_revisions
for each row execute function storefront_registry.reject_revision_mutation();

create or replace function storefront_registry.assert_revision_payload(p_payload jsonb, p_allow_terminal boolean)
returns void language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_from timestamptz := (p_payload->'effectiveInterval'->>'effectiveFrom')::timestamptz;
  v_to timestamptz := nullif(p_payload->'effectiveInterval'->>'effectiveTo', '')::timestamptz;
  v_channel_count integer;
  v_distinct_channel_count integer;
begin
  if jsonb_typeof(p_payload->'allowedChannels') is distinct from 'array'
    or jsonb_array_length(p_payload->'allowedChannels') = 0 then
    raise exception 'At least one allowed Storefront channel is required';
  end if;
  select count(*), count(distinct value)
    into v_channel_count, v_distinct_channel_count
  from jsonb_array_elements_text(p_payload->'allowedChannels');
  if v_channel_count <> v_distinct_channel_count
    or exists (
      select 1 from jsonb_array_elements_text(p_payload->'allowedChannels') channel(value)
      where channel.value not in ('B2C', 'B2B')
    ) then
    raise exception 'Storefront channels must be unique B2C or B2B values';
  end if;
  if v_from is null or (v_to is not null and v_to <= v_from) then
    raise exception 'Storefront effective interval is invalid';
  end if;
  if p_payload->>'lifecycle' not in ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED')
    or (not p_allow_terminal and p_payload->>'lifecycle' not in ('DRAFT', 'ACTIVE')) then
    raise exception 'Storefront lifecycle is invalid for this operation';
  end if;
  if nullif(btrim(p_payload->>'reason'), '') is null or length(p_payload->>'reason') > 500 then
    raise exception 'Storefront revision reason is invalid';
  end if;
end;
$$;

create or replace function storefront_registry.advance_generation(
  p_tenant_id uuid,
  p_action_invocation_id uuid,
  p_recorded_at timestamptz
) returns integer language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_generation integer;
begin
  insert into storefront_registry.storefront_registry_generations (
    tenant_id, generation, last_action_invocation_id, updated_at
  ) values (p_tenant_id, 1, p_action_invocation_id, p_recorded_at)
  on conflict (tenant_id) do update set
    generation = storefront_registry.storefront_registry_generations.generation + 1,
    last_action_invocation_id = excluded.last_action_invocation_id,
    updated_at = excluded.updated_at
  returning generation into v_generation;
  return v_generation;
end;
$$;

create or replace function storefront_registry.register_storefront_application(
  p_tenant_id uuid,
  p_payload jsonb
) returns table (payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_application_id uuid;
  v_generation integer;
  v_action_invocation_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_principal_id uuid := (p_payload->>'principalId')::uuid;
  v_recorded_at timestamptz := (p_payload->>'recordedAt')::timestamptz;
begin
  if p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid then
    raise exception 'Tenant scope mismatch';
  end if;
  perform storefront_registry.assert_revision_payload(p_payload, false);

  select revision.storefront_application_id, coalesce(generation.generation, 0)
    into v_application_id, v_generation
  from storefront_registry.storefront_application_revisions revision
  left join storefront_registry.storefront_registry_generations generation using (tenant_id)
  where revision.tenant_id = p_tenant_id and revision.action_invocation_id = v_action_invocation_id;
  if v_application_id is not null then
    return query select jsonb_build_object(
      '_tag', 'reused', 'changed', false, 'generation', v_generation, 'revision', 1,
      'storefrontApplicationId', v_application_id
    );
    return;
  end if;

  insert into storefront_registry.storefront_applications (
    tenant_id, storefront_app_id, current_revision, created_at
  ) values (p_tenant_id, p_payload->>'storefrontAppId', 1, v_recorded_at)
  on conflict (tenant_id, storefront_app_id) do nothing
  returning storefront_application_id into v_application_id;
  if v_application_id is null then
    return query select jsonb_build_object('_tag', 'application_already_registered');
    return;
  end if;

  insert into storefront_registry.storefront_application_revisions (
    tenant_id, storefront_application_id, revision_number, allowed_channels, lifecycle,
    effective_from, effective_to, reason, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_application_id, 1, p_payload->'allowedChannels', p_payload->>'lifecycle',
    (p_payload->'effectiveInterval'->>'effectiveFrom')::timestamptz,
    nullif(p_payload->'effectiveInterval'->>'effectiveTo', '')::timestamptz,
    p_payload->>'reason', v_action_invocation_id, v_principal_id, v_recorded_at
  );
  v_generation := storefront_registry.advance_generation(p_tenant_id, v_action_invocation_id, v_recorded_at);
  return query select jsonb_build_object(
    '_tag', 'created', 'changed', true, 'generation', v_generation, 'revision', 1,
    'storefrontApplicationId', v_application_id
  );
end;
$$;

create or replace function storefront_registry.revise_storefront_application(
  p_tenant_id uuid,
  p_payload jsonb
) returns table (payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_application storefront_registry.storefront_applications%rowtype;
  v_current storefront_registry.storefront_application_revisions%rowtype;
  v_replay storefront_registry.storefront_application_revisions%rowtype;
  v_generation integer;
  v_action_invocation_id uuid := (p_payload->>'actionInvocationId')::uuid;
  v_principal_id uuid := (p_payload->>'principalId')::uuid;
  v_recorded_at timestamptz := (p_payload->>'recordedAt')::timestamptz;
  v_application_id uuid := (p_payload->'storefrontApplicationRef'->>'resourceId')::uuid;
  v_expected_revision integer := (p_payload->>'expectedRevision')::integer;
  v_revision integer;
begin
  if p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid
    or p_payload->'storefrontApplicationRef'->>'tenantId' is distinct from p_tenant_id::text
    or p_payload->'storefrontApplicationRef'->>'moduleId' is distinct from 'commerce.storefront-registry'
    or p_payload->'storefrontApplicationRef'->>'resourceType' is distinct from 'commerce.storefront-registry.storefront-application' then
    raise exception 'Storefront application scope mismatch';
  end if;
  perform storefront_registry.assert_revision_payload(p_payload, true);

  select * into v_replay from storefront_registry.storefront_application_revisions
  where tenant_id = p_tenant_id and action_invocation_id = v_action_invocation_id;
  if v_replay.storefront_application_revision_id is not null then
    select coalesce(generation, 0) into v_generation
    from storefront_registry.storefront_registry_generations where tenant_id = p_tenant_id;
    return query select jsonb_build_object(
      '_tag', 'reused', 'changed', false, 'generation', coalesce(v_generation, 0),
      'previousRevision', v_replay.revision_number - 1, 'revision', v_replay.revision_number,
      'storefrontApplicationId', v_replay.storefront_application_id
    );
    return;
  end if;

  select * into v_application from storefront_registry.storefront_applications
  where tenant_id = p_tenant_id and storefront_application_id = v_application_id
  for update;
  if v_application.storefront_application_id is null then
    return query select jsonb_build_object('_tag', 'application_not_found');
    return;
  end if;
  if v_application.current_revision <> v_expected_revision then
    return query select jsonb_build_object(
      '_tag', 'revision_conflict', 'actualRevision', v_application.current_revision
    );
    return;
  end if;

  select * into strict v_current from storefront_registry.storefront_application_revisions
  where tenant_id = p_tenant_id and storefront_application_id = v_application_id
    and revision_number = v_application.current_revision;
  if v_current.lifecycle = 'RETIRED' then
    return query select jsonb_build_object('_tag', 'retired_lifecycle_terminal');
    return;
  end if;

  v_revision := v_application.current_revision + 1;
  insert into storefront_registry.storefront_application_revisions (
    tenant_id, storefront_application_id, revision_number, allowed_channels, lifecycle,
    effective_from, effective_to, reason, action_invocation_id, acting_principal_id, recorded_at
  ) values (
    p_tenant_id, v_application_id, v_revision, p_payload->'allowedChannels', p_payload->>'lifecycle',
    (p_payload->'effectiveInterval'->>'effectiveFrom')::timestamptz,
    nullif(p_payload->'effectiveInterval'->>'effectiveTo', '')::timestamptz,
    p_payload->>'reason', v_action_invocation_id, v_principal_id, v_recorded_at
  );
  update storefront_registry.storefront_applications set current_revision = v_revision
  where tenant_id = p_tenant_id and storefront_application_id = v_application_id;
  v_generation := storefront_registry.advance_generation(p_tenant_id, v_action_invocation_id, v_recorded_at);
  return query select jsonb_build_object(
    '_tag', 'revised', 'changed', true, 'generation', v_generation,
    'previousRevision', v_application.current_revision, 'revision', v_revision,
    'storefrontApplicationId', v_application_id
  );
end;
$$;

create or replace function storefront_registry.read_current_storefront_application(
  p_tenant_id uuid,
  p_payload jsonb
) returns table (payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_application storefront_registry.storefront_applications%rowtype;
  v_revision storefront_registry.storefront_application_revisions%rowtype;
  v_generation integer;
  v_observed_at timestamptz := clock_timestamp();
begin
  if p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid then
    raise exception 'Tenant scope mismatch';
  end if;

  select * into v_application
  from storefront_registry.storefront_applications
  where tenant_id = p_tenant_id and storefront_app_id = p_payload->>'storefrontAppId';

  select coalesce(generation, 0) into v_generation
  from storefront_registry.storefront_registry_generations where tenant_id = p_tenant_id;

  if not found or v_application.storefront_application_id is null then
    return query select jsonb_build_object(
      '_tag', 'not_found', 'generation', coalesce(v_generation, 0), 'observedAt', v_observed_at
    );
    return;
  end if;

  select * into strict v_revision
  from storefront_registry.storefront_application_revisions
  where tenant_id = p_tenant_id
    and storefront_application_id = v_application.storefront_application_id
    and revision_number = v_application.current_revision;

  return query select jsonb_build_object(
    '_tag', 'found',
    'current', jsonb_build_object(
      'allowedChannels', v_revision.allowed_channels,
      'effectiveFrom', v_revision.effective_from,
      'effectiveTo', v_revision.effective_to,
      'generation', coalesce(v_generation, 0),
      'lifecycle', v_revision.lifecycle,
      'observedAt', least(v_observed_at, (p_payload->>'effectiveAt')::timestamptz),
      'revision', v_revision.revision_number
    )
  );
end;
$$;

revoke all on all tables in schema storefront_registry from ontos_runtime;
revoke all on function storefront_registry.register_storefront_application(uuid, jsonb) from public;
revoke all on function storefront_registry.revise_storefront_application(uuid, jsonb) from public;
revoke all on function storefront_registry.read_current_storefront_application(uuid, jsonb) from public;
grant execute on function storefront_registry.register_storefront_application(uuid, jsonb) to ontos_runtime;
grant execute on function storefront_registry.revise_storefront_application(uuid, jsonb) to ontos_runtime;
grant execute on function storefront_registry.read_current_storefront_application(uuid, jsonb) to ontos_runtime;
