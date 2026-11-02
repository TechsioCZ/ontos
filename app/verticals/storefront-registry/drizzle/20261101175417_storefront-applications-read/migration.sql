-- Tenant list of Storefront application registrations (current revision each) for staff administration screens.
-- SECURITY DEFINER over the RLS-protected owner tables; ontos_runtime keeps EXECUTE only.
create or replace function storefront_registry.read_storefront_applications(
  p_tenant_id uuid,
  p_payload jsonb
) returns table (payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_at timestamptz := (p_payload->>'at')::timestamptz;
  v_observed_at timestamptz;
begin
  if p_tenant_id is distinct from nullif(current_setting('ontos.tenant_id', true), '')::uuid then
    raise exception 'Tenant scope mismatch';
  end if;
  if v_at is null then
    raise exception 'Storefront application list instant is required';
  end if;
  v_observed_at := least(clock_timestamp(), v_at);

  return query
  with bounded as (
    select application.storefront_application_id, application.storefront_app_id, revision.revision_number,
      revision.allowed_channels, revision.lifecycle, revision.effective_from, revision.effective_to
    from storefront_registry.storefront_applications application
    join storefront_registry.storefront_application_revisions revision
      on revision.tenant_id = application.tenant_id
     and revision.storefront_application_id = application.storefront_application_id
     and revision.revision_number = application.current_revision
    where application.tenant_id = p_tenant_id
    order by application.storefront_app_id
    limit 200
  )
  select jsonb_build_object(
    'applications', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'allowedChannels', bounded.allowed_channels,
          'effectiveInterval', jsonb_strip_nulls(jsonb_build_object(
            'effectiveFrom', to_char(bounded.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'effectiveTo', to_char(bounded.effective_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )),
          'lifecycle', bounded.lifecycle,
          'revision', bounded.revision_number,
          'storefrontAppId', bounded.storefront_app_id,
          'storefrontApplicationRef', jsonb_build_object(
            'moduleId', 'commerce.storefront-registry',
            'resourceId', bounded.storefront_application_id::text,
            'resourceType', 'commerce.storefront-registry.storefront-application',
            'tenantId', p_tenant_id::text
          )
        )
        order by bounded.storefront_app_id
      ),
      '[]'::jsonb
    ),
    'observedAt', to_char(v_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from bounded;
end;
$$;

revoke all on function storefront_registry.read_storefront_applications(uuid, jsonb) from public;
grant execute on function storefront_registry.read_storefront_applications(uuid, jsonb) to ontos_runtime;
