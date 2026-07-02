import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { auth } from '../packages/core-runtime/src/auth/config.ts';
import { sqlClient } from '../packages/core-runtime/src/db/client.ts';
import { handleShellAuthRequest } from '../apps/shell-super-app/src/server/auth-handler.ts';

const createdEmails = [];
const createdPrincipalAuthBindingIds = [];
const createdPrincipalIds = [];
const createdTenantIds = [];

after(async () => {
  for (const principalAuthBindingId of createdPrincipalAuthBindingIds) {
    await sqlClient`delete from core.principal_auth_bindings where principal_auth_binding_id = ${principalAuthBindingId}`;
  }

  for (const principalId of createdPrincipalIds) {
    await sqlClient`delete from core.principals where principal_id = ${principalId}`;
  }

  for (const tenantId of createdTenantIds) {
    await sqlClient`delete from core.tenants where tenant_id = ${tenantId}`;
  }

  for (const email of createdEmails) {
    await sqlClient`delete from auth."user" where email = ${email}`;
  }

  await sqlClient.end({ timeout: 1 });
});

test('shell auth handler serves BetterAuth email sign-in failures at the configured auth path', async () => {
  const response = await handleShellAuthRequest(
    new Request('http://localhost:3020/shell-super-app-api/auth/sign-in/email', {
      body: JSON.stringify({
        email: 'missing-user@example.test',
        password: 'not-the-password',
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  );

  assert.equal(response.status, 401);
});

test('shell auth handler stops returning a session after the active Principal Auth Binding is revoked', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `bound-${suffix}@example.test`;
  createdEmails.push(email);

  const signUp = await auth.api.signUpEmail({
    body: {
      email,
      name: 'Bound BetterAuth User',
      password: 'correct-password',
    },
    headers: new Headers(),
  });

  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'TDD Tenant'}, ${`tdd-${suffix}`}, ${'en'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);

  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'TDD Principal'}, ${'human'}, ${'active'})
    returning principal_id
  `;
  createdPrincipalIds.push(principal.principal_id);

  const [binding] = await sqlClient`
    insert into core.principal_auth_bindings (
      tenant_id,
      principal_id,
      provider,
      subject_type,
      provider_subject_id,
      status
    )
    values (
      ${tenant.tenant_id},
      ${principal.principal_id},
      ${'better_auth'},
      ${'user'},
      ${signUp.user.id},
      ${'active'}
    )
    returning principal_auth_binding_id
  `;
  createdPrincipalAuthBindingIds.push(binding.principal_auth_binding_id);

  const signInResponse = await handleShellAuthRequest(
    new Request('http://localhost:3020/shell-super-app-api/auth/sign-in/email', {
      body: JSON.stringify({
        email,
        password: 'correct-password',
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  );
  const sessionCookie = signInResponse.headers.get('set-cookie');

  assert.equal(signInResponse.status, 200);
  assert.ok(sessionCookie);

  await sqlClient`
    update core.principal_auth_bindings
    set status = ${'revoked'}, revoked_at = now()
    where principal_auth_binding_id = ${binding.principal_auth_binding_id}
  `;

  const getSessionResponse = await handleShellAuthRequest(
    new Request('http://localhost:3020/shell-super-app-api/auth/get-session', {
      headers: {
        cookie: sessionCookie,
      },
    }),
  );

  assert.equal(getSessionResponse.status, 200);
  assert.equal(await getSessionResponse.text(), 'null');
});

test('shell auth handler rejects a BetterAuth user without an active Principal Auth Binding', async () => {
  const email = `unbound-${Date.now()}@example.test`;
  createdEmails.push(email);

  const signUp = await auth.api.signUpEmail({
    body: {
      email,
      name: 'Unbound BetterAuth User',
      password: 'correct-password',
    },
    headers: new Headers(),
  });

  const response = await handleShellAuthRequest(
    new Request('http://localhost:3020/shell-super-app-api/auth/sign-in/email', {
      body: JSON.stringify({
        email,
        password: 'correct-password',
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  );

  const missingUserResponse = await handleShellAuthRequest(
    new Request('http://localhost:3020/shell-super-app-api/auth/sign-in/email', {
      body: JSON.stringify({
        email: 'same-generic-response@example.test',
        password: 'correct-password',
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  );
  const missingUserBody = await missingUserResponse.text();
  const responseBody = await response.text();
  const [sessionCount] = await sqlClient`
    select count(*)::int as count
    from auth.session
    where user_id = ${signUp.user.id}
  `;

  assert.equal(response.status, 401);
  assert.equal(responseBody, missingUserBody);
  assert.equal(sessionCount.count, 0);
});
