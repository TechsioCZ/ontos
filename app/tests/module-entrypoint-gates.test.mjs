import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';

import { auth } from '../packages/core-runtime/src/auth/config.ts';
import { createVerticalGatewayToken } from '../packages/core-runtime/src/vertical-gateway-token.ts';
import { sqlClient } from '../packages/core-runtime/src/db/client.ts';
import { runAction } from '../packages/core-runtime/src/core-sdk.ts';
import { allowPolicy } from '../packages/core-runtime/src/policy.ts';
import { checkOutboxWorkerModuleStateAccess } from '../packages/core-runtime/src/outbox-worker.ts';
import {
  handleShellAuthRequest,
  handleShellOperationContextRequest,
} from '../apps/shell-super-app/src/server/auth-handler.ts';
import { shellModuleEntrypoints } from '../apps/shell-super-app/src/module-entrypoints.ts';
import { loadModuleEntrypoint } from '../apps/shell-super-app/src/module-entrypoint-gateway.ts';

const createdEmails = [];
const createdPrincipalAuthBindingIds = [];
const createdTenantIds = [];
const createdPrincipalIds = [];
const createdLegalEntityIds = [];

const appRoot = new URL('..', import.meta.url).pathname;

const collectSourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectSourceFiles(entryPath);
      }

      return /\.(?:ts|tsx|mts|mjs)$/u.test(entry.name) ? [entryPath] : [];
    }),
  );

  return nestedFiles.flat();
};

after(async () => {
  await sqlClient`delete from core.audit_events where tenant_id = any(${createdTenantIds})`;
  await sqlClient`delete from core.action_invocations where tenant_id = any(${createdTenantIds})`;
  await sqlClient`delete from core.tenant_module_states where tenant_id = any(${createdTenantIds})`;

  await Promise.all(
    createdPrincipalAuthBindingIds.map(
      (principalAuthBindingId) =>
        sqlClient`delete from core.principal_auth_bindings where principal_auth_binding_id = ${principalAuthBindingId}`,
    ),
  );

  await Promise.all(
    createdPrincipalIds.map(
      (principalId) => sqlClient`delete from core.principals where principal_id = ${principalId}`,
    ),
  );

  await Promise.all(
    createdLegalEntityIds.map(
      (legalEntityId) =>
        sqlClient`delete from core.legal_entities where legal_entity_id = ${legalEntityId}`,
    ),
  );

  await Promise.all(
    createdTenantIds.map(
      (tenantId) => sqlClient`delete from core.tenants where tenant_id = ${tenantId}`,
    ),
  );

  await Promise.all(
    createdEmails.map((email) => sqlClient`delete from auth."user" where email = ${email}`),
  );

  await sqlClient.end({ timeout: 1 });
});

