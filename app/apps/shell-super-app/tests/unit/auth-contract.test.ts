import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  CurrentSessionSchema,
  ActiveModulesSchema,
  SignInPayloadSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';

test('publishes the existing authentication operations and one generic gateway operation', () => {
  const authenticationEndpoints = Object.keys(
    ShellAuthenticationApi.groups.authentication.endpoints,
  ).toSorted();
  const gatewayEndpoints = Object.keys(ShellAuthenticationApi.groups.gatewayContext.endpoints);
  const moduleEndpoints = Object.keys(ShellAuthenticationApi.groups.modules.endpoints);

  expect(authenticationEndpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(gatewayEndpoints).toEqual(['issueGatewayContext']);
  expect(moduleEndpoints).toEqual(['activeModules']);
  expect(shellAuthenticationApiContract).toEqual({
    activeModulesPath: '/shell-super-app-api/modules/active',
    apiPrefix: '/shell-super-app-api',
    currentSessionPath: '/shell-super-app-api/auth/session',
    issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
    ownerId: 'shell-super-app',
    signInPath: '/shell-super-app-api/auth/sign-in',
    signOutPath: '/shell-super-app-api/auth/sign-out',
  });
  expect(
    [...authenticationEndpoints, ...gatewayEndpoints, ...moduleEndpoints].join(':'),
  ).not.toMatch(/testing|actionKey/u);
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
