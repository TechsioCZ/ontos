// @effect-diagnostics missedPipeableOpportunity:off
/* eslint-disable complexity, no-nested-ternary, no-use-before-define, prefer-destructuring, unicorn/consistent-function-scoping, unicorn/no-array-for-each, unicorn/no-array-method-this-argument -- Typed Shell handlers keep their closed Problem Details mapping and Effect traversal visible. */
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
  ActionRuntime,
  ActionRuntimeLive,
  ReadRuntime,
  ContextAccessLive,
  LegalEntityContextLive,
  OutboxRuntimeLive,
  PrincipalResolverLive,
  SupportRecoveryPrincipalContextResolverLive,
  PrincipalResolver,
  LegalEntityContext,
  ContextAccess,
  TenantModuleStateServiceLive,
  makeTenantModuleStateService,
  makeReadRuntimeLive,
  managedPrincipalsRead,
  selfApiKeyBindingsRead,
} from '@app/core-runtime';
import type {
  ActionCoreError,
  InstalledModuleCatalog,
  PrincipalManagementError,
  PrincipalResolutionError,
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
  ShellInvalidRequestProblem,
  IdentityProblem,
  ManagedApiKeyListResponse,
  ShellPolicyConflictProblem,
  ShellPolicyUnprocessableProblem,
  ShellPreconditionRequiredProblem,
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
import { ApiKeyService, ApiKeyServiceLive } from './auth/api-key-service.ts';
import { makeIdentityLifecycleService } from './auth/identity-lifecycle.ts';
import {
  SupportImpersonationService,
  SupportImpersonationServiceLive,
} from './auth/impersonation-service.ts';
import {
  gatewayIssuerLiveDependencies,
  issueGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import type { GatewayIssuerDependencies, GatewayIssuerError } from './auth/gateway-issuer.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './auth/errors.ts';
import type { ApiKeyProviderError } from './auth/api-key-service.ts';
import type { IdentityLifecycleError } from './auth/identity-lifecycle.ts';
import type { SupportImpersonationError } from './auth/impersonation-service.ts';
import type { LegalEntitySelectionForbiddenError } from './auth/legal-entity-selection.ts';
import { validateAuthorizedLegalEntity } from './auth/legal-entity-selection.ts';
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
const apiKeyChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeader(response, 'www-authenticate', 'ApiKey realm="ontos-gateway"'),
  ),
);

const failGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (gatewayProblem._tag === 'GatewayAuthenticationRequiredProblem'
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(gatewayProblem)));
const failApiKeyGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (gatewayProblem._tag === 'GatewayAuthenticationRequiredProblem'
    ? apiKeyChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(gatewayProblem)));

const failIdentityProblem = (problem: IdentityProblem) =>
  (problem._tag === 'ShellAuthenticationRequiredProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(problem)),
  );
type GatewayProblem<Tag extends GatewayContextProblem['_tag']> = Extract<
  GatewayContextProblem,
  { readonly _tag: Tag }
>;
type IdentityRuntimeError =
  | ActionCoreError
  | ApiKeyProviderError
  | AuthenticationRuntimeError
  | IdentityLifecycleError
  | PrincipalManagementError
  | PrincipalResolutionError
  | ReadCoreError
  | SupportImpersonationError;
type IdentityActionPolicyStatuses = Readonly<Record<string, 403 | 409 | 422>>;

