/* eslint-disable no-nested-ternary -- Typed authentication errors map inline to the same closed Shell Problem Details union. */
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
  CorePersistenceLive,
  ContextAccessLive,
  LegalEntityContextLive,
  OutboxRuntimeLive,
  PrincipalResolverLive,
  TenantModuleStateServiceLive,
  makeTenantModuleStateService,
  makeReadRuntimeLive,
} from '@app/core-runtime';
import type {
  ContextAccess,
  InstalledModuleCatalog,
  ReadCoreError,
  TenantModuleStateService,
} from '@app/core-runtime';
import type { GatewayContextProblem } from '@app/shared-contracts';
import { Cause, pipe } from 'effect';
import { ShellAuthenticationApi } from '../shared/api.ts';
import type {
  AuthenticationInternalProblem,
  AuthenticationProblem,
  AvailableTenantsProblem,
  LegalEntityAccessForbiddenProblem,
  LegalEntityProblem,
  ShellAuthenticationRequiredProblem,
  ShellCapabilityUnavailableProblem,
  ShellInternalProblem,
  ShellPolicyConflictProblem,
  ShellPolicyUnprocessableProblem,
  ShellSelectionRequiredProblem,
  ShellTargetForbiddenProblem,
  ShellTargetNotFoundProblem,
  SwitchTenantProblem,
  TenantAccessForbiddenProblem,
  TenantAuthenticationRequiredProblem,
  TenantCapabilityUnavailableProblem,
  TenantInternalProblem,
} from '../shared/api.ts';
import { AuthPersistenceLive } from './auth/runtime-infrastructure.ts';
import {
  gatewayIssuerLiveDependencies,
  issueGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import type { GatewayIssuerDependencies, GatewayIssuerError } from './auth/gateway-issuer.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './auth/errors.ts';
import type { LegalEntitySelectionForbiddenError } from './auth/legal-entity-selection.ts';
import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';
import {
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from './modules/installed-module-catalog.ts';
import type { InstalledModuleCatalogError } from './modules/installed-module-catalog.ts';
import { makeInstalledOutboxMatcherLayer } from './modules/installed-outbox-matcher.ts';
import { ShellGovernedReads, makeShellGovernedReadsLive } from './modules/shell-governed-reads.ts';
import type { ShellScopedModuleStateFactory } from './modules/shell-governed-reads.ts';
import { attachShellMedia, ShellProviderUnavailableError } from './modules/shell-resources.ts';
import type { ShellResourceContext, ShellResourceGateways } from './modules/shell-resources.ts';

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

const legalEntityAccessForbiddenProblem = (): LegalEntityAccessForbiddenProblem => ({
  _tag: 'LegalEntityAccessForbiddenProblem',
  detail: 'The requested legal entity is not available to this session.',
  status: 403,
  title: 'Legal-entity access forbidden',
  type: 'https://ontos.dev/problems/legal-entity-access-forbidden',
});

const failLegalEntityProblem = <Failure extends LegalEntityProblem>(failure: Failure) =>
  (failure._tag === 'TenantAuthenticationRequiredProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(failure)),
  );

const shellAuthenticationRequiredProblem = (): ShellAuthenticationRequiredProblem => ({
  _tag: 'ShellAuthenticationRequiredProblem',
  detail: 'A valid Shell session is required.',
  status: 401,
  title: 'Shell authentication required',
  type: 'https://ontos.dev/problems/shell-authentication-required',
});

const shellCapabilityUnavailableProblem = (): ShellCapabilityUnavailableProblem => ({
  _tag: 'ShellCapabilityUnavailableProblem',
  detail: 'The Shell capability is temporarily unavailable. Please retry.',
  retryable: true,
  status: 503,
  title: 'Shell capability unavailable',
  type: 'https://ontos.dev/problems/shell-capability-unavailable',
});

const shellInternalProblem = (): ShellInternalProblem => ({
  _tag: 'ShellInternalProblem',
  detail: 'The Shell request could not be completed.',
  status: 500,
  title: 'Shell request failed',
  type: 'https://ontos.dev/problems/shell-internal',
});

const shellSelectionRequiredProblem = (): ShellSelectionRequiredProblem => ({
  _tag: 'ShellSelectionRequiredProblem',
  detail: 'Select one legal entity before opening a module.',
  status: 409,
  title: 'Legal-entity selection required',
  type: 'https://ontos.dev/problems/legal-entity-selection-required',
});

const shellTargetForbiddenProblem = (): ShellTargetForbiddenProblem => ({
  _tag: 'ShellTargetForbiddenProblem',
  detail: 'The requested module is forbidden in the selected context.',
  status: 403,
  title: 'Module target forbidden',
  type: 'https://ontos.dev/problems/module-target-forbidden',
});

const shellTargetNotFoundProblem = (): ShellTargetNotFoundProblem => ({
  _tag: 'ShellTargetNotFoundProblem',
  detail: 'The requested module target was not found.',
  status: 404,
  title: 'Module target not found',
  type: 'https://ontos.dev/problems/module-target-not-found',
});

const shellPolicyConflictProblem = (): ShellPolicyConflictProblem => ({
  _tag: 'ShellPolicyConflictProblem',
  detail: 'The requested operation conflicts with a business policy.',
  status: 409,
  title: 'Policy conflict',
  type: 'https://ontos.dev/problems/policy-conflict',
});

const shellPolicyUnprocessableProblem = (): ShellPolicyUnprocessableProblem => ({
  _tag: 'ShellPolicyUnprocessableProblem',
  detail: 'The requested operation violates a business policy.',
  status: 422,
  title: 'Policy violation',
  type: 'https://ontos.dev/problems/policy-violation',
});

const shellReadProblem = (
  error: ReadCoreError,
):
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem => {
  switch (error._tag) {
    case 'OperationAuthenticationRequired': {
      return shellAuthenticationRequiredProblem();
    }
    case 'OperationContextDenied':
    case 'ReadPermissionDenied': {
      return shellTargetForbiddenProblem();
    }
    case 'ReadPolicyDenied': {
      return error.httpStatus === 409
        ? shellPolicyConflictProblem()
        : shellPolicyUnprocessableProblem();
    }
    case 'ReadHandlerNotFound': {
      return shellTargetNotFoundProblem();
    }
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
    case 'ReadEvidencePersistenceError':
    case 'ReadHandlerUnavailable':
    case 'ReadPermissionUnavailable':
    case 'ReadPolicyEvaluationError': {
      return shellCapabilityUnavailableProblem();
    }
    default: {
      return shellInternalProblem();
    }
  }
};

const shellListReadProblem = (error: ReadCoreError) => {
  const mappedProblem = shellReadProblem(error);
  return mappedProblem._tag === 'ShellTargetNotFoundProblem'
    ? shellInternalProblem()
    : mappedProblem;
};

type ShellProblem =
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellSelectionRequiredProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem;

const failShellProblem = <Failure extends ShellProblem>(failure: Failure) =>
  (failure._tag === 'ShellAuthenticationRequiredProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(failure)),
  );

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
          const result = yield* authentication.resolveShellContext(requestHeaders(request.headers));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          switch (result.state) {
            case 'anonymous': {
              return { state: 'anonymous' } as const;
            }
            case 'authenticated': {
              return { identity: result.identity, state: 'authenticated' } as const;
            }
            case 'selection_required': {
              return {
                availableLegalEntities: result.availableLegalEntities,
                identity: result.identity,
                state: 'selection_required',
              } as const;
            }
            case 'access_blocked': {
              return { identity: result.identity, state: 'access_blocked' } as const;
            }
            default: {
              return result;
            }
          }
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

const legalEntityGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'legalEntities',
  (handlers) =>
    handlers
      .handle('availableLegalEntities', ({ request }) =>
        Effect.gen(function* availableLegalEntitiesHandler() {
          const authentication = yield* AuthenticationService;
          const result = yield* authentication
            .resolveShellContext(requestHeaders(request.headers))
            .pipe(
              Effect.catch((error) => failLegalEntityProblem(tenantAuthenticationProblem(error))),
            );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          if (result.state === 'anonymous') {
            return yield* failLegalEntityProblem(tenantAuthenticationRequiredProblem());
          }
          return {
            legalEntities: result.availableLegalEntities,
            ...(result.state === 'authenticated'
              ? { selectedLegalEntityId: result.identity.legalEntityId }
              : {}),
            state: result.state,
          };
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasDies(cause)
              ? Effect.annotateLogs(Effect.logError('Unexpected legal-entity list defect', cause), {
                  correlationId: request.headers['x-correlation-id'] ?? 'missing',
                }).pipe(Effect.andThen(failLegalEntityProblem(tenantInternalProblem())))
              : Effect.failCause(cause),
          ),
        ),
      )
      .handle('switchLegalEntity', ({ payload, request }) =>
        Effect.gen(function* switchLegalEntityHandler() {
          const authentication = yield* AuthenticationService;
          const result = yield* authentication
            .switchLegalEntity(payload.legalEntityId, requestHeaders(request.headers))
            .pipe(
              Effect.catch(
                (error: AuthenticationRuntimeError | LegalEntitySelectionForbiddenError) =>
                  failLegalEntityProblem(
                    error._tag === 'LegalEntitySelectionForbiddenError'
                      ? legalEntityAccessForbiddenProblem()
                      : tenantAuthenticationProblem(error),
                  ),
              ),
            );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return { selectedLegalEntityId: result.selectedLegalEntityId };
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasDies(cause)
              ? Effect.annotateLogs(
                  Effect.logError('Unexpected legal-entity switch defect', cause),
                  { correlationId: request.headers['x-correlation-id'] ?? 'missing' },
                ).pipe(Effect.andThen(failLegalEntityProblem(tenantInternalProblem())))
              : Effect.failCause(cause),
          ),
        ),
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

const compositionGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'composition',
  (handlers) =>
    handlers
      .handle('shellComposition', ({ request }) =>
        Effect.gen(function* shellCompositionHandler() {
          const authentication = yield* AuthenticationService;
          const session = yield* authentication
            .resolveShellContext(requestHeaders(request.headers))
            .pipe(
              Effect.catch((error) =>
                failShellProblem(
                  error._tag === 'AuthenticationInternalError'
                    ? shellInternalProblem()
                    : error._tag === 'AuthenticationUnavailableError'
                      ? shellCapabilityUnavailableProblem()
                      : shellAuthenticationRequiredProblem(),
                ),
              ),
            );
          yield* forwardSetCookieHeaders(session.setCookieHeaders);
          if (session.state === 'anonymous') {
            return yield* failShellProblem(shellAuthenticationRequiredProblem());
          }
          if (session.state === 'access_blocked') {
            return { navigation: [], state: 'access_blocked' } as const;
          }
          if (session.state !== 'authenticated') {
            return { navigation: [], state: 'selection_required' } as const;
          }
          const governedReads = yield* ShellGovernedReads;
          return yield* governedReads
            .composition({
              correlationId: request.headers['x-correlation-id'] ?? 'missing',
              principal: session.principal,
            })
            .pipe(Effect.catch((error) => failShellProblem(shellListReadProblem(error))));
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasDies(cause)
              ? Effect.annotateLogs(Effect.logError('Unexpected Shell composition defect', cause), {
                  correlationId: request.headers['x-correlation-id'] ?? 'missing',
                }).pipe(Effect.andThen(failShellProblem(shellInternalProblem())))
              : Effect.failCause(cause),
          ),
        ),
      )
      .handle('resolveModuleTarget', ({ payload, request }) =>
        Effect.gen(function* resolveModuleTargetHandler() {
          const authentication = yield* AuthenticationService;
          const session = yield* authentication
            .resolveShellContext(requestHeaders(request.headers))
            .pipe(
              Effect.catch((error) =>
                failShellProblem(
                  error._tag === 'AuthenticationInternalError'
                    ? shellInternalProblem()
                    : error._tag === 'AuthenticationUnavailableError'
                      ? shellCapabilityUnavailableProblem()
                      : shellAuthenticationRequiredProblem(),
                ),
              ),
            );
          yield* forwardSetCookieHeaders(session.setCookieHeaders);
          if (session.state === 'anonymous') {
            return yield* failShellProblem(shellAuthenticationRequiredProblem());
          }
          if (session.state !== 'authenticated') {
            return yield* failShellProblem(shellSelectionRequiredProblem());
          }
          const governedReads = yield* ShellGovernedReads;
          return yield* governedReads
            .moduleTarget({
              correlationId: request.headers['x-correlation-id'] ?? 'missing',
              moduleId: payload.moduleId,
              principal: session.principal,
            })
            .pipe(Effect.catch((error) => failShellProblem(shellReadProblem(error))));
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasDies(cause)
              ? Effect.annotateLogs(Effect.logError('Unexpected module target defect', cause), {
                  correlationId: request.headers['x-correlation-id'] ?? 'missing',
                }).pipe(Effect.andThen(failShellProblem(shellInternalProblem())))
              : Effect.failCause(cause),
          ),
        ),
      ),
);

export type { ShellResourceGateways } from './modules/shell-resources.ts';

const unavailableResourceGateways: ShellResourceGateways = {
  resource: {
    detail: () => Effect.fail(new ShellProviderUnavailableError()),
    timeline: () => Effect.fail(new ShellProviderUnavailableError()),
  },
  search: {
    search: () => Effect.fail(new ShellProviderUnavailableError()),
  },
};

const resourcesGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'resources', (handlers) =>
  handlers
    .handle('search', ({ payload, request }) =>
      Effect.gen(function* searchHandler() {
        const authentication = yield* AuthenticationService;
        const session = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) =>
              failShellProblem(
                error._tag === 'AuthenticationUnavailableError'
                  ? shellCapabilityUnavailableProblem()
                  : error._tag === 'AuthenticationInternalError'
                    ? shellInternalProblem()
                    : shellAuthenticationRequiredProblem(),
              ),
            ),
          );
        yield* forwardSetCookieHeaders(session.setCookieHeaders);
        if (session.state === 'anonymous') {
          return yield* failShellProblem(shellAuthenticationRequiredProblem());
        }
        if (session.state !== 'authenticated') {
          return yield* failShellProblem(shellSelectionRequiredProblem());
        }
        const governedReads = yield* ShellGovernedReads;
        return yield* governedReads
          .search({
            correlationId: request.headers['x-correlation-id'] ?? 'missing',
            principal: session.principal,
            query: payload.query,
          })
          .pipe(Effect.catch((error) => failShellProblem(shellListReadProblem(error))));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(Effect.logError('Unexpected Shell search defect', cause), {
                correlationId: request.headers['x-correlation-id'] ?? 'missing',
              }).pipe(Effect.andThen(failShellProblem(shellInternalProblem())))
            : Effect.failCause(cause),
        ),
      ),
    )
    .handle('resourceDetail', ({ payload, request }) =>
      Effect.gen(function* resourceDetailHandler() {
        const authentication = yield* AuthenticationService;
        const session = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) =>
              failShellProblem(
                error._tag === 'AuthenticationUnavailableError'
                  ? shellCapabilityUnavailableProblem()
                  : error._tag === 'AuthenticationInternalError'
                    ? shellInternalProblem()
                    : shellAuthenticationRequiredProblem(),
              ),
            ),
          );
        yield* forwardSetCookieHeaders(session.setCookieHeaders);
        if (session.state === 'anonymous') {
          return yield* failShellProblem(shellAuthenticationRequiredProblem());
        }
        if (session.state !== 'authenticated') {
          return yield* failShellProblem(shellSelectionRequiredProblem());
        }
        const governedReads = yield* ShellGovernedReads;
        return yield* governedReads
          .resourceDetail({
            correlationId: request.headers['x-correlation-id'] ?? 'missing',
            principal: session.principal,
            ref: payload,
          })
          .pipe(Effect.catch((error) => failShellProblem(shellReadProblem(error))));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(
                Effect.logError('Unexpected Shell resource-detail defect', cause),
                { correlationId: request.headers['x-correlation-id'] ?? 'missing' },
              ).pipe(Effect.andThen(failShellProblem(shellInternalProblem())))
            : Effect.failCause(cause),
        ),
      ),
    )
    .handle('attachMedia', ({ payload, request }) =>
      Effect.gen(function* attachMediaHandler() {
        const authentication = yield* AuthenticationService;
        const session = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) =>
              failShellProblem(
                error._tag === 'AuthenticationUnavailableError'
                  ? shellCapabilityUnavailableProblem()
                  : error._tag === 'AuthenticationInternalError'
                    ? shellInternalProblem()
                    : shellAuthenticationRequiredProblem(),
              ),
            ),
          );
        yield* forwardSetCookieHeaders(session.setCookieHeaders);
        if (session.state === 'anonymous') {
          return yield* failShellProblem(shellAuthenticationRequiredProblem());
        }
        if (session.state !== 'authenticated') {
          return yield* failShellProblem(shellSelectionRequiredProblem());
        }
        const resolution = yield* attachShellMedia(
          {
            ...session.principal,
            correlationId: request.headers['x-correlation-id'] ?? 'missing',
            legalEntityId: session.identity.legalEntityId,
          },
          payload,
        );
        switch (resolution.outcome) {
          case 'resolved': {
            return resolution.result;
          }
          case 'forbidden': {
            return yield* failShellProblem(shellTargetForbiddenProblem());
          }
          case 'not_found': {
            return yield* failShellProblem(shellTargetNotFoundProblem());
          }
          case 'unavailable': {
            return yield* failShellProblem(shellCapabilityUnavailableProblem());
          }
          default: {
            return resolution;
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.annotateLogs(
                Effect.logError('Unexpected Shell media-attachment defect', cause),
                { correlationId: request.headers['x-correlation-id'] ?? 'missing' },
              ).pipe(Effect.andThen(failShellProblem(shellInternalProblem())))
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
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) => pipe(error, gatewayAuthenticationProblem, failGatewayProblem)),
          );
        yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
        if (sessionResult.state !== 'authenticated') {
          return yield* failGatewayProblem(gatewayAuthenticationRequiredProblem());
        }

        return yield* issueGatewayContextAssertion(
          {
            audience: payload.audience,
            principal: sessionResult.principal,
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

const principalResolverLive = PrincipalResolverLive.pipe(Layer.provide(CorePersistenceLive));
const legalEntityContextLive = LegalEntityContextLive.pipe(Layer.provide(CorePersistenceLive));
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const authenticationDependenciesLive = Layer.mergeAll(
  AuthPersistenceLive,
  ContextAccessLive,
  legalEntityContextLive,
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
  contextAccessLayer: Layer.Layer<ContextAccess> = ContextAccessLive,
  resourceGateways: ShellResourceGateways = unavailableResourceGateways,
  scopedModuleStateFactory: ShellScopedModuleStateFactory = (transaction) =>
    makeTenantModuleStateService({ executor: transaction }),
): EffectBffDefinition<typeof ShellAuthenticationApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof ShellAuthenticationApi, EffectRuntimeLayer> => {
  const moduleCatalogLayer =
    loadInstalledModuleCatalog === undefined
      ? ShellInstalledModuleCatalogLive
      : Layer.succeed(ShellInstalledModuleCatalog, { load: loadInstalledModuleCatalog });
  const readRuntimeLayer = makeReadRuntimeLive(contextAccessLayer).pipe(
    Layer.provide(CorePersistenceLive),
    Layer.orDie,
  );
  const providerAssertionIssuer = {
    issueAssertion: ({
      appId,
      context,
    }: {
      readonly appId: string;
      readonly context: ShellResourceContext;
    }) =>
      issueGatewayContextAssertion(
        {
          audience: appId,
          principal: {
            authMethod: context.authMethod,
            legalEntityId: context.legalEntityId,
            principalId: context.principalId,
            tenantId: context.tenantId,
            ...(context.authBindingId === undefined
              ? {}
              : { authBindingId: context.authBindingId }),
            ...(context.authContextRef === undefined
              ? {}
              : { authContextRef: context.authContextRef }),
            ...(context.impersonatedByPrincipalId === undefined
              ? {}
              : { impersonatedByPrincipalId: context.impersonatedByPrincipalId }),
          },
        },
        issuerDependencies,
      ).pipe(
        Effect.map(({ token }) => `Bearer ${token}`),
        Effect.mapError(() => new ShellProviderUnavailableError()),
      ),
  };
  const shellGovernedReadsLayer = makeShellGovernedReadsLive(
    resourceGateways,
    providerAssertionIssuer,
    scopedModuleStateFactory,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(readRuntimeLayer, moduleStateLayer, moduleCatalogLayer, contextAccessLayer),
    ),
  );
  const outboxMatcherLayer = enableInstalledOutboxMatcher
    ? makeInstalledOutboxMatcherLayer().pipe(
        Layer.provide(OutboxRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie)),
      )
    : Layer.empty;
  const layer = HttpApiBuilder.layer(ShellAuthenticationApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        authenticationGroupLive,
        tenantGroupLive,
        legalEntityGroupLive,
        compositionGroupLive,
        resourcesGroupLive,
        makeGatewayContextGroupLive(issuerDependencies),
        outboxMatcherLayer,
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        authenticationLayer,
        moduleStateLayer,
        moduleCatalogLayer,
        contextAccessLayer,
        shellGovernedReadsLayer,
      ),
    ),
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
