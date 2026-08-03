import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  CurrentSessionSchema,
  SignInPayloadSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';

test('publishes the existing authentication operations and one generic gateway operation', () => {
  const authenticationEndpoints = Object.keys(
    ShellAuthenticationApi.groups.authentication.endpoints,
  ).toSorted();
  const gatewayEndpoints = Object.keys(ShellAuthenticationApi.groups.gatewayContext.endpoints);

  expect(authenticationEndpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(gatewayEndpoints).toEqual(['issueGatewayContext']);
  expect(shellAuthenticationApiContract).toEqual({
    apiPrefix: '/shell-super-app-api',
    currentSessionPath: '/shell-super-app-api/auth/session',
    issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
    ownerId: 'shell-super-app',
    signInPath: '/shell-super-app-api/auth/sign-in',
    signOutPath: '/shell-super-app-api/auth/sign-out',
  });
  expect([...authenticationEndpoints, ...gatewayEndpoints].join(':')).not.toMatch(
    /testing|actionKey/u,
  );
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
