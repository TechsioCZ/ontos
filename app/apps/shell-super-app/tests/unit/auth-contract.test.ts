import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  CurrentSessionSchema,
  SignInPayloadSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';

test('publishes only the three Shell authentication operations', () => {
  const endpoints = Object.keys(ShellAuthenticationApi.groups.authentication.endpoints).toSorted();

  expect(endpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(shellAuthenticationApiContract).toEqual({
    apiPrefix: '/shell-super-app-api',
    currentSessionPath: '/shell-super-app-api/auth/session',
    ownerId: 'shell-super-app',
    signInPath: '/shell-super-app-api/auth/sign-in',
    signOutPath: '/shell-super-app-api/auth/sign-out',
  });
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