const createOperationIdentity = async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Module Gate Tenant'}, ${`module-gate-${suffix}`}, ${'en'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);

  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id,
      legal_name,
      registration_country,
      registration_number,
      status
    )
    values (
      ${tenant.tenant_id},
      ${'Module Gate Legal Entity'},
      ${'CZ'},
      ${`module-gate-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  createdLegalEntityIds.push(legalEntity.legal_entity_id);

  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Module Gate Principal'}, ${'human'}, ${'active'})
    returning principal_id, display_name
  `;
  createdPrincipalIds.push(principal.principal_id);

  return {
    legalEntityId: legalEntity.legal_entity_id,
    principalDisplayName: principal.display_name,
    principalId: principal.principal_id,
    tenantId: tenant.tenant_id,
  };
};

const setTenantModuleState = async ({ moduleKey, state, tenantId }) => {
  await sqlClient`
    insert into core.tenant_module_states (tenant_id, module_key, state)
    values (${tenantId}, ${moduleKey}, ${state})
    on conflict (tenant_id, module_key)
    do update set state = excluded.state, updated_at = now()
  `;
};

const createAuthenticatedShellSession = async (operationContext) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `module-gate-${suffix}@example.test`;
  createdEmails.push(email);

  const signUp = await auth.api.signUpEmail({
    body: {
      email,
      name: 'Module Gate BetterAuth User',
      password: 'correct-password',
    },
    headers: new Headers(),
  });

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
      ${operationContext.tenantId},
      ${operationContext.principalId},
      ${'better_auth'},
      ${'user'},
      ${signUp.user.id},
      ${'active'}
    )
    returning principal_auth_binding_id
  `;
  createdPrincipalAuthBindingIds.push(binding.principal_auth_binding_id);

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

  assert.equal(response.status, 200);
  return response.headers.get('set-cookie');
};

const createTicketingMutationRegistration = ({ calls }) => ({
  descriptor: {
    actionKey: 'ticketing.create',
    auditProfile: 'standard',
    authorization: {
      permission: 'create',
      provider: 'spicedb',
      resourceObjectId: 'ticketing',
      resourceObjectType: 'module',
    },
    gatewayAudience: 'ticketing',
    idempotency: 'optional',
    moduleStateAccess: 'mutate',
    transportRequestSchema: {},
    transportResponseSchema: {},
  },
  handler: () => {
    calls.handler += 1;
    return { ok: true };
  },
  policyChecks: [
    () => {
      calls.policy += 1;
      return allowPolicy({
        policyKey: 'ticketing.test-policy',
        reason: 'test allows this action',
      });
    },
  ],
});

test('CoreSDK denies ticketing actions when tenant module state is missing', async () => {
  const operationContext = await createOperationIdentity();
  const calls = {
    authorization: 0,
    handler: 0,
    policy: 0,
  };
  const result = await runAction({
    options: {
      authorizationChecker: () => {
        calls.authorization += 1;
        return { _tag: 'Allowed' };
      },
    },
    payload: { title: 'Blocked ticket' },
    registration: createTicketingMutationRegistration({ calls }),
    transport: {
      headers: new Headers({
        'x-ontos-operation-context': createVerticalGatewayToken({
          audience: 'ticketing',
          operationContext,
        }),
      }),
    },
  });

  assert.equal(result._tag, 'OperationModuleStateDenied');
  assert.equal(result.code, 'module_state_mutate_blocked');
  assert.equal(result.moduleKey, 'ticketing');
  assert.equal(result.state, 'inactive');
  assert.deepEqual(calls, {
    authorization: 0,
    handler: 0,
    policy: 0,
  });
});

test('CoreSDK allows ticketing actions when tenant module state is active', async () => {
  const operationContext = await createOperationIdentity();
  await setTenantModuleState({
    moduleKey: 'ticketing',
    state: 'active',
    tenantId: operationContext.tenantId,
  });
  const calls = {
    authorization: 0,
    handler: 0,
    policy: 0,
  };

  const result = await runAction({
    options: {
      authorizationChecker: () => {
        calls.authorization += 1;
        return { _tag: 'Allowed' };
      },
    },
    payload: { title: 'Allowed ticket' },
    registration: createTicketingMutationRegistration({ calls }),
    transport: {
      headers: new Headers({
        'x-ontos-operation-context': createVerticalGatewayToken({
          audience: 'ticketing',
          operationContext,
        }),
      }),
    },
  });

  assert.equal(result._tag, 'OperationSucceeded');
  assert.deepEqual(result.response, { ok: true });
  assert.deepEqual(calls, {
    authorization: 1,
    handler: 1,
    policy: 1,
  });
});

test('Shell operation context exposes module states only for authenticated OntOS sessions', async () => {
  const operationContext = await createOperationIdentity();
  await setTenantModuleState({
    moduleKey: 'ticketing',
    state: 'active',
    tenantId: operationContext.tenantId,
  });
  const sessionCookie = await createAuthenticatedShellSession(operationContext);

  const unauthenticated = await handleShellOperationContextRequest(
    new Request('http://localhost:3020/shell-super-app-api/operation-context'),
  );
  assert.equal(unauthenticated.status, 401);

  const authenticated = await handleShellOperationContextRequest(
    new Request('http://localhost:3020/shell-super-app-api/operation-context', {
      headers: {
        cookie: sessionCookie,
      },
    }),
  );

  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), {
    moduleStates: [{ moduleKey: 'ticketing', state: 'active' }],
    operationContext,
  });
});

test('Shell module federation gateway fails closed before loading inactive entrypoints', async () => {
  let loadCount = 0;

  const result = await loadModuleEntrypoint({
    entrypoint: shellModuleEntrypoints.ticketingWidget,
    loader: () => {
      loadCount += 1;
      return Promise.resolve({ default: () => null });
    },
    moduleStates: [],
  });

  assert.equal(result._tag, 'ModuleEntrypointDenied');
  assert.equal(result.accessKind, 'load');
  assert.equal(result.moduleKey, 'ticketing');
  assert.equal(result.state, 'inactive');
  assert.equal(loadCount, 0);
});

test('Shell module federation gateway loads active and read-only page/component entrypoints', async () => {
  const loadedSpecifiers = [];
  const loader = (specifier) => {
    loadedSpecifiers.push(specifier);
    return Promise.resolve({ specifier });
  };

  const activePage = await loadModuleEntrypoint({
    entrypoint: shellModuleEntrypoints.ticketingPage,
    loader,
    moduleStates: [{ moduleKey: 'ticketing', state: 'active' }],
  });
  const readOnlyWidget = await loadModuleEntrypoint({
    entrypoint: shellModuleEntrypoints.ticketingWidget,
    loader,
    moduleStates: [{ moduleKey: 'ticketing', state: 'read_only' }],
  });

  assert.deepEqual(activePage, {
    _tag: 'ModuleEntrypointLoaded',
    module: { specifier: 'ticketing/Route' },
  });
  assert.deepEqual(readOnlyWidget, {
    _tag: 'ModuleEntrypointLoaded',
    module: { specifier: 'ticketing/Widget' },
  });
  assert.deepEqual(loadedSpecifiers, ['ticketing/Route', 'ticketing/Widget']);
});

test('Core worker gate checks consumer module mutate access and ignores producer module state', async () => {
  const operationContext = await createOperationIdentity();
  await setTenantModuleState({
    moduleKey: 'ticketing',
    state: 'read_only',
    tenantId: operationContext.tenantId,
  });

  const denied = await checkOutboxWorkerModuleStateAccess({
    consumerModuleKey: 'ticketing',
    producerModuleKey: 'unknown-producer',
    tenantId: operationContext.tenantId,
  });

  assert.deepEqual(denied, {
    _tag: 'Denied',
    accessKind: 'mutate',
    moduleKey: 'ticketing',
    outcomeCode: 'module_state_mutate_blocked',
    state: 'read_only',
  });

  await setTenantModuleState({
    moduleKey: 'ticketing',
    state: 'active',
    tenantId: operationContext.tenantId,
  });

  const allowed = await checkOutboxWorkerModuleStateAccess({
    consumerModuleKey: 'ticketing',
    producerModuleKey: 'still-ignored',
    tenantId: operationContext.tenantId,
  });

  assert.deepEqual(allowed, {
    _tag: 'Allowed',
    accessKind: 'mutate',
    moduleKey: 'ticketing',
    state: 'active',
  });
});

test('Shell source forbids raw Module Federation loadRemote outside the gateway', async () => {
  const sourceRoot = path.join(appRoot, 'apps/shell-super-app/src');
  const files = await collectSourceFiles(sourceRoot);
  const offenderCandidates = await Promise.all(
    files
      .filter((file) => !file.endsWith('/module-federation-gateway.ts'))
      .map(async (file) => {
        const source = await readFile(file, 'utf-8');

        return source.includes('loadRemote') ? path.relative(appRoot, file) : undefined;
      }),
  );
  const offenders = offenderCandidates.filter((file) => file !== undefined);

  assert.deepEqual(offenders, []);
});
