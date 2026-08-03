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
import type { GatewayContextProblem } from '@app/shared-contracts';
import { Cause, pipe } from 'effect';
import { ShellAuthenticationApi } from '../shared/api.ts';
import type { AuthenticationProblem } from '../shared/api.ts';
import { AuthConfigLive } from './auth/config.ts';
import { AuthDatabaseLive } from './auth/db/client.ts';
import {
  gatewayIssuerLiveDependencies,
  issueGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import type { GatewayIssuerDependencies, GatewayIssuerError } from './auth/gateway-issuer.ts';
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

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeader(
      response,
      'www-authenticate',
      'Bearer realm="ontos-gateway", error="invalid_token"',
    ),
  ),
);

const failGatewayProblem = (gatewayProblem: GatewayContextProblem) =>
  (gatewayProblem._tag === 'GatewayAuthenticationRequiredProblem'
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(gatewayProblem)));

const gatewayAuthenticationRequiredProblem = (): GatewayContextProblem => ({
  _tag: 'GatewayAuthenticationRequiredProblem',
  detail: 'A valid Shell session is required.',
  status: 401,
  title: 'Gateway authentication required',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
});

const gatewayInternalProblem = (): GatewayContextProblem => ({
  _tag: 'GatewayInternalProblem',
  detail: 'Gateway authentication could not complete.',
  status: 500,
  title: 'Gateway authentication failed',
  type: 'https://ontos.dev/problems/gateway-internal',
});

const gatewayAuthenticationProblem = (error: AuthenticationRuntimeError): GatewayContextProblem => {
  switch (error._tag) {
    case 'InvalidCredentialsError':
    case 'OntosIdentityForbiddenError': {
      return gatewayAuthenticationRequiredProblem();
    }
    case 'AuthenticationUnavailableError': {
      return {
        _tag: 'GatewayUnavailableProblem',
        detail: 'Gateway authentication is temporarily unavailable. Please retry.',
        retryable: true,
        status: 503,
        title: 'Gateway unavailable',
        type: 'https://ontos.dev/problems/gateway-unavailable',
      };
    }
    default: {
      return gatewayInternalProblem();
    }
  }
};

const gatewayIssuerProblem = (error: GatewayIssuerError): GatewayContextProblem =>
  error.code === 'gateway_audience_invalid'
    ? {
        _tag: 'GatewayAudienceInvalidProblem',
        detail: 'The requested audience is not an available MicroVertical.',
        status: 400,
        title: 'Invalid gateway audience',
        type: 'https://ontos.dev/problems/gateway-audience-invalid',
      }
    : {
        _tag: 'GatewayUnavailableProblem',
        detail: 'Gateway assertion issuance is temporarily unavailable. Please retry.',
        retryable: true,
        status: 503,
        title: 'Gateway unavailable',
        type: 'https://ontos.dev/problems/gateway-unavailable',
      };

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

const makeGatewayContextGroupLive = (issuerDependencies: GatewayIssuerDependencies) =>
  HttpApiBuilder.group(ShellAuthenticationApi, 'gatewayContext', (handlers) =>
    handlers.handle('issueGatewayContext', ({ payload, request }) =>
      Effect.gen(function* issueGatewayContextHandler() {
        const authentication = yield* AuthenticationService;
        const sessionResult = yield* authentication
          .currentSession(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) => pipe(error, gatewayAuthenticationProblem, failGatewayProblem)),
          );
        yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
        if (sessionResult.identity === null) {
          return yield* failGatewayProblem(gatewayAuthenticationRequiredProblem());
        }

        return yield* issueGatewayContextAssertion(
          {
            audience: payload.audience,
            principal: {
              authMethod: 'session',
              principalId: sessionResult.identity.principalId,
              tenantId: sessionResult.identity.tenantId,
            },
          },
          issuerDependencies,
        ).pipe(Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(
                Effect.logError('Unexpected Shell gateway assertion defect', cause),
                {
                  correlationId: request.headers['x-correlation-id'] ?? 'missing',
                },
              ).pipe(Effect.andThen(failGatewayProblem(gatewayInternalProblem())))
            : Effect.failCause(cause),
        ),
      ),
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

export const makeShellAuthenticationApiRuntime = (
  authenticationLayer: Layer.Layer<AuthenticationService>,
  issuerDependencies: GatewayIssuerDependencies,
): EffectBffDefinition<typeof ShellAuthenticationApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof ShellAuthenticationApi, EffectRuntimeLayer> => {
  const layer = HttpApiBuilder.layer(ShellAuthenticationApi).pipe(
    Layer.provide(
      Layer.merge(authenticationGroupLive, makeGatewayContextGroupLive(issuerDependencies)),
    ),
    Layer.provide(authenticationLayer),
  ) satisfies EffectRuntimeLayer;

  return defineEffectBff({
    api: ShellAuthenticationApi,
    layer,
  });
};

const apiRuntime = makeShellAuthenticationApiRuntime(
  authenticationServiceLive,
  gatewayIssuerLiveDependencies,
);

export default apiRuntime;
