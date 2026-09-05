import { expect, rstest, test } from '@rstest/core';
import * as actualBetterAuth from 'better-auth' with { rstest: 'importActual' };
import { makeAuthenticationService } from '../../api/auth/service.ts';
import {
  PrincipalBindingMissingError,
  PrincipalResolverUnavailableError,
} from '../../../../packages/core-runtime/src/auth/principal-resolver-errors.ts';
import { Cause, Context, Effect, Exit } from 'effect';
import type { AuthDatabaseExecutor } from '../../api/auth/db/types.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

// Exercise the Promise hook with real APIError semantics, without provider or database startup.
rstest.mock('better-auth', () => ({
  APIError: actualBetterAuth.APIError,
  betterAuth: (options: {
    databaseHooks: {
      session: {
        create: {
          before: (session: { userId: string }, context: { context: object }) => Promise<unknown>;
        };
      };
    };
  }) => ({
    api: {
      signInEmail: async (input: Record<string, unknown>) => {
        // Better Auth 1.7.2 toAuthEndpoints spreads input, then replaces `context`.
        // dispatchAuthEndpoint preserves those top-level fields for database hooks.
        const forwarded = { ...input, context: { options: {} } };
        await options.databaseHooks.session.create.before({ userId: 'user' }, forwarded);
        return {
          headers: new Headers(),
          response: { user: { id: 'user', email: 'user@example.test' } },
        };
      },
    },
  }),
}));

const configuration = {
  baseUrl: 'http://localhost:3020',
  connectionString: 'unused',
  secret: 'test-only-secret-not-used-by-provider-mock',
  secureCookies: false,
  supportUserIds: [],
  trustedOrigins: [],
};
const identity = {
  authBindingId: 'binding',
  displayName: 'User',
  principalId: 'principal',
  principalKind: 'human' as const,
  tenantId: 'tenant',
};
const signIn = (
  resolve: ReturnType<typeof makePrincipalResolverDouble>['resolveDefaultBetterAuthUser'],
) =>
  makeAuthenticationService(
    configuration,
    {} as AuthDatabaseExecutor,
    makePrincipalResolverDouble({ resolveDefaultBetterAuthUser: resolve }),
  ).signIn('user@example.test', 'password', new Headers());

test('session hook distinguishes typed denial, unavailable, and defects before Promise rejection', async () => {
  for (const [resolverEffect, tag] of [
    [Effect.fail(new PrincipalBindingMissingError()), 'OntosIdentityForbiddenError'],
    [
      Effect.fail(new PrincipalResolverUnavailableError({ reason: 'offline' })),
      'AuthenticationUnavailableError',
    ],
    [Effect.die(new Error('broken resolver')), 'AuthenticationInternalError'],
    // A defect carrying a domain-looking value must not be treated as a typed denial/unavailability.
    [
      Effect.die(new PrincipalResolverUnavailableError({ reason: 'defect' })),
      'AuthenticationInternalError',
    ],
  ] as const) {
    const error = await Effect.runPromise(signIn(() => resolverEffect).pipe(Effect.flip));
    expect(error._tag).toBe(tag);
  }
  const error = await Effect.runPromise(
    signIn(() => {
      throw new Error('synchronous defect');
    }).pipe(Effect.flip),
  );
  expect(error._tag).toBe('AuthenticationInternalError');
});

class CallerMarker extends Context.Service<CallerMarker, string>()('test/CallerMarker') {}

test('session hook retains each concurrent caller context', async () => {
  const seen: string[] = [];
  const operation = signIn(() =>
    Effect.context<never>().pipe(
      Effect.map((context) => {
        seen.push(Context.get(context as Context.Context<CallerMarker>, CallerMarker));
        return identity;
      }),
    ),
  );
  await Promise.all(
    ['first', 'second'].map((marker) =>
      Effect.runPromise(operation.pipe(Effect.provideService(CallerMarker, marker))),
    ),
  );
  // Once in the foreign hook, once in the public sign-in identity resolution, per caller.
  expect(seen.filter((value) => value === 'first')).toHaveLength(2);
  expect(seen.filter((value) => value === 'second')).toHaveLength(2);
});

test('adapter forwarding retains caller service and abort signal despite replacing context', async () => {
  const seen: string[] = [];
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let interrupted!: () => void;
  const stopped = new Promise<void>((resolve) => {
    interrupted = resolve;
  });
  const result = Effect.runPromiseExit(
    signIn(() =>
      Effect.context<never>().pipe(
        Effect.tap((context) =>
          Effect.sync(() => {
            seen.push(Context.get(context as Context.Context<CallerMarker>, CallerMarker));
            started();
          }),
        ),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(interrupted)),
      ),
    ).pipe(Effect.provideService(CallerMarker, 'forwarded')),
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  const exit = await result;
  await stopped;
  expect(seen).toEqual(['forwarded']);
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});
