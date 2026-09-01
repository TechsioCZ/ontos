import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  CurrentSessionSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  ApiKeyLifecycleResponseSchema,
  ChangePrincipalStatusPayloadSchema,
  IdentityRequestHeadersSchema,
  SignInPayloadSchema,
  ResolveModuleTargetPayloadSchema,
  ShellAuthenticationApi,
  SwitchTenantPayloadSchema,
  SwitchTenantResponseSchema,
  SwitchLegalEntityPayloadSchema,
  SetApiKeyStatusPayloadSchema,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';

type TenantEndpoint =
  | typeof ShellAuthenticationApi.groups.tenants.endpoints.availableTenants
  | typeof ShellAuthenticationApi.groups.tenants.endpoints.switchTenant;

const statuses = (endpoint: TenantEndpoint) =>
  [...endpoint.error]
    .map((schema) => schema.ast.annotations?.['httpApiStatus'])
    .toSorted((left, right) => Number(left) - Number(right));

test('publishes authentication, identity lifecycle, and gateway operations', () => {
  const authenticationEndpoints = Object.keys(
    ShellAuthenticationApi.groups.authentication.endpoints,
  ).toSorted();
  const gatewayEndpoints = Object.keys(ShellAuthenticationApi.groups.gatewayContext.endpoints);
  const identityEndpoints = Object.keys(
    ShellAuthenticationApi.groups.identity.endpoints,
  ).toSorted();
  const legalEntityEndpoints = Object.keys(
    ShellAuthenticationApi.groups.legalEntities.endpoints,
  ).toSorted();
  const tenantEndpoints = Object.keys(ShellAuthenticationApi.groups.tenants.endpoints).toSorted();
  const resourceEndpoints = Object.keys(
    ShellAuthenticationApi.groups.resources.endpoints,
  ).toSorted();

  expect(authenticationEndpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(gatewayEndpoints).toEqual(['issueGatewayContext', 'issueApiKeyGatewayContext']);
  expect(identityEndpoints).toEqual([
    'changePrincipalStatus',
    'createNonHumanPrincipal',
    'issueManagedApiKey',
    'issueSelfApiKey',
    'listManagedApiKeys',
    'listSelfApiKeys',
    'rotateManagedApiKey',
    'rotateSelfApiKey',
    'setManagedApiKeyStatus',
    'setSelfApiKeyStatus',
    'startSupportImpersonation',
    'stopSupportImpersonation',
  ]);
  expect(legalEntityEndpoints).toEqual(['availableLegalEntities', 'switchLegalEntity']);
  expect(tenantEndpoints).toEqual(['availableTenants', 'switchTenant']);
  expect(resourceEndpoints).toEqual(['attachMedia', 'resourceDetail', 'search']);
  expect(shellAuthenticationApiContract).toEqual({
    apiPrefix: '/shell-super-app-api',
    availableLegalEntitiesPath: '/shell-super-app-api/auth/legal-entities',
    availableTenantsPath: '/shell-super-app-api/auth/tenants',
    changePrincipalStatusPath: '/shell-super-app-api/auth/identity/principal-status',
    compositionPath: '/shell-super-app-api/shell/composition',
    createNonHumanPrincipalPath: '/shell-super-app-api/auth/identity/principals',
    currentSessionPath: '/shell-super-app-api/auth/session',
    issueApiKeyGatewayContextPath: '/shell-super-app-api/auth/api-key/gateway-context',
    issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
    issueManagedApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/managed',
    issueSelfApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/self',
    listManagedApiKeysPath: '/shell-super-app-api/auth/identity/api-keys/managed/list',
    listSelfApiKeysPath: '/shell-super-app-api/auth/identity/api-keys/self/list',
    mediaAttachmentPath: '/shell-super-app-api/shell/resource/media-attachment',
    ownerId: 'shell-super-app',
    resolveModuleTargetPath: '/shell-super-app-api/shell/module-target',
    resourceDetailPath: '/shell-super-app-api/shell/resource',
    rotateManagedApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/managed/rotate',
    rotateSelfApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/self/rotate',
    searchPath: '/shell-super-app-api/shell/search',
    setManagedApiKeyStatusPath: '/shell-super-app-api/auth/identity/api-keys/managed/status',
    setSelfApiKeyStatusPath: '/shell-super-app-api/auth/identity/api-keys/self/status',
    signInPath: '/shell-super-app-api/auth/sign-in',
    signOutPath: '/shell-super-app-api/auth/sign-out',
    startSupportImpersonationPath: '/shell-super-app-api/auth/identity/impersonation/start',
    stopSupportImpersonationPath: '/shell-super-app-api/auth/identity/impersonation/stop',
    switchLegalEntityPath: '/shell-super-app-api/auth/legal-entity/switch',
    switchTenantPath: '/shell-super-app-api/auth/tenant/switch',
  });
  expect([...authenticationEndpoints, ...gatewayEndpoints].join(':')).not.toMatch(
    /testing|actionKey/u,
  );
});

test('decodes a missing identity idempotency header so handlers can return declared 428', async () => {
  await expect(
    Effect.runPromise(Schema.decodeUnknownEffect(IdentityRequestHeadersSchema)({})),
  ).resolves.toEqual({});
  await expect(
    Effect.runPromise(
      Effect.flip(
        Schema.decodeUnknownEffect(IdentityRequestHeadersSchema)({
          'idempotency-key': '',
        }),
      ),
    ),
  ).resolves.toBeDefined();
});

test('publishes exact legal-entity endpoints with an ID-only switch payload', async () => {
  const { availableLegalEntities, switchLegalEntity } =
    ShellAuthenticationApi.groups.legalEntities.endpoints;
  expect({ method: availableLegalEntities.method, path: availableLegalEntities.path }).toEqual({
    method: 'GET',
    path: '/auth/legal-entities',
  });
  expect({ method: switchLegalEntity.method, path: switchLegalEntity.path }).toEqual({
    method: 'POST',
    path: '/auth/legal-entity/switch',
  });
  const legalEntityId = '35000000-0000-4000-8000-000000000001';
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(SwitchLegalEntityPayloadSchema)({
        authorization: 'must-not-pass',
        legalEntityId,
        tenantId: 'must-not-pass',
      }),
    ),
  ).toEqual({ legalEntityId });
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(AvailableLegalEntitiesResponseSchema)({
        legalEntities: [{ legalEntityId, legalName: 'Alpha', token: 'must-not-pass' }],
        selectedLegalEntityId: legalEntityId,
        state: 'authenticated',
      }),
    ),
  ).toEqual({
    legalEntities: [{ legalEntityId, legalName: 'Alpha' }],
    selectedLegalEntityId: legalEntityId,
    state: 'authenticated',
  });
});

