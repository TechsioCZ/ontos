import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  CurrentSessionSchema,
  ActiveModulesSchema,
  AvailableTenantsResponseSchema,
  SignInPayloadSchema,
  ShellAuthenticationApi,
  SwitchTenantPayloadSchema,
  SwitchTenantResponseSchema,
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
  const moduleEndpoints = Object.keys(ShellAuthenticationApi.groups.modules.endpoints);
  const tenantEndpoints = Object.keys(ShellAuthenticationApi.groups.tenants.endpoints).toSorted();

  expect(authenticationEndpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(gatewayEndpoints).toEqual(['issueGatewayContext']);
  expect(moduleEndpoints).toEqual(['activeModules']);
  expect(tenantEndpoints).toEqual(['availableTenants', 'switchTenant']);
  expect(shellAuthenticationApiContract).toEqual({
    activeModulesPath: '/shell-super-app-api/modules/active',
    apiPrefix: '/shell-super-app-api',
    availableTenantsPath: '/shell-super-app-api/auth/tenants',
    currentSessionPath: '/shell-super-app-api/auth/session',
    issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
    ownerId: 'shell-super-app',
    signInPath: '/shell-super-app-api/auth/sign-in',
    signOutPath: '/shell-super-app-api/auth/sign-out',
    switchTenantPath: '/shell-super-app-api/auth/tenant/switch',
  });
  expect(
    [...authenticationEndpoints, ...gatewayEndpoints, ...moduleEndpoints].join(':'),
  ).not.toMatch(/testing|actionKey/u);
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

test('decodes only ordered active-module response fields and accepts no request tenant', async () => {
  const modules = await Effect.runPromise(
    Schema.decodeUnknownEffect(ActiveModulesSchema)([
      { moduleKey: 'future-generated', state: 'active', tenantId: 'must-not-pass' },
      { moduleKey: 'testing1', principalId: 'must-not-pass', state: 'active' },
    ]),
  );
  expect(modules).toEqual([
    { moduleKey: 'future-generated', state: 'active' },
    { moduleKey: 'testing1', state: 'active' },
  ]);
  expect(
    ShellAuthenticationApi.groups.modules.endpoints.activeModules.payloadSchema,
  ).toBeUndefined();
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
      principalId: 'principal-id',
      tenantId: 'tenant-id',
    },
    state: 'authenticated',
  });
});
