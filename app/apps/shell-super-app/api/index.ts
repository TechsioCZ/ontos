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
import {
  CoreDatabaseLive,
  DatabaseConfigLive,
  OutboxRuntimeLive,
  PrincipalResolverLive,
  TenantModuleStateService,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { InstalledModuleCatalog } from '@app/core-runtime';
import type { GatewayContextProblem } from '@app/shared-contracts';
import { Cause, pipe } from 'effect';
import { ShellAuthenticationApi } from '../shared/api.ts';
import type {
  ActiveModulesProblem,
  AuthenticationInternalProblem,
  AuthenticationProblem,
  AvailableTenantsProblem,
  SwitchTenantProblem,
  TenantAccessForbiddenProblem,
  TenantAuthenticationRequiredProblem,
  TenantCapabilityUnavailableProblem,
  TenantInternalProblem,
} from '../shared/api.ts';
import { AuthConfigLive } from './auth/config.ts';
import { AuthDatabaseLive } from './auth/db/client.ts';
import {
  gatewayIssuerLiveDependencies,
  issueGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import type { GatewayIssuerDependencies, GatewayIssuerError } from './auth/gateway-issuer.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './auth/errors.ts';
import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';
import {
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from './modules/installed-module-catalog.ts';
import type { InstalledModuleCatalogError } from './modules/installed-module-catalog.ts';
import { makeInstalledOutboxMatcherLayer } from './modules/installed-outbox-matcher.ts';

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

const failActiveModulesProblem = (modulesProblem: ActiveModulesProblem) =>
  (modulesProblem._tag === 'ActiveModulesAuthenticationRequiredProblem'
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(modulesProblem)));

const activeModulesAuthenticationRequiredProblem = (): ActiveModulesProblem => ({
  _tag: 'ActiveModulesAuthenticationRequiredProblem',
  detail: 'A valid Shell session is required.',
  status: 401,
  title: 'Module list authentication required',
  type: 'https://ontos.dev/problems/module-list-authentication-required',
});

const activeModulesUnavailableProblem = (): ActiveModulesProblem => ({
  _tag: 'ActiveModulesUnavailableProblem',
  detail: 'Active MicroVerticals are temporarily unavailable. Please retry.',
  retryable: true,
  status: 503,
  title: 'Active MicroVerticals unavailable',
  type: 'https://ontos.dev/problems/active-modules-unavailable',
});

const activeModulesInternalProblem = (): ActiveModulesProblem => ({
  _tag: 'ActiveModulesInternalProblem',
  detail: 'The active MicroVertical list could not be loaded.',
  status: 500,
  title: 'Active MicroVertical list failed',
  type: 'https://ontos.dev/problems/active-modules-internal',
});

const activeModulesAuthenticationProblem = (
  error: AuthenticationRuntimeError,
): ActiveModulesProblem => {
  switch (error._tag) {
    case 'InvalidCredentialsError':
    case 'OntosIdentityForbiddenError': {
      return activeModulesAuthenticationRequiredProblem();
    }
    case 'AuthenticationUnavailableError': {
      return activeModulesUnavailableProblem();
    }
    case 'AuthenticationInternalError': {
      return activeModulesInternalProblem();
    }
    default: {
      return error;
    }
  }
};

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

const authenticationInternalProblem = (): AuthenticationInternalProblem => ({
  _tag: 'AuthenticationInternalProblem',
  detail: 'Authentication could not complete.',
  status: 500,
  title: 'Authentication failed',
  type: 'https://ontos.dev/problems/authentication-internal',
});

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
      return authenticationInternalProblem();
    }
    default: {
      return authenticationInternalProblem();
    }
  }
};

const tenantAuthenticationRequiredProblem = (): TenantAuthenticationRequiredProblem => ({
  _tag: 'TenantAuthenticationRequiredProblem',
  detail: 'A valid Shell session is required.',
  status: 401,
  title: 'Tenant session authentication required',
  type: 'https://ontos.dev/problems/tenant-authentication-required',
});

const tenantAccessForbiddenProblem = (): TenantAccessForbiddenProblem => ({
  _tag: 'TenantAccessForbiddenProblem',
  detail: 'The requested tenant is not available to this session.',
  status: 403,
  title: 'Tenant access forbidden',
  type: 'https://ontos.dev/problems/tenant-access-forbidden',
});

const tenantCapabilityUnavailableProblem = (): TenantCapabilityUnavailableProblem => ({
  _tag: 'TenantCapabilityUnavailableProblem',
  detail: 'Tenant context is temporarily unavailable. Please retry.',
  retryable: true,
  status: 503,
  title: 'Tenant context unavailable',
  type: 'https://ontos.dev/problems/tenant-capability-unavailable',
});

const tenantInternalProblem = (): TenantInternalProblem => ({
  _tag: 'TenantInternalProblem',
  detail: 'Tenant context could not be loaded or changed.',
  status: 500,
  title: 'Tenant context failed',
  type: 'https://ontos.dev/problems/tenant-internal',
});

const tenantAuthenticationProblem = (
  error: AuthenticationRuntimeError,
): AvailableTenantsProblem => {
  switch (error._tag) {
    case 'InvalidCredentialsError':
    case 'OntosIdentityForbiddenError': {
      return tenantAuthenticationRequiredProblem();
    }
    case 'AuthenticationUnavailableError': {
      return tenantCapabilityUnavailableProblem();
    }
    case 'AuthenticationInternalError': {
      return tenantInternalProblem();
    }
    default: {
      return error;
    }
  }
};

const tenantProblem = (error: SwitchTenantRuntimeError): SwitchTenantProblem =>
  error._tag === 'TenantAccessForbiddenError'
    ? tenantAccessForbiddenProblem()
    : tenantAuthenticationProblem(error);

