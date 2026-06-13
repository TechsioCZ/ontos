create extension if not exists pgcrypto;
create schema if not exists auth;
create schema if not exists core;
create schema if not exists accounting;
create schema if not exists property;

create table if not exists auth."user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default true,
  image text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists auth."account" (
  id text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references auth."user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists auth."session" (
  id text primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references auth."user"(id) on delete cascade
);

create table if not exists auth."verification" (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists core.tenants (
  tenant_id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null check (status in ('active', 'suspended', 'archived')),
  default_locale text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.legal_entities (
  legal_entity_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_name text not null,
  registration_country text not null,
  registration_number text not null,
  vat_id text,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, registration_country, registration_number)
);

create table if not exists core.principals (
  principal_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  kind text not null check (kind in ('human', 'service', 'integration', 'agent', 'system')),
  display_name text not null,
  status text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists core.principal_auth_bindings (
  principal_auth_binding_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  principal_id uuid not null references core.principals(principal_id),
  provider text not null,
  subject_type text not null,
  provider_subject_id text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, provider, subject_type, provider_subject_id)
);

create table if not exists core.tenant_module_state_changes (
  module_state_change_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  module_key text not null,
  previous_state text,
  new_state text not null,
  changed_by_principal_id uuid references core.principals(principal_id),
  action_invocation_id uuid,
  change_source text not null check (change_source in ('user', 'support', 'system')),
  reason text not null,
  occurred_at timestamptz not null default now()
);

create table if not exists core.tenant_module_states (
  tenant_module_state_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  module_key text not null,
  state text not null check (state in ('inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived')),
  last_change_id uuid references core.tenant_module_state_changes(module_state_change_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, module_key)
);

create table if not exists core.action_invocations (
  action_invocation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  principal_id uuid not null references core.principals(principal_id),
  auth_binding_id uuid references core.principal_auth_bindings(principal_auth_binding_id),
  impersonated_by_principal_id uuid references core.principals(principal_id),
  auth_method text not null,
  auth_context_ref text not null,
  trace_id text,
  correlation_id text,
  action_key text not null,
  idempotency_key text,
  target_module_key text not null,
  target_resource_type text not null,
  target_resource_id text not null,
  status text not null check (status in ('received', 'rejected', 'running', 'succeeded', 'failed', 'replayed')),
  request_hash text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'core_tenant_module_state_changes_action_fk'
      and conrelid = 'core.tenant_module_state_changes'::regclass
  ) then
    alter table core.tenant_module_state_changes
      add constraint core_tenant_module_state_changes_action_fk
      foreign key (action_invocation_id) references core.action_invocations(action_invocation_id);
  end if;
end $$;

create table if not exists core.audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  action_invocation_id uuid references core.action_invocations(action_invocation_id),
  principal_id uuid references core.principals(principal_id),
  auth_binding_id uuid references core.principal_auth_bindings(principal_auth_binding_id),
  impersonated_by_principal_id uuid references core.principals(principal_id),
  auth_method text not null,
  auth_context_ref text not null,
  event_type text not null,
  outcome text not null,
  outcome_stage text not null,
  outcome_code text not null,
  audit_profile text not null,
  target_module_key text not null,
  target_resource_type text not null,
  target_resource_id text not null,
  evidence_json jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table if not exists core.data_access_events (
  data_access_event_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  action_invocation_id uuid references core.action_invocations(action_invocation_id),
  principal_id uuid not null references core.principals(principal_id),
  auth_binding_id uuid references core.principal_auth_bindings(principal_auth_binding_id),
  impersonated_by_principal_id uuid references core.principals(principal_id),
  auth_method text not null,
  auth_context_ref text not null,
  access_kind text not null,
  serving_module_key text not null,
  target_module_key text,
  target_resource_type text,
  target_resource_id text,
  query_hash text not null,
  result_count integer not null default 0,
  result_fingerprint_schema text,
  result_fingerprint_hash text,
  evidence_policy_key text not null,
  evidence_capture_mode text not null,
  evidence_payload_json jsonb,
  redaction_profile text,
  occurred_at timestamptz not null default now()
);

create table if not exists core.domain_events (
  domain_event_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  action_invocation_id uuid references core.action_invocations(action_invocation_id),
  producer_module_key text not null,
  event_type text not null,
  subject_module_key text not null,
  subject_resource_type text not null,
  subject_resource_id text not null,
  payload_json jsonb not null,
  tenant_sequence_no bigint not null,
  occurred_at timestamptz not null default now(),
  unique (tenant_id, tenant_sequence_no)
);

create table if not exists core.outbox_messages (
  outbox_message_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  domain_event_id uuid not null references core.domain_events(domain_event_id),
  producer_module_key text not null,
  topic text not null,
  payload_json jsonb not null,
  status text not null check (status in ('pending', 'processing', 'done', 'dead')),
  attempts_count integer not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists core.outbox_attempts (
  outbox_attempt_id uuid primary key default gen_random_uuid(),
  outbox_message_id uuid not null references core.outbox_messages(outbox_message_id),
  worker_id text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text
);

create table if not exists core.media_assets (
  media_asset_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  ingested_by_principal_id uuid references core.principals(principal_id),
  ingestion_source text not null,
  external_source_ref text,
  storage_provider text not null,
  storage_key text not null unique,
  storage_object_version_ref text,
  original_filename text,
  display_filename text not null,
  mime_type text not null,
  byte_size bigint not null,
  content_sha256 text not null,
  sealed_at timestamptz,
  processing_status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.evidence_references (
  evidence_reference_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  media_asset_id uuid not null references core.media_assets(media_asset_id),
  source_kind text not null,
  action_invocation_id uuid references core.action_invocations(action_invocation_id),
  audit_event_id uuid references core.audit_events(audit_event_id),
  data_access_event_id uuid references core.data_access_events(data_access_event_id),
  domain_event_id uuid references core.domain_events(domain_event_id),
  evidence_kind text not null,
  subject_module_key text,
  subject_resource_type text,
  subject_resource_id text,
  evidence_policy_key text not null,
  retention_policy_key text not null,
  artifact_content_sha256 text not null,
  storage_lock_scope text not null,
  storage_lock_mode text not null,
  storage_legal_hold boolean not null default false,
  storage_retain_until timestamptz,
  storage_lock_status text not null,
  storage_lock_verified_at timestamptz,
  storage_lock_evidence_json jsonb,
  retain_until timestamptz,
  legal_hold_until timestamptz,
  disposition_status text not null,
  data_classification text not null,
  schema_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists core.media_links (
  media_link_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  media_asset_id uuid not null references core.media_assets(media_asset_id),
  linked_by_principal_id uuid references core.principals(principal_id),
  action_invocation_id uuid references core.action_invocations(action_invocation_id),
  link_source text not null,
  target_module_key text not null,
  target_resource_type text not null,
  target_resource_id text not null,
  link_kind text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists core.search_index_entries (
  search_index_entry_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid references core.legal_entities(legal_entity_id),
  source_module_key text not null,
  source_resource_type text not null,
  source_resource_id text not null,
  title text not null,
  body_text text not null,
  facets_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.worker_checkpoints (
  tenant_id uuid not null references core.tenants(tenant_id),
  consumer_name text not null,
  stream_key text not null,
  last_tenant_sequence_no bigint,
  last_processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, consumer_name, stream_key)
);

create table if not exists core.legal_entity_groups (
  legal_entity_group_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  group_type text not null,
  name text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.legal_entity_group_members (
  group_member_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_group_id uuid not null references core.legal_entity_groups(legal_entity_group_id),
  legal_entity_id uuid not null references core.legal_entities(legal_entity_id),
  member_role text not null,
  valid_from date not null,
  valid_to date
);

create table if not exists property.properties (
  property_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid not null references core.legal_entities(legal_entity_id),
  code text not null,
  name text not null,
  lifecycle_state text not null,
  address_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists property.buildings (
  building_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  property_id uuid not null references property.properties(property_id),
  code text not null,
  name text not null,
  lifecycle_state text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, property_id, code)
);

create table if not exists property.units (
  unit_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  building_id uuid not null references property.buildings(building_id),
  code text not null,
  unit_type text not null,
  floor_label text not null,
  area_m2 numeric not null,
  lifecycle_state text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, building_id, code)
);

create table if not exists property.short_term_legal_entity_settings (
  settings_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid not null references core.legal_entities(legal_entity_id),
  status text not null,
  default_currency text not null,
  booking_rules_profile_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, legal_entity_id)
);

create table if not exists accounting.numbering_series (
  numbering_series_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid not null references core.legal_entities(legal_entity_id),
  code text not null,
  format_pattern text not null,
  next_number integer not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, legal_entity_id, code)
);

create table if not exists accounting.invoices (
  invoice_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  legal_entity_id uuid not null references core.legal_entities(legal_entity_id),
  created_by_principal_id uuid not null references core.principals(principal_id),
  numbering_series_id uuid references accounting.numbering_series(numbering_series_id),
  invoice_number text unique,
  customer_module_key text not null,
  customer_resource_type text not null,
  customer_resource_id text not null,
  status text not null,
  currency text not null,
  total_amount_minor bigint not null,
  issued_at timestamptz,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists accounting.invoice_lines (
  invoice_line_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  invoice_id uuid not null references accounting.invoices(invoice_id),
  line_no integer not null,
  description text not null,
  quantity numeric not null,
  unit_amount_minor bigint not null,
  tax_rate_bps integer not null,
  line_total_minor bigint not null,
  unique (tenant_id, invoice_id, line_no)
);

create table if not exists accounting.invoice_line_sources (
  invoice_line_source_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(tenant_id),
  invoice_line_id uuid not null references accounting.invoice_lines(invoice_line_id),
  source_module_key text not null,
  source_resource_type text not null,
  source_resource_id text not null,
  source_kind text not null,
  allocation_ratio_bps integer,
  allocated_amount_minor bigint,
  created_at timestamptz not null default now()
);

create unique index if not exists core_action_invocations_idempotency_unique
  on core.action_invocations (tenant_id, action_key, principal_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists core_legal_entities_tenant_idx on core.legal_entities (tenant_id);
create index if not exists core_principals_tenant_idx on core.principals (tenant_id);
create index if not exists core_principal_auth_bindings_lookup_idx on core.principal_auth_bindings (provider, subject_type, provider_subject_id, status);
create index if not exists core_tenant_module_states_lookup_idx on core.tenant_module_states (tenant_id, module_key, state);
create index if not exists core_action_invocations_tenant_status_idx on core.action_invocations (tenant_id, status, started_at);
create index if not exists core_audit_events_tenant_target_idx on core.audit_events (tenant_id, target_module_key, target_resource_type, target_resource_id);
create index if not exists core_data_access_events_tenant_target_idx on core.data_access_events (tenant_id, target_module_key, target_resource_type, target_resource_id);
create index if not exists core_domain_events_tenant_sequence_idx on core.domain_events (tenant_id, tenant_sequence_no);
create index if not exists core_outbox_messages_claim_idx on core.outbox_messages (status, available_at, created_at);
create index if not exists core_media_links_target_idx on core.media_links (tenant_id, target_module_key, target_resource_type, target_resource_id);
create index if not exists core_search_index_entries_source_idx on core.search_index_entries (tenant_id, source_module_key, source_resource_type, source_resource_id);
create index if not exists property_properties_tenant_idx on property.properties (tenant_id, legal_entity_id);
create index if not exists property_buildings_tenant_idx on property.buildings (tenant_id, property_id);
create index if not exists property_units_tenant_idx on property.units (tenant_id, building_id);
create index if not exists accounting_invoices_tenant_idx on accounting.invoices (tenant_id, legal_entity_id, status);