test('decodes an optional exact page entrypoint without accepting private routing fields', async () => {
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
        entrypointKey: 'contacts.core.page.customers',
        importPath: 'must-not-pass',
        moduleId: 'contacts.core',
        routePath: '/contacts/customers',
      }),
    ),
  ).toEqual({ entrypointKey: 'contacts.core.page.customers', moduleId: 'contacts.core' });
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({ moduleId: 'contacts.core' }),
    ),
  ).toEqual({ moduleId: 'contacts.core' });
  await expect(
    Effect.runPromise(
      Effect.flip(
        Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
          entrypointKey: '../private-page',
          moduleId: 'contacts.core',
        }),
      ),
    ),
  ).resolves.toBeDefined();
});

test('publishes exact tenant methods, paths, and declared failure statuses', () => {
  const { availableTenants, switchTenant } = ShellAuthenticationApi.groups.tenants.endpoints;
  expect({ method: availableTenants.method, path: availableTenants.path }).toEqual({
    method: 'GET',
    path: '/auth/tenants',
  });
  expect({ method: switchTenant.method, path: switchTenant.path }).toEqual({
    method: 'POST',
    path: '/auth/tenant/switch',
  });
  expect(statuses(availableTenants)).toEqual([401, 500, 503]);
  expect(statuses(switchTenant)).toEqual([401, 403, 500, 503]);
});

