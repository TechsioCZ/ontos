import { expect, it } from '@app/effect-rstest';
import { DateTime, Effect, Schema, Predicate } from 'effect';
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

it('publishes authentication, identity lifecycle, and gateway operations', () => {
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

it.effect('decodes a missing identity idempotency header so handlers can return declared 428', () =>
  Effect.gen(function* testProgram1() {
    expect(yield* Schema.decodeUnknownEffect(IdentityRequestHeadersSchema)({})).toEqual({});
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(IdentityRequestHeadersSchema)({
          'idempotency-key': '',
        }),
      ),
    ).toBeDefined();
  }),
);

it.effect('publishes exact legal-entity endpoints with an ID-only switch payload', () =>
  Effect.gen(function* testProgram2() {
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
      yield* Schema.decodeUnknownEffect(SwitchLegalEntityPayloadSchema)({
        authorization: 'must-not-pass',
        legalEntityId,
        tenantId: 'must-not-pass',
      }),
    ).toEqual({ legalEntityId });
    expect(
      yield* Schema.decodeUnknownEffect(AvailableLegalEntitiesResponseSchema)({
        legalEntities: [{ legalEntityId, legalName: 'Alpha', token: 'must-not-pass' }],
        selectedLegalEntityId: legalEntityId,
        state: 'authenticated',
      }),
    ).toEqual({
      legalEntities: [{ legalEntityId, legalName: 'Alpha' }],
      selectedLegalEntityId: legalEntityId,
      state: 'authenticated',
    });
  }),
);

it.effect(
  'decodes an optional exact page entrypoint without accepting private routing fields',
  () =>
    Effect.gen(function* testProgram3() {
      expect(
        yield* Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
          entrypointKey: 'contacts.core.page.customers',
          importPath: 'must-not-pass',
          moduleId: 'contacts.core',
          routePath: '/contacts/customers',
        }),
      ).toEqual({ entrypointKey: 'contacts.core.page.customers', moduleId: 'contacts.core' });
      expect(
        yield* Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
          moduleId: 'contacts.core',
        }),
      ).toEqual({ moduleId: 'contacts.core' });
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
            entrypointKey: '../private-page',
            moduleId: 'contacts.core',
          }),
        ),
      ).toBeDefined();
    }),
);

it('publishes exact tenant methods, paths, and declared failure statuses', () => {
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

it('publishes the exhaustive identity failure status contract', () => {
  for (const endpoint of Object.values(ShellAuthenticationApi.groups.identity.endpoints)) {
    const identityStatuses = [...endpoint.error]
      .map((schema) => schema.ast.annotations?.['httpApiStatus'])
      .toSorted((left, right) => Number(left) - Number(right));

    expect(identityStatuses).toEqual([400, 401, 403, 404, 409, 422, 428, 429, 500, 503]);
  }
});

it.effect('validates tenant UUIDs and strips all non-contract fields', () =>
  Effect.gen(function* testProgram4() {
    const tenantId = '30000000-0000-4000-8000-000000000001';
    expect(
      yield* Schema.decodeUnknownEffect(AvailableTenantsResponseSchema)({
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
    ).toEqual({ tenants: [{ name: 'Alpha tenant', tenantId }] });
    expect(
      yield* Schema.decodeUnknownEffect(SwitchTenantResponseSchema)({
        principalId: 'must-not-pass',
        selectedTenantId: tenantId,
        sessionId: 'must-not-pass',
      }),
    ).toEqual({ selectedTenantId: tenantId });
    expect(yield* Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId })).toEqual({
      tenantId,
    });
    const invalidPayload = yield* Effect.flip(
      Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId: 'not-a-uuid' }),
    );
    expect(Predicate.isTagged(invalidPayload, 'SchemaError')).toBe(true);
  }),
);

it.effect('rejects malformed credentials through Effect Schema', () =>
  Effect.gen(function* testProgram5() {
    const error = yield* Effect.flip(
      Schema.decodeUnknownEffect(SignInPayloadSchema)({
        email: '',
        password: '',
      }),
    );
    expect(Predicate.isTagged(error, 'SchemaError')).toBe(true);
  }),
);

it.effect('requires lifecycle reasons and strips provider-private API key identifiers', () =>
  Effect.gen(function* testProgram6() {
    const principalId = '00000000-0000-4000-8000-000000000001';
    const authBindingId = '00000000-0000-4000-8000-000000000002';
    const createdAt = '2026-08-09T00:00:00.000Z';
    const missingPrincipalReason = yield* Effect.flip(
      Schema.decodeUnknownEffect(ChangePrincipalStatusPayloadSchema)({
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId,
      }),
    );
    const missingRevocationReason = yield* Effect.flip(
      Schema.decodeUnknownEffect(SetApiKeyStatusPayloadSchema)({
        authBindingId,
        expectedStatus: 'active',
        newStatus: 'revoked',
      }),
    );
    expect(Predicate.isTagged(missingPrincipalReason, 'SchemaError')).toBe(true);
    expect(Predicate.isTagged(missingRevocationReason, 'SchemaError')).toBe(true);

    const lifecycle = yield* Schema.decodeUnknownEffect(ApiKeyLifecycleResponseSchema)({
      authBindingId,
      cleanupPending: false,
      createdAt,
      enabled: true,
      expiresAt: null,
      id: 'private-provider-key-id',
      name: null,
      providerKeyId: 'private-provider-key-id',
      start: 'onto',
    });
    expect(lifecycle).toEqual({
      authBindingId,
      cleanupPending: false,
      createdAt: DateTime.makeUnsafe(createdAt),
      enabled: true,
      expiresAt: null,
      name: null,
      start: 'onto',
    });
    expect(yield* Schema.encodeEffect(ApiKeyLifecycleResponseSchema)(lifecycle)).toEqual({
      authBindingId,
      cleanupPending: false,
      createdAt,
      enabled: true,
      expiresAt: null,
      name: null,
      start: 'onto',
    });
  }),
);

it.effect('decodes only safe current-session identity fields', () =>
  Effect.gen(function* testProgram7() {
    const session = yield* Schema.decodeUnknownEffect(CurrentSessionSchema)({
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
    });
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
  }),
);
