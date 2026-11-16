-- The existing read remains compatible with callers that identify the application by appId.
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
  where tenant_id = p_tenant_id and storefront_app_id = p_payload->>'storefrontAppId'
    and (
      p_payload->>'expectedStorefrontApplicationId' is null
      or storefront_application_id = (p_payload->>'expectedStorefrontApplicationId')::uuid
    );

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
      'revision', v_revision.revision_number,
      'storefrontApplicationId', v_application.storefront_application_id
    )
  );
end;
$$;