test('publishes the exhaustive identity failure status contract', () => {
  for (const endpoint of Object.values(ShellAuthenticationApi.groups.identity.endpoints)) {
    const identityStatuses = [...endpoint.error]
      .map((schema) => schema.ast.annotations?.['httpApiStatus'])
      .toSorted((left, right) => Number(left) - Number(right));

    expect(identityStatuses).toEqual([400, 401, 403, 404, 409, 422, 428, 429, 500, 503]);
  }
});

test('validates tenant UUIDs and strips all non-contract fields', async () => {
  const tenantId = '30000000-0000-4000-8000-000000000001';
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(AvailableTenantsResponseSchema)({
        tenants: [
          {
            bindingId: 'must-not-pass',
            name: 'Alpha tenant',
            principalId: 'must-not-pass',
            sessionId: 'must-not-pass',
            tenantId,
            token: 'must-not-pass',
          },
        ],
      }),
    ),
  ).toEqual({ tenants: [{ name: 'Alpha tenant', tenantId }] });
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(SwitchTenantResponseSchema)({
        principalId: 'must-not-pass',
        selectedTenantId: tenantId,
        sessionId: 'must-not-pass',
      }),
    ),
  ).toEqual({ selectedTenantId: tenantId });
  expect(
    await Effect.runPromise(Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId })),
  ).toEqual({ tenantId });
  const invalidPayload = await Effect.runPromise(
    Effect.flip(Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId: 'not-a-uuid' })),
  );
  expect(invalidPayload._tag).toBe('SchemaError');
});

test('rejects malformed credentials through Effect Schema', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Schema.decodeUnknownEffect(SignInPayloadSchema)({
        email: '',
        password: '',
      }),
    ),
  );
  expect(error._tag).toBe('SchemaError');
});

test('requires lifecycle reasons and strips provider-private API key identifiers', async () => {
  const principalId = '00000000-0000-4000-8000-000000000001';
  const authBindingId = '00000000-0000-4000-8000-000000000002';
  const missingPrincipalReason = await Effect.runPromise(
    Effect.flip(
      Schema.decodeUnknownEffect(ChangePrincipalStatusPayloadSchema)({
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId,
      }),
    ),
  );
  const missingRevocationReason = await Effect.runPromise(
    Effect.flip(
      Schema.decodeUnknownEffect(SetApiKeyStatusPayloadSchema)({
        authBindingId,
        expectedStatus: 'active',
        newStatus: 'revoked',
      }),
    ),
  );
  expect(missingPrincipalReason._tag).toBe('SchemaError');
  expect(missingRevocationReason._tag).toBe('SchemaError');

  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(ApiKeyLifecycleResponseSchema)({
        authBindingId,
        cleanupPending: false,
        createdAt: '2026-08-09T00:00:00.000Z',
        enabled: true,
        expiresAt: null,
        id: 'private-provider-key-id',
        name: null,
        providerKeyId: 'private-provider-key-id',
        start: 'onto',
      }),
    ),
  ).toEqual({
    authBindingId,
    cleanupPending: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    enabled: true,
    expiresAt: null,
    name: null,
    start: 'onto',
  });
});

test('decodes only safe current-session identity fields', async () => {
  const session = await Effect.runPromise(
    Schema.decodeUnknownEffect(CurrentSessionSchema)({
      identity: {
        displayName: 'Ada',
        email: 'ada@example.test',
        legalEntityId: '35000000-0000-4000-8000-000000000001',
        legalName: 'Alpha legal entity',
        password: 'must-not-pass',
        principalId: 'principal-id',
        tenantId: 'tenant-id',
        token: 'must-not-pass',
      },
      state: 'authenticated',
    }),
  );
  expect(session).toEqual({
    identity: {
      displayName: 'Ada',
      email: 'ada@example.test',
      legalEntityId: '35000000-0000-4000-8000-000000000001',
      legalName: 'Alpha legal entity',
      principalId: 'principal-id',
      tenantId: 'tenant-id',
    },
    state: 'authenticated',
  });
});
