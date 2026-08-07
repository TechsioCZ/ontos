import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  CurrentSessionSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  SignInPayloadSchema,
  ShellAuthenticationApi,
  SwitchTenantPayloadSchema,
  SwitchTenantResponseSchema,
  SwitchLegalEntityPayloadSchema,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';

type TenantEndpoint =
  | typeof ShellAuthenticationApi.groups.tenants.endpoints.availableTenants
  | typeof ShellAuthenticationApi.groups.tenants.endpoints.switchTenant;

const statuses = (endpoint: TenantEndpoint) =>
  [...endpoint.error]
    .map((schema) => schema.ast.annotations?.['httpApiStatus'])
    .toSorted((left, right) => Number(left) - Number(right));

test('publishes the existing authentication operations and one generic gateway operation', () => {
  const authenticationEndpoints = Object.keys(
    ShellAuthenticationApi.groups.authentication.endpoints,
  ).toSorted();
  const gatewayEndpoints = Object.keys(ShellAuthenticationApi.groups.gatewayContext.endpoints);
  const legalEntityEndpoints = Object.keys(
    ShellAuthenticationApi.groups.legalEntities.endpoints,
  ).toSorted();
  const tenantEndpoints = Object.keys(ShellAuthenticationApi.groups.tenants.endpoints).toSorted();
  const resourceEndpoints = Object.keys(
    ShellAuthenticationApi.groups.resources.endpoints,
  ).toSorted();

  expect(authenticationEndpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(gatewayEndpoints).toEqual(['issueGatewayContext']);
  expect(legalEntityEndpoints).toEqual(['availableLegalEntities', 'switchLegalEntity']);
  expect(tenantEndpoints).toEqual(['availableTenants', 'switchTenant']);
  expect(resourceEndpoints).toEqual(['attachMedia', 'resourceDetail', 'search']);
  expect(shellAuthenticationApiContract).toEqual({
    apiPrefix: '/shell-super-app-api',
    availableLegalEntitiesPath: '/shell-super-app-api/auth/legal-entities',
    availableTenantsPath: '/shell-super-app-api/auth/tenants',
    compositionPath: '/shell-super-app-api/shell/composition',
    currentSessionPath: '/shell-super-app-api/auth/session',
    issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
    mediaAttachmentPath: '/shell-super-app-api/shell/resource/media-attachment',
    ownerId: 'shell-super-app',
    resolveModuleTargetPath: '/shell-super-app-api/shell/module-target',
    resourceDetailPath: '/shell-super-app-api/shell/resource',
    searchPath: '/shell-super-app-api/shell/search',
    signInPath: '/shell-super-app-api/auth/sign-in',
    signOutPath: '/shell-super-app-api/auth/sign-out',
    switchLegalEntityPath: '/shell-super-app-api/auth/legal-entity/switch',
    switchTenantPath: '/shell-super-app-api/auth/tenant/switch',
  });
  expect([...authenticationEndpoints, ...gatewayEndpoints].join(':')).not.toMatch(
    /testing|actionKey/u,
  );
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