const identityProblem = (
  error: IdentityRuntimeError,
  actionPolicyStatuses: IdentityActionPolicyStatuses = {},
): IdentityProblem => {
  switch (error._tag) {
    case 'ActionPayloadValidationError':
    case 'ReadInputValidationError': {
      return shellInvalidRequestProblem();
    }
    case 'ActionIdempotencyKeyRequired': {
      return shellPreconditionRequiredProblem();
    }
    case 'ActionInvocationNotFound':
    case 'ReadHandlerNotFound': {
      return shellTargetNotFoundProblem();
    }
    case 'ActionPermissionDenied':
    case 'ModuleStateDeniedError':
    case 'OperationContextDenied':
    case 'PrincipalBindingAmbiguousError':
    case 'PrincipalBindingInactiveError':
    case 'PrincipalBindingMissingError':
    case 'PrincipalInactiveError':
    case 'ReadPermissionDenied':
    case 'SupportImpersonationDeniedError':
    case 'TenantInactiveError': {
      return shellTargetForbiddenProblem();
    }
    case 'ActionPolicyDenied': {
      const status = actionPolicyStatuses[error.policyReasonCode];
      if (status === 403) {
        return shellTargetForbiddenProblem();
      }
      if (status === 409) {
        return shellPolicyConflictProblem();
      }
      if (status === 422) {
        return shellPolicyUnprocessableProblem();
      }
      // Current identity Actions declare no Policies. An undeclared denial is an
      // integration defect, not authorization evidence that may be guessed as 403.
      return shellCapabilityUnavailableProblem();
    }
    case 'IdentityLifecycleConflictError':
    case 'ApiKeyStateInconsistentError':
    case 'ActionAlreadyCommitted':
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict': {
      return shellPolicyConflictProblem();
    }
    case 'ReadPolicyDenied': {
      return error.httpStatus === 422
        ? shellPolicyUnprocessableProblem()
        : shellPolicyConflictProblem();
    }
    case 'IdentityTargetInvalidError': {
      return shellPolicyUnprocessableProblem();
    }
    case 'ApiKeyRateLimitedError': {
      return {
        _tag: 'ShellRateLimitedProblem',
        detail: 'The credential provider rate limit was exceeded.',
        retryAfterSeconds: error.retryAfterSeconds ?? 60,
        status: 429,
        title: 'Identity operation rate limited',
        type: 'https://ontos.dev/problems/identity-rate-limited',
      };
    }
    case 'InvalidCredentialsError':
    case 'ApiKeyCredentialInvalidError':
    case 'OntosIdentityForbiddenError':
    case 'ActionTrustedContextValidationError':
    case 'OperationAuthenticationRequired': {
      return shellAuthenticationRequiredProblem();
    }
    case 'ActionCollectorError':
    case 'ActionCommitIndeterminate':
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'ApiKeyProviderUnavailableError':
    case 'AuthenticationUnavailableError':
    case 'IdentityLifecycleOperationError':
    case 'IdentityPersistenceUnavailableError':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
    case 'PrincipalResolverUnavailableError':
    case 'ReadEvidencePersistenceError':
    case 'ReadHandlerUnavailable':
    case 'ReadPermissionUnavailable':
    case 'ReadPolicyEvaluationError':
    case 'SupportImpersonationUnavailableError': {
      return shellCapabilityUnavailableProblem();
    }
    case 'ActionHandlerExecutionError':
    case 'ActionResultValidationError':
    case 'AuthenticationInternalError':
    case 'OperationContextInvalid':
    case 'ReadEvidenceValidationError':
    case 'ReadHandlerExecutionError':
    case 'ReadResultValidationError': {
      return shellInternalProblem();
    }
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const gatewayAuthenticationRequiredProblem =
  (): GatewayProblem<'GatewayAuthenticationRequiredProblem'> => ({
    _tag: 'GatewayAuthenticationRequiredProblem',
    detail: 'A valid Shell session is required.',
    status: 401,
    title: 'Gateway authentication required',
    type: 'https://ontos.dev/problems/gateway-authentication-required',
  });

const gatewayInternalProblem = (): GatewayProblem<'GatewayInternalProblem'> => ({
  _tag: 'GatewayInternalProblem',
  detail: 'Gateway authentication could not complete.',
  status: 500,
  title: 'Gateway authentication failed',
  type: 'https://ontos.dev/problems/gateway-internal',
});
const gatewayForbiddenProblem = (): GatewayProblem<'GatewayForbiddenProblem'> => ({
  _tag: 'GatewayForbiddenProblem',
  detail: 'The authenticated principal cannot use the requested gateway context.',
  status: 403,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});
const gatewayRateLimitedProblem = (
  retryAfterSeconds: number,
): GatewayProblem<'GatewayRateLimitedProblem'> => ({
  _tag: 'GatewayRateLimitedProblem',
  detail: 'The API key rate limit was exceeded.',
  retryAfterSeconds,
  status: 429,
  title: 'Gateway rate limited',
  type: 'https://ontos.dev/problems/gateway-rate-limited',
});

const gatewayAuthenticationProblem = (
  error: AuthenticationRuntimeError,
):
  | GatewayProblem<'GatewayAuthenticationRequiredProblem'>
  | GatewayProblem<'GatewayInternalProblem'>
  | GatewayProblem<'GatewayUnavailableProblem'> => {
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

const gatewayIssuerProblem = (
  error: GatewayIssuerError,
): GatewayProblem<'GatewayAudienceInvalidProblem'> | GatewayProblem<'GatewayUnavailableProblem'> =>
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

const shellInvalidRequestProblem = (): ShellInvalidRequestProblem => ({
  _tag: 'ShellInvalidRequestProblem',
  detail: 'The identity request is invalid.',
  status: 400,
  title: 'Invalid identity request',
  type: 'https://ontos.dev/problems/identity-invalid-request',
});

const shellPreconditionRequiredProblem = (): ShellPreconditionRequiredProblem => ({
  _tag: 'ShellPreconditionRequiredProblem',
  detail: 'This identity operation requires an idempotency key.',
  status: 428,
  title: 'Identity precondition required',
  type: 'https://ontos.dev/problems/identity-precondition-required',
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

const identityGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'identity', (handlers) => {
  const authenticated = (request: {
    readonly headers: Readonly<Record<string, string | undefined>>;
  }) =>
    Effect.gen(function* authenticatedIdentity() {
      const authentication = yield* AuthenticationService;
      const resolved = yield* authentication
        .resolveTenantContext(requestHeaders(request.headers))
        .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
      yield* forwardSetCookieHeaders(resolved.setCookieHeaders);
      if (resolved.state !== 'authenticated') {
        return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
      }
      return { authentication, resolved };
    });
  const lifecycle = Effect.gen(function* identityLifecycle() {
    const actions = yield* ActionRuntime;
    const keys = yield* ApiKeyService;
    const resolver = yield* PrincipalResolver;
    return makeIdentityLifecycleService(actions, keys, resolver);
  });
  const correlation = (request: {
    readonly headers: Readonly<Record<string, string | undefined>>;
  }) => request.headers['x-correlation-id'] ?? 'missing';
  const requiredIdempotencyKey = (headers: Readonly<Record<string, string | undefined>>) => {
    const value = headers['idempotency-key'];
    return value === undefined
      ? failIdentityProblem(shellPreconditionRequiredProblem())
      : Effect.succeed(value);
  };
  const safeIdentity = <Value, Error, Requirements>(
    request: { readonly headers: Readonly<Record<string, string | undefined>> },
    effect: Effect.Effect<Value, Error, Requirements>,
  ) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.annotateLogs(Effect.logError('Unexpected Shell identity defect', defect), {
          correlationId: correlation(request),
        }).pipe(Effect.andThen(failIdentityProblem(shellInternalProblem()))),
      ),
    );
  return handlers
    .handle('createNonHumanPrincipal', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* createNonHumanPrincipalHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          return yield* service
            .createNonHumanPrincipal({
              correlationId: correlation(request),
              idempotencyKey,
              payload,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('changePrincipalStatus', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* changePrincipalStatusHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          const result = yield* service
            .changePrincipalStatus({
              correlationId: correlation(request),
              idempotencyKey,
              payload,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
          return { status: result.status };
        }),
      ),
    )
    .handle('issueSelfApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* issueSelfApiKeyHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          return yield* service
            .issue({
              correlationId: correlation(request),
              idempotencyKey,
              ...(payload.name === undefined ? {} : { name: payload.name }),
              principal: resolved.principal,
              requestHeaders: requestHeaders(request.headers),
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('listSelfApiKeys', ({ payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* listSelfApiKeysHandler() {
          const { resolved } = yield* authenticated(request);
          const runtime = yield* ReadRuntime;
          const keys = yield* ApiKeyService;
          const resolver = yield* PrincipalResolver;
          const result = yield* runtime
            .runRead({
              input: payload,
              principal: resolved.principal,
              registration: selfApiKeyBindingsRead,
              transport: { correlationId: correlation(request) },
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
          const items = yield* Effect.forEach(result.items, (binding) =>
            resolver
              .loadApiKeyBindingForAdministration({
                authBindingId: binding.authBindingId,
                principalId: resolved.principal.principalId,
                tenantId: resolved.principal.tenantId,
              })
              .pipe(
                Effect.flatMap((bindingState) =>
                  keys
                    .metadata(bindingState.providerSubjectId)
                    .pipe(Effect.map((metadata) => ({ bindingState, metadata }))),
                ),
                Effect.map(({ bindingState, metadata }) => {
                  const { providerKeyId: _providerKeyId, ...publicKeyMetadata } = metadata;
                  return {
                    ...publicKeyMetadata,
                    authBindingId: binding.authBindingId,
                    cleanupPending: metadata.enabled !== (bindingState.status === 'active'),
                  };
                }),
                Effect.catch((error) => failIdentityProblem(identityProblem(error))),
              ),
          );
          return { items, nextOffset: result.nextOffset };
        }),
      ),
    )
    .handle('issueManagedApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* issueManagedApiKeyHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          return yield* service
            .issue({
              correlationId: correlation(request),
              idempotencyKey,
              managedPrincipalId: payload.principalId,
              ...(payload.name === undefined ? {} : { name: payload.name }),
              principal: resolved.principal,
              requestHeaders: requestHeaders(request.headers),
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('listManagedApiKeys', ({ payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* listManagedApiKeysHandler() {
          const { resolved } = yield* authenticated(request);
          const runtime = yield* ReadRuntime;
          const keys = yield* ApiKeyService;
          const resolver = yield* PrincipalResolver;
          const result = yield* runtime
            .runRead({
              input: payload,
              principal: resolved.principal,
              registration: managedPrincipalsRead,
              transport: { correlationId: correlation(request) },
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
          const items = yield* Effect.forEach(result.items, (item) => {
            const { authBindingId } = item;
            if (authBindingId === null) {
              const withoutKey: ManagedApiKeyListResponse['items'][number] = {
                displayName: item.displayName,
                key: null,
                kind: item.kind,
                principalId: item.principalId,
                principalStatus: item.principalStatus,
              };
              return Effect.succeed(withoutKey);
            }
            return resolver
              .loadApiKeyBindingForAdministration({
                authBindingId,
                principalId: item.principalId,
                tenantId: resolved.principal.tenantId,
              })
              .pipe(
                Effect.flatMap((bindingState) =>
                  keys
                    .metadata(bindingState.providerSubjectId)
                    .pipe(Effect.map((metadata) => ({ bindingState, metadata }))),
                ),
                Effect.map(
                  ({ bindingState, metadata }): ManagedApiKeyListResponse['items'][number] => ({
                    displayName: item.displayName,
                    key: {
                      authBindingId,
                      cleanupPending: metadata.enabled !== (bindingState.status === 'active'),
                      createdAt: metadata.createdAt,
                      enabled: metadata.enabled,
                      expiresAt: metadata.expiresAt,
                      name: metadata.name,
                      start: metadata.start,
                    },
                    kind: item.kind,
                    principalId: item.principalId,
                    principalStatus: item.principalStatus,
                  }),
                ),
                Effect.catch((error) => failIdentityProblem(identityProblem(error))),
              );
          });
          return { items, nextOffset: result.nextOffset };
        }),
      ),
    )
    .handle('setSelfApiKeyStatus', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* setSelfKeyHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          return yield* service
            .setStatus({
              ...payload,
              correlationId: correlation(request),
              idempotencyKey,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('setManagedApiKeyStatus', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* setManagedKeyHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          const { principalId, ...statusPayload } = payload;
          return yield* service
            .setStatus({
              ...statusPayload,
              correlationId: correlation(request),
              idempotencyKey,
              managedPrincipalId: principalId,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('rotateSelfApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* rotateSelfKeyHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          return yield* service
            .rotate({
              correlationId: correlation(request),
              idempotencyKey,
              ...(payload.name === undefined ? {} : { name: payload.name }),
              oldAuthBindingId: payload.oldAuthBindingId,
              principal: resolved.principal,
              reason: payload.reason,
              requestHeaders: requestHeaders(request.headers),
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('rotateManagedApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* rotateManagedKeyHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          return yield* service
            .rotate({
              correlationId: correlation(request),
              idempotencyKey,
              managedPrincipalId: payload.principalId,
              ...(payload.name === undefined ? {} : { name: payload.name }),
              oldAuthBindingId: payload.oldAuthBindingId,
              oldManagedPrincipalId: payload.principalId,
              principal: resolved.principal,
              reason: payload.reason,
              requestHeaders: requestHeaders(request.headers),
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        }),
      ),
    )
    .handle('startSupportImpersonation', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* startSupportImpersonationHandler() {
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* SupportImpersonationService;
          const result = yield* service
            .start({
              correlationId: correlation(request),
              idempotencyKey,
              reason: payload.reason,
              requestHeaders: requestHeaders(request.headers),
              targetPrincipalId: payload.targetPrincipalId,
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return { active: result.active, targetPrincipalId: result.targetPrincipalId };
        }),
      ),
    )
    .handle('stopSupportImpersonation', ({ headers, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* stopSupportImpersonationHandler() {
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* SupportImpersonationService;
          const result = yield* service
            .stop({
              correlationId: correlation(request),
              idempotencyKey,
              requestHeaders: requestHeaders(request.headers),
            })
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          if (result.checkpointPending === true) {
            return yield* failIdentityProblem(shellCapabilityUnavailableProblem());
          }
          return { active: result.active };
        }),
      ),
    );
});

const makeGatewayContextGroupLive = (issuerDependencies: GatewayIssuerDependencies) =>
  HttpApiBuilder.group(ShellAuthenticationApi, 'gatewayContext', (handlers) =>
    handlers
      .handle('issueGatewayContext', ({ payload, request }) =>
        Effect.gen(function* issueGatewayContextHandler() {
          const authentication = yield* AuthenticationService;
          const sessionResult = yield* authentication
            .resolveShellContext(requestHeaders(request.headers))
            .pipe(
              Effect.catch((error) =>
                pipe(error, gatewayAuthenticationProblem, failGatewayProblem),
              ),
            );
          yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
          if (sessionResult.state !== 'authenticated') {
            return yield* failGatewayProblem(gatewayAuthenticationRequiredProblem());
          }
          if (
            payload.legalEntityId !== undefined &&
            payload.legalEntityId !== sessionResult.principal.legalEntityId
          ) {
            return yield* failGatewayProblem(gatewayForbiddenProblem());
          }

          return yield* issueGatewayContextAssertion(
            {
              audience: payload.audience,
              principal: sessionResult.principal,
            },
            issuerDependencies,
          ).pipe(Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)));
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.annotateLogs(
              Effect.logError('Unexpected Shell gateway assertion defect', defect),
              { correlationId: request.headers['x-correlation-id'] ?? 'missing' },
            ).pipe(Effect.andThen(failGatewayProblem(gatewayInternalProblem()))),
          ),
        ),
      )
      .handle('issueApiKeyGatewayContext', ({ headers, payload, request }) =>
        Effect.gen(function* issueApiKeyGatewayContextHandler() {
          const keys = yield* ApiKeyService;
          const resolver = yield* PrincipalResolver;
          const legalEntityContext = yield* LegalEntityContext;
          const contextAccess = yield* ContextAccess;
          const rawKey = headers['x-api-key'];
          if (rawKey === undefined || rawKey.trim().length === 0) {
            return yield* failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem());
          }
          const verified = yield* keys.verify(rawKey).pipe(
            Effect.catch((error) =>
              failApiKeyGatewayProblem(
                error._tag === 'ApiKeyRateLimitedError'
                  ? gatewayRateLimitedProblem(error.retryAfterSeconds)
                  : error._tag === 'ApiKeyCredentialInvalidError'
                    ? gatewayAuthenticationRequiredProblem()
                    : {
                        _tag: 'GatewayUnavailableProblem',
                        detail: 'Gateway authentication is temporarily unavailable. Please retry.',
                        retryable: true,
                        status: 503,
                        title: 'Gateway unavailable',
                        type: 'https://ontos.dev/problems/gateway-unavailable',
                      },
              ),
            ),
          );
          const identity = yield* resolver.resolveBetterAuthApiKey(verified.providerKeyId).pipe(
            Effect.catch((error) =>
              failApiKeyGatewayProblem(
                error._tag === 'PrincipalResolverUnavailableError'
                  ? {
                      _tag: 'GatewayUnavailableProblem',
                      detail: 'Gateway authentication is temporarily unavailable. Please retry.',
                      retryable: true,
                      status: 503,
                      title: 'Gateway unavailable',
                      type: 'https://ontos.dev/problems/gateway-unavailable',
                    }
                  : error._tag === 'PrincipalInactiveError' || error._tag === 'TenantInactiveError'
                    ? gatewayForbiddenProblem()
                    : gatewayAuthenticationRequiredProblem(),
              ),
            ),
          );
          let legalEntityId: string | undefined;
          if (payload.legalEntityId !== undefined) {
            const selected = yield* validateAuthorizedLegalEntity(
              legalEntityContext,
              contextAccess,
              {
                legalEntityId: payload.legalEntityId,
                principalId: identity.principalId,
                tenantId: identity.tenantId,
              },
            ).pipe(
              Effect.catch((error) =>
                failApiKeyGatewayProblem(
                  error._tag === 'LegalEntitySelectionUnavailableError'
                    ? {
                        _tag: 'GatewayUnavailableProblem',
                        detail: 'Gateway authorization is temporarily unavailable. Please retry.',
                        retryable: true,
                        status: 503,
                        title: 'Gateway unavailable',
                        type: 'https://ontos.dev/problems/gateway-unavailable',
                      }
                    : gatewayForbiddenProblem(),
                ),
              ),
            );
            legalEntityId = selected.legalEntityId;
          }
          return yield* issueGatewayContextAssertion(
            {
              audience: payload.audience,
              principal: {
                authBindingId: identity.authBindingId,
                authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
                authMethod: 'api_key',
                ...(legalEntityId === undefined ? {} : { legalEntityId }),
                principalId: identity.principalId,
                tenantId: identity.tenantId,
              },
            },
            issuerDependencies,
          ).pipe(Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)));
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.annotateLogs(
              Effect.logError('Unexpected API-key gateway assertion defect', defect),
              { correlationId: request.headers['x-correlation-id'] ?? 'missing' },
            ).pipe(Effect.andThen(failGatewayProblem(gatewayInternalProblem()))),
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
const apiKeyServiceLive = ApiKeyServiceLive.pipe(Layer.provide(AuthPersistenceLive), Layer.orDie);
const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const supportRecoveryPrincipalLive = SupportRecoveryPrincipalContextResolverLive.pipe(
  Layer.provide(CorePersistenceLive),
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
  const supportImpersonationServiceLive = SupportImpersonationServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        authenticationLayer,
        AuthPersistenceLive,
        actionRuntimeLive,
        contextAccessLayer,
        principalResolverLive,
        supportRecoveryPrincipalLive,
      ),
    ),
    Layer.orDie,
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
        identityGroupLive,
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
        AuthPersistenceLive,
        actionRuntimeLive,
        apiKeyServiceLive,
        supportImpersonationServiceLive,
        principalResolverLive,
        legalEntityContextLive,
        moduleStateLayer,
        moduleCatalogLayer,
        contextAccessLayer,
        shellGovernedReadsLayer,
        readRuntimeLayer,
      ),
    ),
    Layer.orDie,
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