const failTenantProblem = <Failure extends SwitchTenantProblem>(tenantFailure: Failure) =>
  (tenantFailure._tag === 'TenantAuthenticationRequiredProblem'
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(tenantFailure)));

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
        }).pipe(
          Effect.mapError(problem),
          Effect.catchCause((cause) =>
            Cause.hasDies(cause)
              ? Effect.annotateLogs(
                  Effect.logError('Unexpected Shell current-session defect', cause),
                  {
                    correlationId: request.headers['x-correlation-id'] ?? 'missing',
                  },
                ).pipe(Effect.andThen(Effect.fail(authenticationInternalProblem())))
              : Effect.failCause(cause),
          ),
        ),
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

const tenantGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'tenants', (handlers) =>
  handlers
    .handle('availableTenants', ({ request }) =>
      Effect.gen(function* availableTenantsHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .availableTenants(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => failTenantProblem(tenantAuthenticationProblem(error))));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return { tenants: result.tenants };
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(Effect.logError('Unexpected tenant list defect', cause), {
                correlationId: request.headers['x-correlation-id'] ?? 'missing',
              }).pipe(Effect.andThen(failTenantProblem(tenantInternalProblem())))
            : Effect.failCause(cause),
        ),
      ),
    )
    .handle('switchTenant', ({ payload, request }) =>
      Effect.gen(function* switchTenantHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .switchTenant(payload.tenantId, requestHeaders(request.headers))
          .pipe(Effect.catch((error) => failTenantProblem(tenantProblem(error))));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return { selectedTenantId: result.selectedTenantId };
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(Effect.logError('Unexpected tenant switch defect', cause), {
                correlationId: request.headers['x-correlation-id'] ?? 'missing',
              }).pipe(Effect.andThen(failTenantProblem(tenantInternalProblem())))
            : Effect.failCause(cause),
        ),
      ),
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

const makeModulesGroupLive = () =>
  HttpApiBuilder.group(ShellAuthenticationApi, 'modules', (handlers) =>
    handlers.handle('activeModules', ({ request }) =>
      Effect.gen(function* activeModulesHandler() {
        const authentication = yield* AuthenticationService;
        const sessionResult = yield* authentication
          .currentSession(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) =>
              pipe(error, activeModulesAuthenticationProblem, failActiveModulesProblem),
            ),
          );
        yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
        if (sessionResult.identity === null) {
          return yield* failActiveModulesProblem(activeModulesAuthenticationRequiredProblem());
        }

        const moduleState = yield* TenantModuleStateService;
        const activeModules = yield* moduleState
          .listActiveTenantModules(sessionResult.identity.tenantId)
          .pipe(Effect.catch(() => failActiveModulesProblem(activeModulesUnavailableProblem())));
        const catalogService = yield* ShellInstalledModuleCatalog;
        const installed = yield* catalogService.load.pipe(
          Effect.catch((error) =>
            failActiveModulesProblem(
              error._tag === 'InstalledModuleCatalogUnavailableError'
                ? activeModulesUnavailableProblem()
                : activeModulesInternalProblem(),
            ),
          ),
        );
        const installedModuleIds = new Set(installed.moduleIds);

        return activeModules
          .filter((module) => installedModuleIds.has(module.moduleKey))
          .toSorted((left, right) => left.moduleKey.localeCompare(right.moduleKey));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(
                Effect.logError('Unexpected active MicroVertical list defect', cause),
                {
                  correlationId: request.headers['x-correlation-id'] ?? 'missing',
                },
              ).pipe(Effect.andThen(failActiveModulesProblem(activeModulesInternalProblem())))
            : Effect.failCause(cause),
        ),
      ),
    ),
  );

const coreDatabaseLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
const principalResolverLive = PrincipalResolverLive.pipe(Layer.provide(coreDatabaseLive));
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(coreDatabaseLive),
  Layer.orDie,
);
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
  moduleStateLayer: Layer.Layer<TenantModuleStateService> = tenantModuleStateServiceLive,
  loadInstalledModuleCatalog:
    | Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError>
    | undefined = undefined,
  enableInstalledOutboxMatcher = false,
): EffectBffDefinition<typeof ShellAuthenticationApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof ShellAuthenticationApi, EffectRuntimeLayer> => {
  const moduleCatalogLayer =
    loadInstalledModuleCatalog === undefined
      ? ShellInstalledModuleCatalogLive
      : Layer.succeed(ShellInstalledModuleCatalog, { load: loadInstalledModuleCatalog });
  const outboxMatcherLayer = enableInstalledOutboxMatcher
    ? makeInstalledOutboxMatcherLayer().pipe(
        Layer.provide(OutboxRuntimeLive.pipe(Layer.provide(coreDatabaseLive), Layer.orDie)),
      )
    : Layer.empty;
  const layer = HttpApiBuilder.layer(ShellAuthenticationApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        authenticationGroupLive,
        tenantGroupLive,
        makeGatewayContextGroupLive(issuerDependencies),
        makeModulesGroupLive(),
        outboxMatcherLayer,
      ),
    ),
    Layer.provide(Layer.mergeAll(authenticationLayer, moduleStateLayer, moduleCatalogLayer)),
  ) satisfies EffectRuntimeLayer;

  return defineEffectBff({
    api: ShellAuthenticationApi,
    layer,
  });
};

const apiRuntime = makeShellAuthenticationApiRuntime(
  authenticationServiceLive,
  gatewayIssuerLiveDependencies,
  tenantModuleStateServiceLive,
  undefined,
  true,
);

export default apiRuntime;
