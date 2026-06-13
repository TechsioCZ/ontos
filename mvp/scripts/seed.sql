INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
VALUES
  ('ba-user-demo-admin-a', 'Demo Admin A', 'demo-admin-a@example.test', true, now(), now()),
  ('ba-user-demo-viewer-a', 'Demo Viewer A', 'demo-viewer-a@example.test', true, now(), now()),
  ('ba-user-demo-admin-b', 'Demo Admin B', 'demo-admin-b@example.test', true, now(), now())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  "emailVerified" = EXCLUDED."emailVerified",
  "updatedAt" = now();

INSERT INTO auth."account" (
  id,
  "accountId",
  "providerId",
  "userId",
  password,
  "createdAt",
  "updatedAt"
)
VALUES
  (
    'ba-account-demo-admin-a',
    'ba-user-demo-admin-a',
    'credential',
    'ba-user-demo-admin-a',
    'fa9812c1d1efd6d3086e318cac721d45:730609eaf13b56df62469e940384157402bcc98d42ce302f8fe1edf8058f4881a43ee45a0cd5524ab5827d7541011bed467c6eefc5aaecb32319b39d40606b86',
    now(),
    now()
  ),
  (
    'ba-account-demo-viewer-a',
    'ba-user-demo-viewer-a',
    'credential',
    'ba-user-demo-viewer-a',
    'fa9812c1d1efd6d3086e318cac721d45:730609eaf13b56df62469e940384157402bcc98d42ce302f8fe1edf8058f4881a43ee45a0cd5524ab5827d7541011bed467c6eefc5aaecb32319b39d40606b86',
    now(),
    now()
  ),
  (
    'ba-account-demo-admin-b',
    'ba-user-demo-admin-b',
    'credential',
    'ba-user-demo-admin-b',
    'fa9812c1d1efd6d3086e318cac721d45:730609eaf13b56df62469e940384157402bcc98d42ce302f8fe1edf8058f4881a43ee45a0cd5524ab5827d7541011bed467c6eefc5aaecb32319b39d40606b86',
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE SET
  "accountId" = EXCLUDED."accountId",
  "providerId" = EXCLUDED."providerId",
  "userId" = EXCLUDED."userId",
  password = EXCLUDED.password,
  "updatedAt" = now();

INSERT INTO core.tenants (tenant_id, slug, name, status, default_locale, created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'tenant-a', 'Tenant A', 'active', 'en', now(), now()),
  ('22222222-2222-4222-8222-222222222222', 'tenant-b', 'Tenant B', 'active', 'en', now(), now())
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  default_locale = EXCLUDED.default_locale,
  updated_at = now();

INSERT INTO core.legal_entities (
  legal_entity_id,
  tenant_id,
  legal_name,
  registration_country,
  registration_number,
  vat_id,
  status,
  created_at,
  updated_at
)
VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'Tenant A Legal Entity',
    'CZ',
    'TENANT-A-REG',
    'CZ00000001',
    'active',
    now(),
    now()
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '22222222-2222-4222-8222-222222222222',
    'Tenant B Legal Entity',
    'CZ',
    'TENANT-B-REG',
    'CZ00000002',
    'active',
    now(),
    now()
  )
ON CONFLICT (legal_entity_id) DO UPDATE SET
  legal_name = EXCLUDED.legal_name,
  registration_country = EXCLUDED.registration_country,
  registration_number = EXCLUDED.registration_number,
  vat_id = EXCLUDED.vat_id,
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO core.principals (principal_id, tenant_id, kind, display_name, status, created_at)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'human',
    'demo-admin-a',
    'active',
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'human',
    'demo-viewer-a',
    'active',
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    'human',
    'demo-admin-b',
    'active',
    now()
  )
ON CONFLICT (principal_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status;

INSERT INTO core.principal_auth_bindings (
  principal_auth_binding_id,
  tenant_id,
  principal_id,
  provider,
  subject_type,
  provider_subject_id,
  status,
  created_at,
  updated_at
)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000001',
    'better_auth',
    'user',
    'ba-user-demo-admin-a',
    'active',
    now(),
    now()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000002',
    'better_auth',
    'user',
    'ba-user-demo-viewer-a',
    'active',
    now(),
    now()
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    '10000000-0000-4000-8000-000000000003',
    'better_auth',
    'user',
    'ba-user-demo-admin-b',
    'active',
    now(),
    now()
  )
ON CONFLICT (tenant_id, provider, subject_type, provider_subject_id) DO UPDATE SET
  principal_id = EXCLUDED.principal_id,
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO core.tenant_module_state_changes (
  module_state_change_id,
  tenant_id,
  module_key,
  previous_state,
  new_state,
  changed_by_principal_id,
  action_invocation_id,
  change_source,
  reason,
  occurred_at
)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'property.registry',
    NULL,
    'active',
    NULL,
    NULL,
    'system',
    'Day 3 demo seed',
    now()
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'accounting.core',
    NULL,
    'active',
    NULL,
    NULL,
    'system',
    'Day 3 demo seed',
    now()
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    'property.registry',
    NULL,
    'active',
    NULL,
    NULL,
    'system',
    'Day 3 demo seed',
    now()
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '22222222-2222-4222-8222-222222222222',
    'accounting.core',
    NULL,
    'active',
    NULL,
    NULL,
    'system',
    'Day 3 demo seed',
    now()
  )
ON CONFLICT (module_state_change_id) DO NOTHING;

INSERT INTO core.tenant_module_states (
  tenant_module_state_id,
  tenant_id,
  module_key,
  state,
  last_change_id,
  created_at,
  updated_at
)
VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'property.registry',
    'active',
    '30000000-0000-4000-8000-000000000001',
    now(),
    now()
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'accounting.core',
    'active',
    '30000000-0000-4000-8000-000000000002',
    now(),
    now()
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    'property.registry',
    'active',
    '30000000-0000-4000-8000-000000000003',
    now(),
    now()
  ),
  (
    '40000000-0000-4000-8000-000000000004',
    '22222222-2222-4222-8222-222222222222',
    'accounting.core',
    'active',
    '30000000-0000-4000-8000-000000000004',
    now(),
    now()
  )
ON CONFLICT (tenant_id, module_key) DO UPDATE SET
  state = EXCLUDED.state,
  last_change_id = EXCLUDED.last_change_id,
  updated_at = now();
