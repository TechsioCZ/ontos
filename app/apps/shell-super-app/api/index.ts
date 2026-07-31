import {
  Cookies,
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpEffect,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { CoreDatabaseLive, DatabaseConfigLive, PrincipalResolverLive } from '@app/core-runtime';
import { ShellAuthenticationApi } from '../shared/api.ts';
import type { AuthenticationProblem } from '../shared/api.ts';
import { AuthConfigLive } from './auth/config.ts';
import { AuthDatabaseLive } from './auth/db/client.ts';
import type { AuthenticationRuntimeError } from './auth/errors.ts';
import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';

const requestHeaders = (headers: Readonly<Record<string, string | undefined>>): Headers => {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result.append(name, value);
    }
  }

  return result;
};

const forwardSetCookieHeaders = (headers: readonly string[]) =>
  headers.length === 0
    ? Effect.void
    : HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          response.pipe(HttpServerResponse.mergeCookies(Cookies.fromSetCookie(headers))),
        ),
      );

const problem = (error: AuthenticationRuntimeError): AuthenticationProblem => {
  switch (error._tag) {
    case 'InvalidCredentialsError': {
      return {
        _tag: 'InvalidCredentialsProblem',
        detail: 'The email address or password is invalid.',
        status: 401,
        title: 'Invalid credentials',
        type: 'https://ontos.dev/problems/invalid-credentials',
      };
    }
    case 'OntosIdentityForbiddenError': {
      return {
        _tag: 'OntosIdentityForbiddenProblem',
        detail: 'This account is not permitted to access OntOS.',
        status: 403,
        title: 'OntOS identity forbidden',
        type: 'https://ontos.dev/problems/identity-forbidden',
      };
    }
    case 'AuthenticationUnavailableError': {
      return {
        _tag: 'AuthenticationUnavailableProblem',
        detail: 'Authentication is temporarily unavailable. Please retry.',
        status: 503,
        title: 'Authentication unavailable',
        type: 'https://ontos.dev/problems/authentication-unavailable',
      };
    }
    case 'AuthenticationInternalError': {
      return {
        _tag: 'AuthenticationInternalProblem',
        detail: 'Authentication could not complete.',
        status: 500,
        title: 'Authentication failed',
        type: 'https://ontos.dev/problems/authentication-internal',
      };
    }
    default: {
      return {
        _tag: 'AuthenticationInternalProblem',
        detail: 'Authentication could not complete.',
        status: 500,
        title: 'Authentication failed',
        type: 'https://ontos.dev/problems/authentication-internal',
      };
    }
  }
};

const authenticationGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'authentication',
  (handlers) =>
    handlers
      .handle('signIn', ({ payload, request }) =>
        Effect.gen(function* signInHandler() {
          const authentication = yield* AuthenticationService;
          const result = yield* authentication.signIn(
            payload.email,
            payload.password,
            requestHeaders(request.headers),
          );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return {
            identity: result.identity,
          };
        }).pipe(Effect.mapError(problem)),
      )
      .handle('currentSession', ({ request }) =>
        Effect.gen(function* currentSessionHandler() {
          const authentication = yield* AuthenticationService;
          const result = yield* authentication.currentSession(requestHeaders(request.headers));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return result.identity === null
            ? ({ state: 'anonymous' } as const)
            : ({
                identity: result.identity,
                state: 'authenticated',
              } as const);
        }).pipe(Effect.mapError(problem)),
      )
      .handle('signOut', ({ request }) =>
        Effect.gen(function* signOutHandler() {
          const authentication = yield* AuthenticationService;
          const result = yield* authentication.signOut(requestHeaders(request.headers));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return {
            signedOut: true as const,
          };
        }).pipe(Effect.mapError(problem)),
      ),
);

const coreDatabaseLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
const principalResolverLive = PrincipalResolverLive.pipe(Layer.provide(coreDatabaseLive));
const authDatabaseLive = AuthDatabaseLive.pipe(Layer.provide(AuthConfigLive));
const authenticationDependenciesLive = Layer.mergeAll(
  AuthConfigLive,
  authDatabaseLive,
  principalResolverLive,
);
const authenticationServiceLive = AuthenticationServiceLive.pipe(
  Layer.provide(authenticationDependenciesLive),
  Layer.orDie,
);

const layer = HttpApiBuilder.layer(ShellAuthenticationApi).pipe(
  Layer.provide(authenticationGroupLive),
  Layer.provide(authenticationServiceLive),
) satisfies EffectRuntimeLayer;

const apiRuntime: EffectBffDefinition<typeof ShellAuthenticationApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof ShellAuthenticationApi, EffectRuntimeLayer> = defineEffectBff({
  api: ShellAuthenticationApi,
  layer,
});

export default apiRuntime;
