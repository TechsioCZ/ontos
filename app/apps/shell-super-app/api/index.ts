import {
  ActionAuthorizationLifecycleLive,
  ScopedRoleMembershipLifecycleLive,
  SpiceDbConfigLive,
} from '@app/core-runtime/outbox/core-system-worker';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import type {
  ActionCoreError,
  ContextAccess,
  PrincipalManagementError,
  PrincipalResolutionError,
  ReadCoreError,
  TenantModuleStateService,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  makeActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  LegalEntityContextLive,
  legalEntityDetailRead,
  makeTenantModuleStateService,
  managedPrincipalsRead,
  OutboxRepositoryLive,
  OutboxRuntimeLive,
  OperationalScopeResolver,
  PrincipalResolver,
  PrincipalResolverLive,
  ReadRuntime,
  ReadRuntimeLive,
  selfApiKeyBindingsRead,
  SupportRecoveryPrincipalContextResolverLive,
  TenantModuleStateServiceLive,
  withRequestPermissionDecisions,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionAuthorityLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { API_KEY_GATEWAY_CONTEXT_HEADER, GatewayContextResponseSchema } from '@app/shared-contracts';
import type { ApiKeyGatewayContextRequest, GatewayContextProblem } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Cookies, HttpApiBuilder, HttpEffect, HttpServerResponse, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Logger,
  Match,
  Option,
  pipe,
  Predicate,
  Redacted,
  References,
  Schema,
  Tracer,
} from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { Reactivity } from 'effect/unstable/reactivity';
import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { dispatchModuleApiRequest, ModuleApiTransportLive } from '../src/module-api/transport.ts';
import { EmailTransportLive } from './email/transport.ts';
import { DocumentHomeCorrelationId, resolveDocumentHome } from './modules/shell-document-home.ts';

import {
  ApiKeyIssueResponseSchema,
  ApiKeyLifecycleResponseSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  CurrentSessionSchema,
  ConfigureDemoCompaniesResponseSchema,
  DemoAccountCapabilitySchema,
  ManagedApiKeyListResponseSchema,
  MediaAttachmentResponseSchema,
  PrincipalMutationResponseSchema,
  ResolvedModuleTargetSchema,
  SelfApiKeyListResponseSchema,
  ShellAuthenticationApi,
  ShellCompositionSchema,
  ShellDocumentContextSchema,
  ShellResourceResponseSchema,
  ShellSearchResponseSchema,
  SignInResponseSchema,
  SupportImpersonationResponseSchema,
  SwitchLegalEntityResponseSchema,
  SwitchTenantResponseSchema,
  SwitchToTenantContextResponseSchema,
} from '../shared/api.ts';
import type {
  AuthenticationInternalProblem,
  AuthenticationProblem,
  AvailableTenantsProblem,
  IdentityProblem,
  LegalEntityAccessForbiddenProblem,
  LegalEntityProblem,
  ShellAuthenticationRequiredProblem,
  ShellCapabilityUnavailableProblem,
  ShellInternalProblem,
  ShellDocumentContextRequest,
  ShellInvalidRequestProblem,
  ShellPolicyConflictProblem,
  ShellPolicyUnprocessableProblem,
  ShellPreconditionRequiredProblem,
  ShellSelectionRequiredProblem,
  ShellReloadRequiredProblem,
  ShellTargetForbiddenProblem,
  ShellTargetNotFoundProblem,
  SwitchTenantProblem,
  TenantAccessForbiddenProblem,
  TenantAuthenticationRequiredProblem,
  TenantCapabilityUnavailableProblem,
  TenantInternalProblem,
} from '../shared/api.ts';
import { ApiKeyService, ApiKeyServiceLive } from './auth/api-key-service.ts';
import {
  invitePeoplePerson,
  listPeople,
  listPeopleRoleCatalog,
  setPeopleCompanyMembership,
  setPeopleScopedRole,
} from './auth/people-administration.ts';
import {
  InvitePeopleResponseSchema,
  PeopleListResponseSchema,
  PeopleRoleCatalogSchema,
  SetPeopleCompanyMembershipResponseSchema,
  SetPeopleRoleResponseSchema,
} from '../shared/people-api.ts';
// @ontos-codesmith-core-read-server-imports:start

// @ontos-core-read legal-entity-detail
// legalEntityDetailRead uses the canonical @app/core-runtime import
// @ontos-codesmith-core-read-server-imports:end
import type { ApiKeyProviderError } from './auth/api-key-service.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { StaffAuthenticationNamespaceRegistryLive } from './auth/authentication-namespace-registry.ts';
import { AuthConfigLive } from './auth/config.ts';
import { OAuthFlowLive } from './auth/oauth-server/oauth-flow-live.ts';
import { oauthConnectGroupLive } from './oauth-connections/connect-http.ts';
import { McpTransportLive } from './mcp/transport.ts';
import { OAuthServerTransportLive } from './auth/oauth-server/transport.ts';
import {
  ExternalIdentityProviderContextAccessLive,
  ExternalIdentityProviderDeploymentLive,
} from './auth/external-identity-provider-deployment.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './auth/errors.ts';
import {
  GatewayIssuer,
  GatewayIssuerLive,
  ShellCryptoLive,
  issueGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import {
  externalIdentityGroupLive,
  externalIdentityWorkloadAuthorizationLive,
} from './auth/external-identity/index.ts';
import { ExternalIdentityNotInstalledLive } from './auth/external-identity-runtime.ts';
import type { ExternalIdentityDeploymentLayer } from './auth/external-identity-runtime.ts';
import type { GatewayIssuerError } from './auth/gateway-issuer.ts';
import { GatewayTimings, gatewayTimingCollector, observeGatewayPhase } from './auth/gateway-timing.ts';
import { demoAccountCapability } from './auth/demo-accounts.ts';
import { listAgentEntities, manageAgentEntity } from './auth/agent-entities.ts';
import { IdentityLifecycle, IdentityLifecycleLive } from './auth/identity-lifecycle.ts';
import type { IdentityLifecycleError } from './auth/identity-lifecycle.ts';
import {
  SupportImpersonationCorrelationId,
  SupportImpersonationService,
  SupportImpersonationServiceLive,
} from './auth/impersonation-service.ts';
import type { SupportImpersonationError } from './auth/impersonation-service.ts';
import type { LegalEntitySelectionForbiddenError } from './auth/legal-entity-selection.ts';
import { canSelectTenantContext, validateAuthorizedLegalEntity } from './auth/legal-entity-selection.ts';
import { InvitationTransportLive } from './auth/invitation/transport.ts';
import { AuthPersistenceLive, BetterAuthPersonInvitationIdentityProviderLive } from './auth/runtime-infrastructure.ts';
import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';
import { forwardOAuthRequest } from './auth/oauth-server/forward.ts';
import { oauthNotFoundResponse } from './auth/oauth-server/policy.ts';
import type { ShellContextResult } from './auth/service.ts';
import type { AgentPlatformCaller, AgentPlatformForbidden, AgentPlatformInvalid } from './agent-platform/caller.ts';
import type { AgentStoreUnavailable } from './agent-platform/proposal-store.ts';
import { decideAgentItems, revertAgentBatch } from './agent-platform/service-decide.ts';
import {
  listOwnAgentBatches,
  loadAgentActivity,
  loadAgentQueue,
  submitAgentProposals,
} from './agent-platform/service-queue.ts';
import { ShellInstalledModuleCatalog, ShellInstalledModuleCatalogLive } from './modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog, InstalledModuleCatalogError } from './modules/installed-module-catalog.ts';
import { InstalledOutboxMatcherLive } from './modules/installed-outbox-matcher.ts';
import { ShellCompositionFactoryLive } from './modules/shell-composition.ts';
import { CapturedShellCompositionCatalog } from './modules/captured-shell-catalog.ts';
import { ShellGovernedReads, createShellGovernedReadsLayer } from './modules/shell-governed-reads.ts';
import type { ShellScopedModuleStateFactory } from './modules/shell-governed-reads.ts';
import { OAuthConnectionHooksLive } from './oauth-connections/better-auth-hooks.ts';
import { companyDirectoryLive } from './oauth-connections-admin/company-directory-live.ts';
import { mcpResourceUrl } from './oauth-connections-admin/config.ts';
import { isSameOriginRequest } from './oauth-connections/request-origin.ts';
import { loadOAuthServerConfig } from './oauth-connections/server-config.ts';
import { grantAdminPortLive } from './oauth-connections-admin/grant-port-live.ts';
import {
  listForAdmin,
  listMine,
  replaceAgentOperators,
  revokeConnection,
  updateConnection,
} from './oauth-connections-admin/handlers.ts';
import type { ConnectionsAdminError, ConnectionsCaller } from './oauth-connections-admin/ports.ts';
import {
  attachShellMedia,
  ShellProviderUnavailableError,
  ShellResourceServicesFactoryLive,
} from './modules/shell-resources.ts';
import type {
  ShellMediaAttachmentResolution,
  ShellResourceContext,
  ShellResourceGateways,
} from './modules/shell-resources.ts';

const RequestHeadersSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Undefined]));
type RequestHeaders = Schema.Schema.Type<typeof RequestHeadersSchema>;
interface RequestWithHeaders {
  readonly headers: RequestHeaders;
}
type LogAnnotation = boolean | number | string;

const headerValue = (headers: RequestHeaders, name: string): string | undefined => headers[name];

const correlationFromRequest = (request: RequestWithHeaders): string =>
  headerValue(request.headers, 'x-correlation-id') ?? 'missing';

const requestLogAnnotations = (
  request: RequestWithHeaders,
  annotations: Readonly<Record<string, LogAnnotation>> = {},
) => ({ ...annotations, correlationId: correlationFromRequest(request) });

const recoverUnexpectedDefect =
  <Failure, FailureRequirements>(
    request: RequestWithHeaders,
    message: string,
    fail: () => Effect.Effect<never, Failure, FailureRequirements>,
  ) =>
  <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ): Effect.Effect<Value, Error | Failure, Requirements | FailureRequirements> =>
    Effect.exit(effect).pipe(
      Effect.flatMap((exit): Effect.Effect<Value, Error | Failure, FailureRequirements> => {
        if (Exit.isSuccess(exit)) {
          return Effect.succeed(exit.value);
        }
        return exit.cause.reasons.some(Cause.isDieReason)
          ? Effect.annotateLogs(Effect.logError(message, exit.cause), requestLogAnnotations(request)).pipe(
              Effect.andThen(fail()),
            )
          : Effect.failCause(exit.cause);
      }),
    );

const problemDetails = <Tag extends string, Status extends number>(
  tag: Tag,
  detail: string,
  status: Status,
  title: string,
  type: string,
) => ({ _tag: tag, detail, status, title, type });

const extendedProblemDetails = <
  Tag extends string,
  Status extends number,
  Extension extends Readonly<Record<string, boolean | number | string | undefined>>,
>(
  tag: Tag,
  detail: string,
  status: Status,
  title: string,
  type: string,
  extension: Extension,
) => ({ _tag: tag, detail, ...extension, status, title, type });

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const decodeResponse = <ResponseSchema extends Schema.Constraint, EncodedResponse extends object, Failure>(
  schema: ResponseSchema,
  encoded: EncodedResponse,
  failure: (schemaError: Schema.SchemaError) => Failure,
) => Schema.decodeUnknownEffect(schema)(encoded).pipe(Effect.mapError(failure));

const requestHeaders = (headers: RequestHeaders): Headers => {
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
        Effect.succeed(response.pipe(HttpServerResponse.mergeCookies(Cookies.fromSetCookie(headers)))),
      );

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer realm="ontos-gateway", error="invalid_token"'),
  ),
);
const apiKeyChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'ApiKey realm="ontos-gateway"')),
);
export const noStoreResponse = (response: Parameters<typeof HttpServerResponse.setHeader>[0]) =>
  HttpServerResponse.setHeader(response, 'cache-control', 'no-store');
const noStore = HttpEffect.appendPreResponseHandler((_request, response) => Effect.succeed(noStoreResponse(response)));

const failGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (Predicate.isTagged(gatewayProblem, 'GatewayAuthenticationRequiredProblem') ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(gatewayProblem)),
  );
const failApiKeyGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (Predicate.isTagged(gatewayProblem, 'GatewayAuthenticationRequiredProblem') ? apiKeyChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(gatewayProblem)),
  );

const failIdentityProblem = (problem: IdentityProblem) =>
  (Predicate.isTagged(problem, 'ShellAuthenticationRequiredProblem') ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(problem)),
  );
type GatewayProblem<Tag extends GatewayContextProblem['_tag']> = Extract<GatewayContextProblem, { readonly _tag: Tag }>;
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
type IdentityActionPolicyDenied = Extract<IdentityRuntimeError, { readonly _tag: 'ActionPolicyDenied' }>;
type IdentityApiKeyRateLimited = Extract<IdentityRuntimeError, { readonly _tag: 'ApiKeyRateLimitedError' }>;
type IdentityReadPolicyDenied = Extract<IdentityRuntimeError, { readonly _tag: 'ReadPolicyDenied' }>;

const gatewayAuthenticationRequiredProblem = (): GatewayProblem<'GatewayAuthenticationRequiredProblem'> =>
  problemDetails(
    'GatewayAuthenticationRequiredProblem',
    'A valid Shell session is required.',
    401,
    'Gateway authentication required',
    'https://ontos.dev/problems/gateway-authentication-required',
  );

const gatewayInternalProblem = (): GatewayProblem<'GatewayInternalProblem'> =>
  problemDetails(
    'GatewayInternalProblem',
    'Gateway authentication could not complete.',
    500,
    'Gateway authentication failed',
    'https://ontos.dev/problems/gateway-internal',
  );
const gatewayForbiddenProblem = (): GatewayProblem<'GatewayForbiddenProblem'> =>
  problemDetails(
    'GatewayForbiddenProblem',
    'The authenticated principal cannot use the requested gateway context.',
    403,
    'Gateway context forbidden',
    'https://ontos.dev/problems/gateway-forbidden',
  );
const gatewayRateLimitedProblem = (retryAfterSeconds: number): GatewayProblem<'GatewayRateLimitedProblem'> =>
  extendedProblemDetails(
    'GatewayRateLimitedProblem',
    'The API key rate limit was exceeded.',
    429,
    'Gateway rate limited',
    'https://ontos.dev/problems/gateway-rate-limited',
    { retryAfterSeconds },
  );

const gatewayAuthenticationUnavailableProblem = (): GatewayProblem<'GatewayUnavailableProblem'> =>
  extendedProblemDetails(
    'GatewayUnavailableProblem',
    'Gateway authentication is temporarily unavailable. Please retry.',
    503,
    'Gateway unavailable',
    'https://ontos.dev/problems/gateway-unavailable',
    { retryable: true as const },
  );

const gatewayAuthorizationUnavailableProblem = (): GatewayProblem<'GatewayUnavailableProblem'> =>
  extendedProblemDetails(
    'GatewayUnavailableProblem',
    'Gateway authorization is temporarily unavailable. Please retry.',
    503,
    'Gateway unavailable',
    'https://ontos.dev/problems/gateway-unavailable',
    { retryable: true as const },
  );

const gatewayRateLimitedFromProviderError = (
  error: Extract<ApiKeyProviderError, { readonly _tag: 'ApiKeyRateLimitedError' }>,
) => gatewayRateLimitedProblem(error.retryAfterSeconds);

const apiKeyProviderGatewayProblem = (
  error: ApiKeyProviderError,
): GatewayProblem<'GatewayAuthenticationRequiredProblem' | 'GatewayRateLimitedProblem' | 'GatewayUnavailableProblem'> =>
  Match.value(error).pipe(
    Match.tags({
      ApiKeyCredentialInvalidError: gatewayAuthenticationRequiredProblem,
      ApiKeyProviderUnavailableError: gatewayAuthenticationUnavailableProblem,
      ApiKeyRateLimitedError: gatewayRateLimitedFromProviderError,
      ApiKeyStateInconsistentError: gatewayAuthenticationUnavailableProblem,
    }),
    Match.exhaustive,
  );

const principalResolutionGatewayProblem = (
  error: PrincipalResolutionError,
): GatewayProblem<'GatewayAuthenticationRequiredProblem' | 'GatewayForbiddenProblem' | 'GatewayUnavailableProblem'> =>
  Match.value(error).pipe(
    Match.tags({
      PrincipalBindingAmbiguousError: gatewayAuthenticationRequiredProblem,
      PrincipalBindingInactiveError: gatewayAuthenticationRequiredProblem,
      PrincipalBindingMissingError: gatewayAuthenticationRequiredProblem,
      PrincipalInactiveError: gatewayForbiddenProblem,
      PrincipalResolverUnavailableError: gatewayAuthenticationUnavailableProblem,
      TenantInactiveError: gatewayForbiddenProblem,
    }),
    Match.exhaustive,
  );

const gatewayAuthenticationProblem = (
  error: AuthenticationRuntimeError,
):
  | GatewayProblem<'GatewayAuthenticationRequiredProblem'>
  | GatewayProblem<'GatewayInternalProblem'>
  | GatewayProblem<'GatewayUnavailableProblem'> =>
  Match.value(error).pipe(
    Match.tags({
      AuthenticationInternalError: gatewayInternalProblem,
      AuthenticationUnavailableError: gatewayAuthenticationUnavailableProblem,
      InvalidCredentialsError: gatewayAuthenticationRequiredProblem,
      OntosIdentityForbiddenError: gatewayAuthenticationRequiredProblem,
    }),
    Match.exhaustive,
  );

const gatewayIssuerProblem = (
  error: GatewayIssuerError,
):
  | GatewayProblem<'GatewayAudienceInvalidProblem'>
  | GatewayProblem<'GatewayReloadRequiredProblem'>
  | GatewayProblem<'GatewayUnavailableProblem'> => {
  if (error.code === 'gateway_revision_unsupported') {
    return extendedProblemDetails(
      'GatewayReloadRequiredProblem',
      'The document release is no longer admitted. Reload to continue.',
      409,
      'Reload required',
      'https://ontos.dev/problems/gateway-reload-required',
      { reloadRequired: true as const },
    );
  }
  return error.code === 'gateway_audience_invalid'
    ? problemDetails(
        'GatewayAudienceInvalidProblem',
        'The requested audience is not an available MicroVertical.',
        400,
        'Invalid gateway audience',
        'https://ontos.dev/problems/gateway-audience-invalid',
      )
    : extendedProblemDetails(
        'GatewayUnavailableProblem',
        'Gateway assertion issuance is temporarily unavailable. Please retry.',
        503,
        'Gateway unavailable',
        'https://ontos.dev/problems/gateway-unavailable',
        { retryable: true as const },
      );
};

const logGatewayIssuerFailure = (
  operation: 'api_key' | 'session',
  request: RequestWithHeaders,
  error: GatewayIssuerError,
) =>
  Effect.annotateLogs(
    Effect.logError('Shell gateway assertion issuance failed'),
    requestLogAnnotations(request, {
      failureCode: error.code,
      failureStage: error.stage,
      operation,
    }),
  );

const authenticationInternalProblem = (): AuthenticationInternalProblem =>
  problemDetails(
    'AuthenticationInternalProblem',
    'Authentication could not complete.',
    500,
    'Authentication failed',
    'https://ontos.dev/problems/authentication-internal',
  );

const authenticationUnavailableProblem = (): AuthenticationProblem =>
  problemDetails(
    'AuthenticationUnavailableProblem',
    'Authentication is temporarily unavailable. Please retry.',
    503,
    'Authentication unavailable',
    'https://ontos.dev/problems/authentication-unavailable',
  );

const invalidCredentialsProblem = (): AuthenticationProblem =>
  problemDetails(
    'InvalidCredentialsProblem',
    'The email address or password is invalid.',
    401,
    'Invalid credentials',
    'https://ontos.dev/problems/invalid-credentials',
  );

const ontosIdentityForbiddenProblem = (): AuthenticationProblem =>
  problemDetails(
    'OntosIdentityForbiddenProblem',
    'This account is not permitted to access OntOS.',
    403,
    'OntOS identity forbidden',
    'https://ontos.dev/problems/identity-forbidden',
  );

const problem = (error: AuthenticationRuntimeError): AuthenticationProblem =>
  Match.value(error).pipe(
    Match.tags({
      AuthenticationInternalError: authenticationInternalProblem,
      AuthenticationUnavailableError: authenticationUnavailableProblem,
      InvalidCredentialsError: invalidCredentialsProblem,
      OntosIdentityForbiddenError: ontosIdentityForbiddenProblem,
    }),
    Match.exhaustive,
  );

const currentAccessBlockedResponse = (session: Extract<ShellContextResult, { readonly state: 'access_blocked' }>) => ({
  identity: session.identity,
  state: 'access_blocked' as const,
});

const currentAnonymousResponse = () => ({ state: 'anonymous' as const });

const currentAuthenticatedResponse = (session: Extract<ShellContextResult, { readonly state: 'authenticated' }>) => ({
  identity: session.identity,
  state: 'authenticated' as const,
});

const currentTenantAuthenticatedResponse = (
  session: Extract<ShellContextResult, { readonly state: 'tenant_authenticated' }>,
) => ({
  availableLegalEntities: session.availableLegalEntities,
  identity: session.identity,
  state: 'tenant_authenticated' as const,
});

const currentSelectionRequiredResponse = (
  session: Extract<ShellContextResult, { readonly state: 'selection_required' }>,
) => ({
  availableLegalEntities: session.availableLegalEntities,
  identity: session.identity,
  state: 'selection_required' as const,
});

const tenantAuthenticationRequiredProblem = (): TenantAuthenticationRequiredProblem =>
  problemDetails(
    'TenantAuthenticationRequiredProblem',
    'A valid Shell session is required.',
    401,
    'Tenant session authentication required',
    'https://ontos.dev/problems/tenant-authentication-required',
  );

const tenantAccessForbiddenProblem = (): TenantAccessForbiddenProblem =>
  problemDetails(
    'TenantAccessForbiddenProblem',
    'The requested tenant is not available to this session.',
    403,
    'Tenant access forbidden',
    'https://ontos.dev/problems/tenant-access-forbidden',
  );

const tenantCapabilityUnavailableProblem = (): TenantCapabilityUnavailableProblem =>
  extendedProblemDetails(
    'TenantCapabilityUnavailableProblem',
    'Tenant context is temporarily unavailable. Please retry.',
    503,
    'Tenant context unavailable',
    'https://ontos.dev/problems/tenant-capability-unavailable',
    { retryable: true as const },
  );

const tenantInternalProblem = (): TenantInternalProblem =>
  problemDetails(
    'TenantInternalProblem',
    'Tenant context could not be loaded or changed.',
    500,
    'Tenant context failed',
    'https://ontos.dev/problems/tenant-internal',
  );

const tenantAuthenticationProblem = (error: AuthenticationRuntimeError): AvailableTenantsProblem =>
  Match.value(error).pipe(
    Match.tags({
      AuthenticationInternalError: tenantInternalProblem,
      AuthenticationUnavailableError: tenantCapabilityUnavailableProblem,
      InvalidCredentialsError: tenantAuthenticationRequiredProblem,
      OntosIdentityForbiddenError: tenantAuthenticationRequiredProblem,
    }),
    Match.exhaustive,
  );

const tenantProblem = (error: SwitchTenantRuntimeError): SwitchTenantProblem =>
  Match.value(error).pipe(
    Match.tags({
      AuthenticationInternalError: tenantInternalProblem,
      AuthenticationUnavailableError: tenantCapabilityUnavailableProblem,
      InvalidCredentialsError: tenantAuthenticationRequiredProblem,
      OntosIdentityForbiddenError: tenantAuthenticationRequiredProblem,
      TenantAccessForbiddenError: tenantAccessForbiddenProblem,
    }),
    Match.exhaustive,
  );

const legalEntityAccessForbiddenProblem = (): LegalEntityAccessForbiddenProblem =>
  problemDetails(
    'LegalEntityAccessForbiddenProblem',
    'The requested legal entity is not available to this session.',
    403,
    'Legal-entity access forbidden',
    'https://ontos.dev/problems/legal-entity-access-forbidden',
  );

const failContextProblem = <Failure extends LegalEntityProblem | SwitchTenantProblem>(failure: Failure) =>
  (Predicate.isTagged(failure, 'TenantAuthenticationRequiredProblem') ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(failure)),
  );

const shellAuthenticationRequiredProblem = (): ShellAuthenticationRequiredProblem =>
  problemDetails(
    'ShellAuthenticationRequiredProblem',
    'A valid Shell session is required.',
    401,
    'Shell authentication required',
    'https://ontos.dev/problems/shell-authentication-required',
  );

const shellCapabilityUnavailableProblem = (): ShellCapabilityUnavailableProblem =>
  extendedProblemDetails(
    'ShellCapabilityUnavailableProblem',
    'The Shell capability is temporarily unavailable. Please retry.',
    503,
    'Shell capability unavailable',
    'https://ontos.dev/problems/shell-capability-unavailable',
    { retryable: true as const },
  );

const shellInternalProblem = (): ShellInternalProblem =>
  problemDetails(
    'ShellInternalProblem',
    'The Shell request could not be completed.',
    500,
    'Shell request failed',
    'https://ontos.dev/problems/shell-internal',
  );

const shellSelectionRequiredProblem = (): ShellSelectionRequiredProblem =>
  problemDetails(
    'ShellSelectionRequiredProblem',
    'Select one legal entity before opening a module.',
    409,
    'Legal-entity selection required',
    'https://ontos.dev/problems/legal-entity-selection-required',
  );

const shellTargetForbiddenProblem = (): ShellTargetForbiddenProblem =>
  problemDetails(
    'ShellTargetForbiddenProblem',
    'The requested module is forbidden in the selected context.',
    403,
    'Module target forbidden',
    'https://ontos.dev/problems/module-target-forbidden',
  );

const shellTargetNotFoundProblem = (): ShellTargetNotFoundProblem =>
  problemDetails(
    'ShellTargetNotFoundProblem',
    'The requested module target was not found.',
    404,
    'Module target not found',
    'https://ontos.dev/problems/module-target-not-found',
  );

const shellPolicyConflictProblem = (): ShellPolicyConflictProblem =>
  problemDetails(
    'ShellPolicyConflictProblem',
    'The requested operation conflicts with a business policy.',
    409,
    'Policy conflict',
    'https://ontos.dev/problems/policy-conflict',
  );

const shellPolicyUnprocessableProblem = (): ShellPolicyUnprocessableProblem =>
  problemDetails(
    'ShellPolicyUnprocessableProblem',
    'The requested operation violates a business policy.',
    422,
    'Policy violation',
    'https://ontos.dev/problems/policy-violation',
  );

const shellInvalidRequestProblem = (): ShellInvalidRequestProblem =>
  problemDetails(
    'ShellInvalidRequestProblem',
    'The identity request is invalid.',
    400,
    'Invalid identity request',
    'https://ontos.dev/problems/identity-invalid-request',
  );

const shellPreconditionRequiredProblem = (): ShellPreconditionRequiredProblem =>
  problemDetails(
    'ShellPreconditionRequiredProblem',
    'This identity operation requires an idempotency key.',
    428,
    'Identity precondition required',
    'https://ontos.dev/problems/identity-precondition-required',
  );

const shellProblemFromAuthenticationError = (
  error: AuthenticationRuntimeError,
): ShellAuthenticationRequiredProblem | ShellCapabilityUnavailableProblem | ShellInternalProblem =>
  Match.value(error).pipe(
    Match.tags({
      AuthenticationInternalError: shellInternalProblem,
      AuthenticationUnavailableError: shellCapabilityUnavailableProblem,
      InvalidCredentialsError: shellAuthenticationRequiredProblem,
      OntosIdentityForbiddenError: shellAuthenticationRequiredProblem,
    }),
    Match.exhaustive,
  );

const identityActionPolicyProblem = (
  denial: IdentityActionPolicyDenied,
  actionPolicyStatuses: IdentityActionPolicyStatuses,
): IdentityProblem => {
  const status = actionPolicyStatuses[denial.policyReasonCode];
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
};

const identityApiKeyRateLimitedProblem = (rateLimit: IdentityApiKeyRateLimited): IdentityProblem =>
  extendedProblemDetails(
    'ShellRateLimitedProblem',
    'The credential provider rate limit was exceeded.',
    429,
    'Identity operation rate limited',
    'https://ontos.dev/problems/identity-rate-limited',
    { retryAfterSeconds: rateLimit.retryAfterSeconds ?? 60 },
  );

const identityReadPolicyProblem = (denial: IdentityReadPolicyDenied): IdentityProblem =>
  denial.httpStatus === 422 ? shellPolicyUnprocessableProblem() : shellPolicyConflictProblem();

const identityProblem = (
  error: IdentityRuntimeError,
  actionPolicyStatuses: IdentityActionPolicyStatuses = {},
): IdentityProblem => {
  const mapActionPolicyDenied = (denial: IdentityActionPolicyDenied): IdentityProblem =>
    identityActionPolicyProblem(denial, actionPolicyStatuses);

  return Match.value(error).pipe(
    Match.tags({
      ActionAlreadyCommitted: shellPolicyConflictProblem,
      ActionCollectorError: shellCapabilityUnavailableProblem,
      ActionCommitIndeterminate: shellCapabilityUnavailableProblem,
      ActionHandlerExecutionError: shellInternalProblem,
      ActionIdempotencyKeyRequired: shellPreconditionRequiredProblem,
      ActionInvocationNotFound: shellTargetNotFoundProblem,
      ActionInvocationPersistenceError: shellCapabilityUnavailableProblem,
      ActionInvocationStateError: shellPolicyConflictProblem,
      ActionPayloadValidationError: shellInvalidRequestProblem,
      ActionPermissionCheckError: shellCapabilityUnavailableProblem,
      ActionPermissionDenied: shellTargetForbiddenProblem,
      ActionPolicyDenied: mapActionPolicyDenied,
      ActionPolicyEvaluationError: shellCapabilityUnavailableProblem,
      ActionRequestHashConflict: shellPolicyConflictProblem,
      ActionResultValidationError: shellInternalProblem,
      ActionTransactionError: shellCapabilityUnavailableProblem,
      ActionTrustedContextValidationError: shellAuthenticationRequiredProblem,
      ApiKeyCredentialInvalidError: shellAuthenticationRequiredProblem,
      ApiKeyProviderUnavailableError: shellCapabilityUnavailableProblem,
      ApiKeyRateLimitedError: identityApiKeyRateLimitedProblem,
      ApiKeyStateInconsistentError: shellPolicyConflictProblem,
      AuthenticationInternalError: shellInternalProblem,
      AuthenticationUnavailableError: shellCapabilityUnavailableProblem,
      IdentityLifecycleConflictError: shellPolicyConflictProblem,
      IdentityLifecycleOperationError: shellCapabilityUnavailableProblem,
      IdentityPersistenceUnavailableError: shellCapabilityUnavailableProblem,
      IdentityTargetInvalidError: shellPolicyUnprocessableProblem,
      InvalidCredentialsError: shellAuthenticationRequiredProblem,
      ModuleStateCheckUnavailableError: shellCapabilityUnavailableProblem,
      ModuleStateDeniedError: shellTargetForbiddenProblem,
      OntosIdentityForbiddenError: shellAuthenticationRequiredProblem,
      OperationAuthenticationRequired: shellAuthenticationRequiredProblem,
      OperationContextDenied: shellTargetForbiddenProblem,
      OperationContextInvalid: shellInternalProblem,
      OperationContextUnavailable: shellCapabilityUnavailableProblem,
      PrincipalBindingAmbiguousError: shellTargetForbiddenProblem,
      PrincipalBindingInactiveError: shellTargetForbiddenProblem,
      PrincipalBindingMissingError: shellTargetForbiddenProblem,
      PrincipalInactiveError: shellTargetForbiddenProblem,
      PrincipalResolverUnavailableError: shellCapabilityUnavailableProblem,
      ReadEvidencePersistenceError: shellCapabilityUnavailableProblem,
      ReadEvidenceValidationError: shellInternalProblem,
      ReadHandlerExecutionError: shellInternalProblem,
      ReadHandlerNotFound: shellTargetNotFoundProblem,
      ReadHandlerUnavailable: shellCapabilityUnavailableProblem,
      ReadInputValidationError: shellInvalidRequestProblem,
      ReadPermissionDenied: shellTargetForbiddenProblem,
      ReadPermissionUnavailable: shellCapabilityUnavailableProblem,
      ReadPolicyDenied: identityReadPolicyProblem,
      ReadPolicyEvaluationError: shellCapabilityUnavailableProblem,
      ReadResultValidationError: shellInternalProblem,
      SupportImpersonationDeniedError: shellTargetForbiddenProblem,
      SupportImpersonationUnavailableError: shellCapabilityUnavailableProblem,
      TenantInactiveError: shellTargetForbiddenProblem,
    }),
    Match.exhaustive,
  );
};

const shellReadPolicyProblem = (denial: Extract<ReadCoreError, { readonly _tag: 'ReadPolicyDenied' }>) =>
  denial.httpStatus === 409 ? shellPolicyConflictProblem() : shellPolicyUnprocessableProblem();

const shellReadProblem = (
  error: ReadCoreError,
):
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem =>
  Match.value(error).pipe(
    Match.tags({
      ModuleStateCheckUnavailableError: shellCapabilityUnavailableProblem,
      ModuleStateDeniedError: shellTargetForbiddenProblem,
      OperationAuthenticationRequired: shellAuthenticationRequiredProblem,
      OperationContextDenied: shellTargetForbiddenProblem,
      OperationContextInvalid: shellInternalProblem,
      OperationContextUnavailable: shellCapabilityUnavailableProblem,
      ReadEvidencePersistenceError: shellCapabilityUnavailableProblem,
      ReadEvidenceValidationError: shellInternalProblem,
      ReadHandlerExecutionError: shellInternalProblem,
      ReadHandlerNotFound: shellTargetNotFoundProblem,
      ReadHandlerUnavailable: shellCapabilityUnavailableProblem,
      ReadInputValidationError: shellInternalProblem,
      ReadPermissionDenied: shellTargetForbiddenProblem,
      ReadPermissionUnavailable: shellCapabilityUnavailableProblem,
      ReadPolicyDenied: shellReadPolicyProblem,
      ReadPolicyEvaluationError: shellCapabilityUnavailableProblem,
      ReadResultValidationError: shellInternalProblem,
    }),
    Match.exhaustive,
  );

const shellListReadProblem = (error: ReadCoreError) => {
  const mappedProblem = shellReadProblem(error);
  return Predicate.isTagged(mappedProblem, 'ShellTargetNotFoundProblem') ? shellInternalProblem() : mappedProblem;
};

const logShellReadFailure = (
  operation: 'composition' | 'module_target' | 'resource' | 'search',
  request: RequestWithHeaders,
  error: ReadCoreError,
) =>
  Effect.annotateLogs(
    Effect.logError('Shell governed read failed'),
    requestLogAnnotations(request, {
      failureReason: error.reason,
      failureTag: error._tag,
      operation,
    }),
  );

type ShellProblem =
  | ShellReloadRequiredProblem
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellSelectionRequiredProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem;

const failShellProblem = <Failure extends ShellProblem>(failure: Failure) =>
  (Predicate.isTagged(failure, 'ShellAuthenticationRequiredProblem') ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(failure)),
  );

const mediaAttachmentForbidden = () => failShellProblem(shellTargetForbiddenProblem());
const mediaAttachmentNotFound = () => failShellProblem(shellTargetNotFoundProblem());
const mediaAttachmentResolved = (
  resolution: Extract<ShellMediaAttachmentResolution, { readonly outcome: 'resolved' }>,
) => decodeResponse(MediaAttachmentResponseSchema, resolution.result, shellInternalProblem);
const mediaAttachmentUnavailable = () => failShellProblem(shellCapabilityUnavailableProblem());

// Reusable gateway assertions belong to the session that is signing out. Drop them while the
// session still resolves; a session that no longer resolves cannot reach its entries anyway.
const forgetSessionGatewayAssertions = Effect.fn('shell.authentication.forgetGatewayAssertions')(
  function* forgetSessionGatewayAssertionsEffect(headers: Headers) {
    const authentication = yield* AuthenticationService;
    const gatewayIssuer = yield* GatewayIssuer;
    const session = yield* authentication.resolveShellContext(headers).pipe(Effect.option);
    if (Option.isSome(session) && session.value.state !== 'anonymous') {
      const { authContextRef } = session.value.principal;
      if (authContextRef !== undefined) {
        yield* gatewayIssuer.forgetAuthContext(authContextRef);
      }
    }
  },
);

const authenticationGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'authentication', (handlers) =>
  handlers
    .handle(
      'signIn',
      Effect.fn('shell.authentication.signIn')(({ payload, request }) =>
        Effect.gen(function* signInHandler() {
          const authentication = yield* AuthenticationService;
          const result = yield* authentication
            .signIn(payload.email, Redacted.value(payload.password), requestHeaders(request.headers))
            .pipe(Effect.mapError(problem));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return yield* decodeResponse(
            SignInResponseSchema,
            { identity: result.identity },
            authenticationInternalProblem,
          );
        }),
      ),
    )
    .handle('currentSession', ({ request }) =>
      Effect.gen(function* currentSessionHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(Effect.mapError(problem));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        const response = Match.value(result).pipe(
          Match.discriminators('state')({
            access_blocked: currentAccessBlockedResponse,
            anonymous: currentAnonymousResponse,
            authenticated: currentAuthenticatedResponse,
            selection_required: currentSelectionRequiredResponse,
            tenant_authenticated: currentTenantAuthenticatedResponse,
          }),
          Match.exhaustive,
        );
        return yield* decodeResponse(CurrentSessionSchema, response, authenticationInternalProblem);
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell current-session defect', () =>
          Effect.fail(authenticationInternalProblem()),
        ),
      ),
    )
    .handle(
      'signOut',
      Effect.fn('shell.authentication.signOut')(({ request }) =>
        Effect.gen(function* signOutHandler() {
          const authentication = yield* AuthenticationService;
          yield* forgetSessionGatewayAssertions(requestHeaders(request.headers));
          const result = yield* authentication.signOut(requestHeaders(request.headers));
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return {
            signedOut: true as const,
          };
        }).pipe(Effect.mapError(problem)),
      ),
    ),
);

const legalEntityGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'legalEntities', (handlers) =>
  handlers
    .handle('availableLegalEntities', ({ request }) =>
      Effect.gen(function* availableLegalEntitiesHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, tenantAuthenticationProblem, failContextProblem)));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        if (result.state === 'anonymous') {
          return yield* failContextProblem(tenantAuthenticationRequiredProblem());
        }
        const selectedLegalEntityId = result.state === 'authenticated' ? result.identity.legalEntityId : undefined;
        const response = withOptionalProperty(
          {
            legalEntities: result.availableLegalEntities,
            tenantContextAvailable: yield* canSelectTenantContext(result.principal).pipe(
              Effect.catchTag('LegalEntitySelectionUnavailableError', () =>
                failContextProblem(tenantCapabilityUnavailableProblem()),
              ),
            ),
          },
          selectedLegalEntityId !== undefined,
          'selectedLegalEntityId',
          selectedLegalEntityId,
          {
            state: result.state,
          },
        );
        return yield* decodeResponse(AvailableLegalEntitiesResponseSchema, response, tenantInternalProblem);
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected legal-entity list defect', () =>
          failContextProblem(tenantInternalProblem()),
        ),
      ),
    )
    .handle(
      'switchToTenantContext',
      Effect.fn('ShellContext.switchToTenantContext')(function* switchToTenantContextHandler({ request }) {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .switchToTenantContext(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, tenantProblem, failContextProblem)));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return yield* decodeResponse(
          SwitchToTenantContextResponseSchema,
          { selectedContext: 'tenant' },
          tenantInternalProblem,
        );
      }),
    )
    .handle('switchLegalEntity', ({ payload, request }) =>
      Effect.gen(function* switchLegalEntityHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .switchLegalEntity(payload.legalEntityId, requestHeaders(request.headers))
          .pipe(
            Effect.catch((error: AuthenticationRuntimeError | LegalEntitySelectionForbiddenError) =>
              failContextProblem(
                Predicate.isTagged(error, 'LegalEntitySelectionForbiddenError')
                  ? legalEntityAccessForbiddenProblem()
                  : tenantAuthenticationProblem(error),
              ),
            ),
          );
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return yield* decodeResponse(
          SwitchLegalEntityResponseSchema,
          { selectedLegalEntityId: result.selectedLegalEntityId },
          tenantInternalProblem,
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected legal-entity switch defect', () =>
          failContextProblem(tenantInternalProblem()),
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
          .pipe(Effect.catch((error) => pipe(error, tenantAuthenticationProblem, failContextProblem)));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return yield* decodeResponse(
          AvailableTenantsResponseSchema,
          { tenants: result.tenants },
          tenantInternalProblem,
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected tenant list defect', () =>
          failContextProblem(tenantInternalProblem()),
        ),
      ),
    )
    .handle('switchTenant', ({ payload, request }) =>
      Effect.gen(function* switchTenantHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .switchTenant(payload.tenantId, requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, tenantProblem, failContextProblem)));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return yield* decodeResponse(
          SwitchTenantResponseSchema,
          { selectedTenantId: result.selectedTenantId },
          tenantInternalProblem,
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected tenant switch defect', () =>
          failContextProblem(tenantInternalProblem()),
        ),
      ),
    ),
);

const requireShellSession = Effect.fn('ShellApi.requireShellSession')(function* requireShellSession(
  headers: RequestHeaders,
) {
  const authentication = yield* AuthenticationService;
  const session = yield* authentication
    .resolveShellContext(requestHeaders(headers))
    .pipe(Effect.catch((error) => pipe(error, shellProblemFromAuthenticationError, failShellProblem)));
  yield* forwardSetCookieHeaders(session.setCookieHeaders);
  if (session.state === 'anonymous') {
    return yield* failShellProblem(shellAuthenticationRequiredProblem());
  }
  return session;
});

const requireAuthenticatedShellContext = Effect.fn('ShellApi.requireAuthenticatedShellContext')(
  function* requireAuthenticatedShellContext(headers: RequestHeaders) {
    const session = yield* requireShellSession(headers);
    if (session.state !== 'authenticated') {
      return yield* failShellProblem(shellSelectionRequiredProblem());
    }
    return session;
  },
);

const captureShellRelease = Effect.fn('Shell.captureRelease')(function* captureShellReleaseEffect(
  requestedRevision?: string,
) {
  const authority = yield* ShellInstalledModuleCatalog;
  const catalog = yield* authority.load.pipe(
    Effect.catchTags({
      InstalledModuleCatalogInvalidError: () => failShellProblem(shellCapabilityUnavailableProblem()),
      InstalledModuleCatalogUnavailableError: () => failShellProblem(shellCapabilityUnavailableProblem()),
    }),
  );
  if (
    catalog.composition.shell.deployment.appId !== ultramodernDeliveryUnit.appId ||
    catalog.composition.shell.deployment.buildMarker !== ultramodernDeliveryUnit.buildMarker ||
    (requestedRevision !== undefined && requestedRevision !== catalog.composition.revision)
  ) {
    return yield* failShellProblem(
      problemDetails(
        'ShellReloadRequiredProblem',
        'The document release is no longer admitted. Reload to continue.',
        409,
        'Reload required',
        'https://ontos.dev/problems/shell-reload-required',
      ),
    );
  }
  return catalog;
});

/** Signing is local CPU work; a few in flight keep one document's assertions from monopolising the isolate. */
const DOCUMENT_GATEWAY_SIGNING_CONCURRENCY = 8;

/**
 * One assertion per audience for an authenticated session principal, from the same issuer as `issueGatewayContext`
 * (same audience binding and lifetime). An audience the release does not admit is left out instead of failing the
 * others; the browser asks for it alone and gets the single 400.
 */
const issueDocumentGatewayAssertions = Effect.fn('ShellGateway.issueDocumentAssertions')(
  function* issueDocumentGatewayAssertionsEffect(
    principal: TrustedPrincipalContext,
    compositionRevision: string,
    audiences: readonly string[],
  ) {
    const issued = yield* Effect.forEach(
      audiences,
      (audience) =>
        issueGatewayContextAssertion({ audience, compositionRevision, principal }).pipe(
          Effect.map((assertion) => Option.some({ ...assertion, audience })),
          Effect.catchIf(
            (error) => error.code === 'gateway_audience_invalid',
            () => Effect.succeedNone,
          ),
        ),
      { concurrency: DOCUMENT_GATEWAY_SIGNING_CONCURRENCY },
    );
    return issued.flatMap((assertion) => (Option.isSome(assertion) ? [assertion.value] : []));
  },
);

/**
 * Server rendering of a Shell document reads everything it needs here, from one resolution of the session's context:
 * reading session, legal entities, tenants, composition and the people capability as separate requests resolved the
 * same context (Better Auth session plus legal-entity checks) five times per document, each in its own invocation on
 * the document's isolate. Each part keeps its own outcome; the browser keeps the separate, cached endpoints.
 * It also signs the gateway assertions of the composition's audiences for the session principal (it is classified as
 * `shell.document-context.issue.session`): a separate batch call had to wait for this answer and then resolved the
 * session a second time. When signing fails the document goes without them and the browser asks the batch issuer.
 */
const documentContextHandler = Effect.fn('shell.composition.documentContext')(function* documentContextHandlerEffect(
  request: RequestWithHeaders,
  payload: ShellDocumentContextRequest,
) {
  yield* noStore;
  const authentication = yield* AuthenticationService;
  const headers = requestHeaders(request.headers);
  const context = yield* authentication.resolveShellContext(headers).pipe(Effect.mapError(problem));
  yield* forwardSetCookieHeaders(context.setCookieHeaders);
  const session = yield* decodeResponse(
    CurrentSessionSchema,
    Match.value(context).pipe(
      Match.discriminators('state')({
        access_blocked: currentAccessBlockedResponse,
        anonymous: currentAnonymousResponse,
        authenticated: currentAuthenticatedResponse,
        selection_required: currentSelectionRequiredResponse,
        tenant_authenticated: currentTenantAuthenticatedResponse,
      }),
      Match.exhaustive,
    ),
    authenticationInternalProblem,
  );
  if (context.state === 'anonymous') {
    return { session };
  }
  const legalEntities = withOptionalProperty(
    {
      legalEntities: context.availableLegalEntities,
      tenantContextAvailable: yield* canSelectTenantContext(context.principal).pipe(Effect.orElseSucceed(() => false)),
    },
    context.state === 'authenticated',
    'selectedLegalEntityId',
    context.state === 'authenticated' ? context.identity.legalEntityId : undefined,
    { state: context.state },
  );
  const tenants = authentication.availableTenants(headers).pipe(
    Effect.map(({ tenants: available }) => ({ state: 'available' as const, tenants: available })),
    Effect.catch((error) =>
      Effect.succeed({
        state: Predicate.isTagged(tenantAuthenticationProblem(error), 'TenantAuthenticationRequiredProblem')
          ? ('authentication_required' as const)
          : ('unavailable' as const),
      }),
    ),
  );
  if (context.state !== 'authenticated') {
    return {
      composition: { navigation: [] as const, state: context.state },
      legalEntities,
      session,
      tenants: yield* tenants,
    };
  }
  const { legalEntityId } = context.identity;
  const capability = yield* Effect.forkChild(
    demoAccountCapability({
      legalName:
        context.availableLegalEntities.find((entry) => entry.legalEntityId === legalEntityId)?.legalName ??
        legalEntityId,
      principal: { ...context.principal, legalEntityId },
    }).pipe(
      Effect.map(({ canManage }) => canManage),
      Effect.orElseSucceed(() => false),
    ),
    { startImmediately: true },
  );
  const composition = Effect.gen(function* loadDocumentComposition() {
    const catalog = yield* captureShellRelease(payload.compositionRevision);
    const governedReads = yield* ShellGovernedReads;
    const response = yield* governedReads
      .composition({
        correlationId: correlationFromRequest(request),
        principal: context.principal,
      })
      .pipe(
        Effect.provideService(CapturedShellCompositionCatalog, catalog),
        Effect.tapError((error) => logShellReadFailure('composition', request, error)),
      );
    const documentComposition = yield* decodeResponse(ShellCompositionSchema, response, shellInternalProblem);
    return { catalog, composition: documentComposition };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        catalog: null,
        composition: {
          state: Predicate.isTagged(error, 'ShellReloadRequiredProblem')
            ? ('reload_required' as const)
            : ('unavailable' as const),
        },
      }),
    ),
  );
  const [captured, documentTenants] = yield* Effect.all([composition, tenants], { concurrency: 2 });
  const documentComposition = captured.composition;
  const base = { composition: documentComposition, legalEntities, session, tenants: documentTenants };
  if (documentComposition.state !== 'available' || captured.catalog === null) {
    return base;
  }
  const assertions = yield* Effect.forkChild(
    issueDocumentGatewayAssertions(
      context.principal,
      documentComposition.compositionRevision,
      documentComposition.gatewayAudiences,
    ).pipe(
      Effect.tapError((error) => logGatewayIssuerFailure('session', request, error)),
      Effect.option,
    ),
    { startImmediately: true },
  );
  // Shell-owned people navigation does not depend on a workforce module contributing a legacy capability item.
  const canManagePeople = yield* Fiber.join(capability);
  const home =
    payload.home === true
      ? yield* resolveDocumentHome({
          canManagePeople,
          composition: documentComposition,
          principal: { ...context.principal, legalEntityId },
        }).pipe(
          Effect.provideService(CapturedShellCompositionCatalog, captured.catalog),
          Effect.provideService(DocumentHomeCorrelationId, correlationFromRequest(request)),
        )
      : undefined;
  const document = home === undefined ? { ...base, canManagePeople } : { ...base, canManagePeople, home };
  return Option.match(yield* Fiber.join(assertions), {
    onNone: () => document,
    onSome: (gatewayAssertions) => ({ ...document, gatewayAssertions }),
  });
});

// Session, legal-entity and composition checks of one document share their SpiceDB decisions.
const documentContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'documentContext', (handlers) =>
  handlers.handle('documentContext', ({ payload, request }) =>
    withRequestPermissionDecisions(documentContextHandler(request, payload)).pipe(
      Effect.flatMap((response) => decodeResponse(ShellDocumentContextSchema, response, authenticationInternalProblem)),
      recoverUnexpectedDefect(request, 'Unexpected Shell document context defect', () =>
        Effect.fail(authenticationInternalProblem()),
      ),
    ),
  ),
);

const compositionGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'composition', (handlers) =>
  handlers
    .handle('shellComposition', ({ query, request }) =>
      Effect.gen(function* shellCompositionHandler() {
        const session = yield* requireShellSession(request.headers);
        if (session.state === 'access_blocked') {
          return yield* decodeResponse(
            ShellCompositionSchema,
            { navigation: [], state: 'access_blocked' },
            shellInternalProblem,
          );
        }
        if (session.state !== 'authenticated') {
          return yield* decodeResponse(
            ShellCompositionSchema,
            { navigation: [], state: 'selection_required' },
            shellInternalProblem,
          );
        }
        const catalog = yield* captureShellRelease(query.compositionRevision);
        const governedReads = yield* ShellGovernedReads;
        const correlationId = correlationFromRequest(request);
        const response = yield* governedReads
          .composition({
            correlationId,
            principal: session.principal,
          })
          .pipe(
            Effect.provideService(CapturedShellCompositionCatalog, catalog),
            Effect.tapError((error) => logShellReadFailure('composition', request, error)),
            Effect.catch((error) => pipe(error, shellListReadProblem, failShellProblem)),
          );
        return yield* decodeResponse(ShellCompositionSchema, response, shellInternalProblem);
      }).pipe(
        withRequestPermissionDecisions,
        recoverUnexpectedDefect(request, 'Unexpected Shell composition defect', () =>
          failShellProblem(shellInternalProblem()),
        ),
      ),
    )
    .handle('resolveModuleTarget', ({ payload, request }) =>
      Effect.gen(function* resolveModuleTargetHandler() {
        const session = yield* requireAuthenticatedShellContext(request.headers);
        const catalog = yield* captureShellRelease(payload.compositionRevision);
        const governedReads = yield* ShellGovernedReads;
        const correlationId = correlationFromRequest(request);
        const response = yield* governedReads
          .moduleTarget({
            ...payload,
            // The captured release: the pinned one when the caller sent it, otherwise the current one.
            compositionRevision: catalog.composition.revision,
            correlationId,
            principal: session.principal,
          })
          .pipe(
            Effect.provideService(CapturedShellCompositionCatalog, catalog),
            Effect.tapError((error) => logShellReadFailure('module_target', request, error)),
            Effect.catch((error) => pipe(error, shellReadProblem, failShellProblem)),
          );
        return yield* decodeResponse(ResolvedModuleTargetSchema, response, shellInternalProblem);
      }).pipe(
        withRequestPermissionDecisions,
        recoverUnexpectedDefect(request, 'Unexpected module target defect', () =>
          failShellProblem(shellInternalProblem()),
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
        const session = yield* requireShellSession(request.headers);
        const catalog = yield* captureShellRelease(payload.compositionRevision);
        const governedReads = yield* ShellGovernedReads;
        const response = yield* governedReads
          .search({
            correlationId: correlationFromRequest(request),
            principal: session.principal,
            ...payload,
          })
          .pipe(
            Effect.provideService(CapturedShellCompositionCatalog, catalog),
            Effect.catch((error) => pipe(error, shellListReadProblem, failShellProblem)),
          );
        return yield* decodeResponse(ShellSearchResponseSchema, response, shellInternalProblem);
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell search defect', () =>
          failShellProblem(shellInternalProblem()),
        ),
      ),
    )
    .handle('resourceDetail', ({ payload, request }) =>
      Effect.gen(function* resourceDetailHandler() {
        const session = yield* requireAuthenticatedShellContext(request.headers);
        const { compositionRevision, ...ref } = payload;
        const catalog = yield* captureShellRelease(compositionRevision);
        const governedReads = yield* ShellGovernedReads;
        const response = yield* governedReads
          .resourceDetail({
            correlationId: correlationFromRequest(request),
            principal: session.principal,
            ref,
          })
          .pipe(
            Effect.provideService(CapturedShellCompositionCatalog, catalog),
            Effect.catch((error) => pipe(error, shellReadProblem, failShellProblem)),
          );
        return yield* decodeResponse(ShellResourceResponseSchema, response, shellInternalProblem);
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell resource-detail defect', () =>
          failShellProblem(shellInternalProblem()),
        ),
      ),
    )
    .handle('attachMedia', ({ payload, request }) =>
      Effect.gen(function* attachMediaHandler() {
        const session = yield* requireAuthenticatedShellContext(request.headers);
        const { compositionRevision, ...ref } = payload;
        const catalog = yield* captureShellRelease(compositionRevision);
        const resolution = yield* attachShellMedia(
          {
            ...session.principal,
            correlationId: correlationFromRequest(request),
            legalEntityId: session.identity.legalEntityId,
          },
          ref,
        ).pipe(Effect.provideService(CapturedShellCompositionCatalog, catalog));
        return yield* Match.value(resolution).pipe(
          Match.discriminators('outcome')({
            forbidden: mediaAttachmentForbidden,
            not_found: mediaAttachmentNotFound,
            resolved: mediaAttachmentResolved,
            unavailable: mediaAttachmentUnavailable,
          }),
          Match.exhaustive,
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell media-attachment defect', () =>
          failShellProblem(shellInternalProblem()),
        ),
      ),
    ),
);

const identityGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'identity', (handlers) => {
  const authenticated = Effect.fn('shell.identity.authenticated')((request: RequestWithHeaders) =>
    Effect.gen(function* authenticatedIdentity() {
      const authentication = yield* AuthenticationService;
      const resolved = yield* authentication
        .resolveTenantContext(requestHeaders(request.headers))
        .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
      yield* forwardSetCookieHeaders(resolved.setCookieHeaders);
      if (resolved.state !== 'authenticated') {
        return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
      }
      return resolved;
    }),
  );
  const requiredIdempotencyKey = (headers: RequestHeaders) => {
    const value = headerValue(headers, 'idempotency-key');
    return value === undefined ? failIdentityProblem(shellPreconditionRequiredProblem()) : Effect.succeed(value);
  };
  const safeIdentity = <Value, Error, Requirements>(
    request: RequestWithHeaders,
    effect: Effect.Effect<Value, Error, Requirements>,
  ) =>
    effect.pipe(
      recoverUnexpectedDefect(request, 'Unexpected Shell identity defect', () =>
        failIdentityProblem(shellInternalProblem()),
      ),
    );
  const keyIssuanceResponse = <Value extends object, Requirements>(
    effect: Effect.Effect<Value, IdentityLifecycleError, Requirements>,
  ) =>
    Effect.matchEffect(
      Effect.tap(effect, () => noStore),
      {
        onFailure: (error) => pipe(error, identityProblem, failIdentityProblem),
        onSuccess: (response) => decodeResponse(ApiKeyIssueResponseSchema, response, shellInternalProblem),
      },
    );
  const demoAccountCaller = Effect.fn('shell.identity.demoAccountCaller')(function* demoAccountCaller(
    request: RequestWithHeaders,
  ) {
    const authentication = yield* AuthenticationService;
    const session = yield* authentication
      .resolveShellContext(requestHeaders(request.headers))
      .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
    yield* forwardSetCookieHeaders(session.setCookieHeaders);
    if (session.state !== 'authenticated') {
      return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
    }
    const { legalEntityId } = session.identity;
    return {
      legalName:
        session.availableLegalEntities.find((entry) => entry.legalEntityId === legalEntityId)?.legalName ??
        legalEntityId,
      principal: { ...session.principal, legalEntityId },
    };
  });
  const mutationContext = Effect.fn('shell.identity.mutationContext')(function* mutationContext(
    request: RequestWithHeaders,
    headers: RequestHeaders,
    managedScope?: 'company-agent' | 'tenant-managed',
  ) {
    const resolved =
      managedScope === 'company-agent' ? yield* demoAccountCaller(request) : yield* authenticated(request);
    const idempotencyKey = yield* requiredIdempotencyKey(headers);
    const service = yield* IdentityLifecycle;
    return {
      context: {
        correlationId: correlationFromRequest(request),
        idempotencyKey,
        principal: resolved.principal,
      },
      service,
    };
  });
  return handlers
    .handle('configureDemoCompanies', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* configureDemoCompaniesHandler() {
          const { context, service } = yield* mutationContext(request, headers);
          const response = yield* service
            .configureDemoCompanies({ ...context, payload })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ConfigureDemoCompaniesResponseSchema, response, shellInternalProblem);
        }),
      ),
    )
    .handle('demoAccountCapability', ({ request }) =>
      safeIdentity(
        request,
        Effect.gen(function* demoAccountCapabilityHandler() {
          const caller = yield* demoAccountCaller(request);
          const response = yield* demoAccountCapability(caller);
          yield* noStore;
          return yield* decodeResponse(DemoAccountCapabilitySchema, response, shellInternalProblem);
        }),
      ),
    )
    .handle('createNonHumanPrincipal', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* createNonHumanPrincipalHandler() {
          const { context, service } = yield* mutationContext(request, headers);
          const response = yield* service
            .createNonHumanPrincipal({
              ...context,
              payload,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(PrincipalMutationResponseSchema, response, shellInternalProblem);
        }),
      ),
    )
    .handle('changePrincipalStatus', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* changePrincipalStatusHandler() {
          const { context, service } = yield* mutationContext(request, headers);
          const result = yield* service
            .changePrincipalStatus({
              ...context,
              payload,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(
            PrincipalMutationResponseSchema,
            { status: result.status },
            shellInternalProblem,
          );
        }),
      ),
    )
    .handle('issueSelfApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* issueSelfApiKeyHandler() {
          const { context, service } = yield* mutationContext(request, headers);
          return yield* service
            .issue(
              withOptionalProperty(context, payload.name !== undefined, 'name', payload.name, {
                requestHeaders: requestHeaders(request.headers),
              }),
            )
            .pipe(keyIssuanceResponse);
        }),
      ),
    )
    .handle('listSelfApiKeys', ({ payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* listSelfApiKeysHandler() {
          const resolved = yield* authenticated(request);
          const runtime = yield* ReadRuntime;
          const keys = yield* ApiKeyService;
          const resolver = yield* PrincipalResolver;
          const result = yield* runtime
            .runRead({
              input: payload,
              principal: resolved.principal,
              registration: selfApiKeyBindingsRead,
              transport: { correlationId: correlationFromRequest(request) },
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          const items = yield* Effect.forEach(
            result.items,
            (binding) =>
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
                  Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
                ),
            { concurrency: 1 },
          );
          return yield* decodeResponse(
            SelfApiKeyListResponseSchema,
            { items, nextOffset: Option.getOrNull(result.nextOffset) },
            shellInternalProblem,
          );
        }),
      ),
    )
    .handle('issueManagedApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* issueManagedApiKeyHandler() {
          const { context, service } = yield* mutationContext(request, headers, payload.scope);
          return yield* service
            .issue(
              withOptionalProperty(
                {
                  ...context,
                  managedPrincipalId: payload.principalId,
                  managedScope: payload.scope,
                },
                payload.name !== undefined,
                'name',
                payload.name,
                {
                  requestHeaders: requestHeaders(request.headers),
                },
              ),
            )
            .pipe(keyIssuanceResponse);
        }),
      ),
    )
    .handle('listManagedApiKeys', ({ payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* listManagedApiKeysHandler() {
          const resolved =
            payload.scope === 'company-agent' ? yield* demoAccountCaller(request) : yield* authenticated(request);
          const runtime = yield* ReadRuntime;
          const keys = yield* ApiKeyService;
          const resolver = yield* PrincipalResolver;
          const result = yield* runtime
            .runRead({
              input: payload,
              principal: resolved.principal,
              registration: managedPrincipalsRead,
              transport: { correlationId: correlationFromRequest(request) },
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          const items = yield* Effect.forEach(
            result.items,
            Effect.fn(function* loadManagedApiKey(item) {
              const authBindingId = Option.getOrNull(item.authBindingId);
              if (authBindingId === null) {
                const withoutKey = {
                  displayName: item.displayName,
                  key: null,
                  kind: item.kind,
                  principalId: item.principalId,
                  principalStatus: item.principalStatus,
                };
                return withoutKey;
              }
              return yield* resolver
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
                  Effect.map(({ bindingState, metadata }) => ({
                    displayName: item.displayName,
                    key: {
                      authBindingId,
                      bindingStatus: bindingState.status,
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
                  })),
                  Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
                );
            }),
            { concurrency: 1 },
          );
          return yield* decodeResponse(
            ManagedApiKeyListResponseSchema,
            { items, nextOffset: Option.getOrNull(result.nextOffset) },
            shellInternalProblem,
          );
        }),
      ),
    )
    .handle('setSelfApiKeyStatus', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* setSelfKeyHandler() {
          const { context, service } = yield* mutationContext(request, headers);
          const response = yield* service
            .setStatus({
              ...payload,
              ...context,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ApiKeyLifecycleResponseSchema, response, shellInternalProblem);
        }),
      ),
    )
    .handle('setManagedApiKeyStatus', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* setManagedKeyHandler() {
          const { context, service } = yield* mutationContext(request, headers, payload.scope);
          const { principalId, scope, ...statusPayload } = payload;
          const response = yield* service
            .setStatus({
              ...statusPayload,
              ...context,
              managedPrincipalId: principalId,
              managedScope: scope,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ApiKeyLifecycleResponseSchema, response, shellInternalProblem);
        }),
      ),
    )
    .handle('rotateSelfApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* rotateSelfKeyHandler() {
          const { context, service } = yield* mutationContext(request, headers);
          return yield* service
            .rotate(
              withOptionalProperty(context, payload.name !== undefined, 'name', payload.name, {
                oldAuthBindingId: payload.oldAuthBindingId,
                reason: payload.reason,
                requestHeaders: requestHeaders(request.headers),
              }),
            )
            .pipe(keyIssuanceResponse);
        }),
      ),
    )
    .handle('rotateManagedApiKey', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* rotateManagedKeyHandler() {
          const { context, service } = yield* mutationContext(request, headers, payload.scope);
          return yield* service
            .rotate(
              withOptionalProperty(
                {
                  ...context,
                  managedPrincipalId: payload.principalId,
                  managedScope: payload.scope,
                },
                payload.name !== undefined,
                'name',
                payload.name,
                {
                  oldAuthBindingId: payload.oldAuthBindingId,
                  oldManagedPrincipalId: payload.principalId,
                  reason: payload.reason,
                  requestHeaders: requestHeaders(request.headers),
                },
              ),
            )
            .pipe(keyIssuanceResponse);
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
              idempotencyKey,
              reason: payload.reason,
              requestHeaders: requestHeaders(request.headers),
              targetPrincipalId: payload.targetPrincipalId,
            })
            .pipe(
              Effect.provideService(SupportImpersonationCorrelationId, correlationFromRequest(request)),
              Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
            );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return yield* decodeResponse(
            SupportImpersonationResponseSchema,
            {
              active: result.active,
              targetPrincipalId: result.targetPrincipalId,
            },
            shellInternalProblem,
          );
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
              idempotencyKey,
              requestHeaders: requestHeaders(request.headers),
            })
            .pipe(
              Effect.provideService(SupportImpersonationCorrelationId, correlationFromRequest(request)),
              Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
            );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          if (result.checkpointPending) {
            return yield* failIdentityProblem(shellCapabilityUnavailableProblem());
          }
          return yield* decodeResponse(
            SupportImpersonationResponseSchema,
            { active: result.active },
            shellInternalProblem,
          );
        }),
      ),
    );
});

const withGatewayTimings = Effect.fn('ShellGateway.withTimings')(function* withGatewayTimingsEffect<
  Value,
  Failure,
  Requirements,
>(effect: Effect.Effect<Value, Failure, Requirements>) {
  const collector = yield* gatewayTimingCollector;
  yield* collector.appendResponseHeader;
  return yield* effect.pipe(Effect.provideService(GatewayTimings, Option.some(collector.timings)));
});

const requireGatewayRelease = Effect.fn('ShellGateway.requireRelease')(function* requireGatewayReleaseEffect(
  compositionRevision: string | undefined,
) {
  const authority = yield* ShellInstalledModuleCatalog;
  const catalog = yield* authority.load.pipe(
    observeGatewayPhase('gateway-release'),
    Effect.catchTags({
      InstalledModuleCatalogInvalidError: () => failGatewayProblem(gatewayAuthenticationUnavailableProblem()),
      InstalledModuleCatalogUnavailableError: () => failGatewayProblem(gatewayAuthenticationUnavailableProblem()),
    }),
  );
  if (
    (compositionRevision !== undefined && compositionRevision !== catalog.composition.revision) ||
    catalog.composition.shell.deployment.appId !== ultramodernDeliveryUnit.appId ||
    catalog.composition.shell.deployment.buildMarker !== ultramodernDeliveryUnit.buildMarker
  ) {
    return yield* failGatewayProblem(
      extendedProblemDetails(
        'GatewayReloadRequiredProblem',
        'The document release is no longer admitted. Reload to continue.',
        409,
        'Reload required',
        'https://ontos.dev/problems/gateway-reload-required',
        { reloadRequired: true as const },
      ),
    );
  }
  return catalog.composition.revision;
});

const issueApiKeyContext = Effect.fn('ShellGateway.issueApiKeyContext')(function* issueApiKeyContextEffect(
  payload: ApiKeyGatewayContextRequest,
  rawKey: string | undefined,
  request: RequestWithHeaders,
) {
  const compositionRevision = yield* requireGatewayRelease(payload.compositionRevision);
  const keys = yield* ApiKeyService;
  const resolver = yield* PrincipalResolver;
  if (rawKey === undefined || rawKey.trim().length === 0) {
    return yield* failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem());
  }
  const verified = yield* keys.verify(rawKey).pipe(
    observeGatewayPhase('key-verify'),
    Effect.catch((error) => failApiKeyGatewayProblem(apiKeyProviderGatewayProblem(error))),
  );
  const identity = yield* resolver.resolveBetterAuthApiKey(verified.providerKeyId).pipe(
    observeGatewayPhase('principal-resolve'),
    Effect.catch((error) => pipe(error, principalResolutionGatewayProblem, failApiKeyGatewayProblem)),
  );
  let legalEntityId: string | undefined;
  if (payload.legalEntityId !== undefined) {
    const selected = yield* validateAuthorizedLegalEntity({
      legalEntityId: payload.legalEntityId,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    }).pipe(
      Effect.catch((error) =>
        failApiKeyGatewayProblem(
          Predicate.isTagged(error, 'LegalEntitySelectionUnavailableError')
            ? gatewayAuthorizationUnavailableProblem()
            : gatewayForbiddenProblem(),
        ),
      ),
    );
    ({ legalEntityId } = selected);
  }
  const principal = withOptionalProperty(
    {
      authBindingId: identity.authBindingId,
      authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      authMethod: 'api_key' as const,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    },
    legalEntityId !== undefined,
    'legalEntityId',
    legalEntityId,
    {},
  );
  const scopeResolver = yield* OperationalScopeResolver;
  yield* scopeResolver
    .resolve({
      correlationId: crypto.randomUUID(),
      legalEntityScope: 'optional',
      principal,
    })
    .pipe(
      Effect.catch((error) =>
        failApiKeyGatewayProblem(
          Predicate.isTagged(error, 'OperationContextUnavailable')
            ? gatewayAuthorizationUnavailableProblem()
            : gatewayForbiddenProblem(),
        ),
      ),
    );
  return yield* issueGatewayContextAssertion({
    audience: payload.audience,
    compositionRevision,
    principal,
  }).pipe(
    observeGatewayPhase('assertion-issue'),
    Effect.tapError((error) => logGatewayIssuerFailure('api_key', request, error)),
    Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)),
  );
});

const gatewayContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'gatewayContext', (handlers) =>
  handlers
    .handle('issueGatewayContext', ({ payload, request }) =>
      Effect.gen(function* issueGatewayContextHandler() {
        yield* noStore;
        yield* requireGatewayRelease(payload.compositionRevision);
        const authentication = yield* AuthenticationService;
        const sessionResult = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, gatewayAuthenticationProblem, failGatewayProblem)));
        yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
        if (sessionResult.state !== 'authenticated' && sessionResult.state !== 'tenant_authenticated') {
          return yield* failGatewayProblem(gatewayAuthenticationRequiredProblem());
        }
        if (payload.legalEntityId !== undefined && payload.legalEntityId !== sessionResult.principal.legalEntityId) {
          return yield* failGatewayProblem(gatewayForbiddenProblem());
        }

        return yield* issueGatewayContextAssertion({
          audience: payload.audience,
          compositionRevision: payload.compositionRevision,
          principal: sessionResult.principal,
        }).pipe(
          observeGatewayPhase('assertion-issue'),
          Effect.tapError((error) => logGatewayIssuerFailure('session', request, error)),
          Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)),
        );
      }).pipe(
        withGatewayTimings,
        recoverUnexpectedDefect(request, 'Unexpected Shell gateway assertion defect', () =>
          failGatewayProblem(gatewayInternalProblem()),
        ),
      ),
    )
    .handle('issueApiKeyGatewayContext', ({ headers, payload, request }) =>
      Effect.gen(function* issueApiKeyGatewayContextHandler() {
        yield* noStore;
        return yield* issueApiKeyContext(payload, headers['x-api-key'], request);
      }).pipe(
        withGatewayTimings,
        recoverUnexpectedDefect(request, 'Unexpected API-key gateway assertion defect', () =>
          failGatewayProblem(gatewayInternalProblem()),
        ),
      ),
    )
    .handle('readWithApiKeyGatewayContext', ({ headers, payload, request }) =>
      Effect.gen(function* readWithApiKeyGatewayContextHandler() {
        yield* noStore;
        const context = yield* issueApiKeyContext(payload, headers['x-api-key'], request);
        const prefix = '/shell-super-app-api/module-api/';
        if (!context.apiBaseUrl.startsWith(prefix)) {
          return yield* failGatewayProblem(
            problemDetails(
              'GatewayAudienceInvalidProblem',
              'The requested audience is not an available MicroVertical.',
              400,
              'Invalid gateway audience',
              'https://ontos.dev/problems/gateway-audience-invalid',
            ),
          );
        }
        // Dispatch in-process, through the very same composition/release admission and owner transport.
        // Never forward the API key, cookies or arbitrary caller headers to the owner.
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload.query).pipe(
          Effect.orDie,
        );
        const encodedContext = yield* Schema.encodeEffect(Schema.fromJsonString(GatewayContextResponseSchema))(
          context,
        ).pipe(Effect.orDie);
        const ownerRequest = new Request(
          `https://shell.invalid${context.apiBaseUrl.slice('/shell-super-app-api'.length)}/reads/${encodeURIComponent(payload.readName)}`,
          {
            body,
            headers: {
              authorization: `Bearer ${context.token}`,
              'content-type': 'application/json',
              'x-correlation-id': correlationFromRequest(request),
              'x-ontos-composition-revision': context.compositionRevision,
            },
            method: 'POST',
          },
        );
        const response = yield* dispatchModuleApiRequest(ownerRequest).pipe(
          observeGatewayPhase('owner-dispatch'),
          Effect.catch((error) =>
            Effect.succeed(
              Response.json(
                { code: 'gateway_dispatch_failed' },
                { status: Predicate.isTagged(error, 'ModuleApiDispatchError') ? error.status : 503 },
              ),
            ),
          ),
        );
        // The receiving runtime still redeems the assertion and rechecks principal/binding status,
        // tenant/legal-entity scope and operation authorization. No authorization result is cached here.
        return HttpServerResponse.fromWeb(response).pipe(
          HttpServerResponse.setHeader(API_KEY_GATEWAY_CONTEXT_HEADER, encodedContext),
          noStoreResponse,
        );
      }).pipe(
        withGatewayTimings,
        recoverUnexpectedDefect(request, 'Unexpected API-key gateway read defect', () =>
          failGatewayProblem(gatewayInternalProblem()),
        ),
      ),
    ),
);

// One session issuance for every module audience of a Shell document a browser navigation needs: one release check and
// one session read, then the document assertions of `issueDocumentGatewayAssertions`.
const documentGatewayGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'documentGateway', (handlers) =>
  handlers.handle('issueDocumentGatewayContexts', ({ payload, request }) =>
    Effect.gen(function* issueDocumentGatewayContextsHandler() {
      yield* noStore;
      yield* requireGatewayRelease(payload.compositionRevision);
      const authentication = yield* AuthenticationService;
      const sessionResult = yield* authentication
        .resolveShellContext(requestHeaders(request.headers))
        .pipe(Effect.catch((error) => pipe(error, gatewayAuthenticationProblem, failGatewayProblem)));
      yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
      if (sessionResult.state !== 'authenticated' && sessionResult.state !== 'tenant_authenticated') {
        return yield* failGatewayProblem(gatewayAuthenticationRequiredProblem());
      }
      const assertions = yield* issueDocumentGatewayAssertions(
        sessionResult.principal,
        payload.compositionRevision,
        payload.audiences,
      ).pipe(
        observeGatewayPhase('assertion-issue'),
        Effect.tapError((error) => logGatewayIssuerFailure('session', request, error)),
        Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)),
      );
      return { assertions };
    }).pipe(
      withGatewayTimings,
      recoverUnexpectedDefect(request, 'Unexpected Shell document gateway assertions defect', () =>
        failGatewayProblem(gatewayInternalProblem()),
      ),
    ),
  ),
);

// Platform approval layer for AI agents (lane approvals-platform). Agents use their API key; people their session.
const agentPlatformFailure = (error: AgentPlatformForbidden | AgentPlatformInvalid | AgentStoreUnavailable) => {
  switch (error._tag) {
    case 'AgentPlatformForbidden': {
      return failIdentityProblem(
        problemDetails(
          'ShellTargetForbiddenProblem',
          error.reason,
          403,
          'Module target forbidden',
          'https://ontos.dev/problems/module-target-forbidden',
        ),
      );
    }
    case 'AgentPlatformInvalid': {
      return failIdentityProblem(
        problemDetails(
          'ShellPolicyUnprocessableProblem',
          error.reason,
          422,
          'Policy violation',
          'https://ontos.dev/problems/policy-violation',
        ),
      );
    }
    default: {
      return failIdentityProblem(shellCapabilityUnavailableProblem());
    }
  }
};

const agentPlatformSessionCaller = Effect.fn('shell.agentPlatform.sessionCaller')(function* agentPlatformSessionCaller(
  request: RequestWithHeaders,
) {
  const authentication = yield* AuthenticationService;
  const session = yield* authentication
    .resolveShellContext(requestHeaders(request.headers))
    .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
  yield* forwardSetCookieHeaders(session.setCookieHeaders);
  if (session.state !== 'authenticated') {
    return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
  }
  const { legalEntityId } = session.identity;
  const caller: AgentPlatformCaller = {
    legalName:
      session.availableLegalEntities.find((entry) => entry.legalEntityId === legalEntityId)?.legalName ?? legalEntityId,
    principal: { ...session.principal, legalEntityId },
  };
  return caller;
});

const agentPlatformKeyCaller = Effect.fn('shell.agentPlatform.keyCaller')(function* agentPlatformKeyCaller(
  rawKey: string | undefined,
  legalEntityId: string,
) {
  if (rawKey === undefined || rawKey.trim().length === 0) {
    return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
  }
  const keys = yield* ApiKeyService;
  const resolver = yield* PrincipalResolver;
  const verified = yield* keys
    .verify(rawKey)
    .pipe(Effect.catch(() => failIdentityProblem(shellAuthenticationRequiredProblem())));
  const identity = yield* resolver
    .resolveBetterAuthApiKey(verified.providerKeyId)
    .pipe(Effect.catch(() => failIdentityProblem(shellAuthenticationRequiredProblem())));
  const selected = yield* validateAuthorizedLegalEntity({
    legalEntityId,
    principalId: identity.principalId,
    tenantId: identity.tenantId,
  }).pipe(Effect.catch(() => failIdentityProblem(shellTargetForbiddenProblem())));
  const caller: AgentPlatformCaller = {
    legalName: selected.legalName,
    principal: {
      authBindingId: identity.authBindingId,
      authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      authMethod: 'api_key' as const,
      legalEntityId: selected.legalEntityId,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    },
  };
  const scopeResolver = yield* OperationalScopeResolver;
  yield* scopeResolver
    .resolve({
      correlationId: crypto.randomUUID(),
      legalEntityScope: 'required',
      principal: caller.principal,
    })
    .pipe(
      Effect.catch((error) =>
        failIdentityProblem(
          Predicate.isTagged(error, 'OperationContextUnavailable')
            ? shellCapabilityUnavailableProblem()
            : shellTargetForbiddenProblem(),
        ),
      ),
    );
  return caller;
});

const agentPlatformDefect = (request: RequestWithHeaders) =>
  recoverUnexpectedDefect(request, 'Unexpected agent platform defect', () =>
    failIdentityProblem(shellInternalProblem()),
  );

const agentPlatformGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'agentPlatform', (handlers) =>
  handlers
    .handle('submitAgentProposals', ({ headers, payload, request }) =>
      Effect.gen(function* submitAgentProposalsHandler() {
        const agent = yield* agentPlatformKeyCaller(headers['x-api-key'], payload.legalEntityId);
        // An API-key agent is always shown under its own principal name; only MCP connections name the acting party.
        const { agentLabel: _agentLabel, ...submission } = payload;
        const response = yield* submitAgentProposals(agent, submission).pipe(Effect.catch(agentPlatformFailure));
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('listOwnAgentProposals', ({ headers, payload, request }) =>
      Effect.gen(function* listOwnAgentProposalsHandler() {
        const agent = yield* agentPlatformKeyCaller(headers['x-api-key'], payload.legalEntityId);
        const response = yield* listOwnAgentBatches(agent).pipe(Effect.catch(agentPlatformFailure));
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentQueue', ({ payload, request }) =>
      Effect.gen(function* agentQueueHandler() {
        const caller = yield* agentPlatformSessionCaller(request);
        const response = yield* loadAgentQueue(caller, payload).pipe(Effect.catch(agentPlatformFailure));
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentDecide', ({ payload, request }) =>
      Effect.gen(function* agentDecideHandler() {
        const caller = yield* agentPlatformSessionCaller(request);
        const response = yield* decideAgentItems(caller, payload).pipe(Effect.catch(agentPlatformFailure));
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentRevert', ({ payload, request }) =>
      Effect.gen(function* agentRevertHandler() {
        const caller = yield* agentPlatformSessionCaller(request);
        const response = yield* revertAgentBatch(caller, payload).pipe(Effect.catch(agentPlatformFailure));
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentActivity', ({ payload, request }) =>
      Effect.gen(function* agentActivityHandler() {
        const caller = yield* agentPlatformSessionCaller(request);
        const response = yield* loadAgentActivity(caller, payload).pipe(Effect.catch(agentPlatformFailure));
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    ),
);

/** Error tags and messages down the (often non-enumerable) `cause` chain, for operator logs. */
const causeChain = (cause: unknown): string[] => {
  const chain: string[] = [];
  let current: unknown = cause;
  while (current !== undefined && current !== null && chain.length < 6) {
    const tag: unknown = Predicate.isObject(current) ? Reflect.get(current, '_tag') : undefined;
    const message: unknown = Predicate.isObject(current) ? Reflect.get(current, 'message') : current;
    chain.push(`${typeof tag === 'string' ? tag : 'Error'}: ${String(message).slice(0, 300)}`);
    current = Predicate.isObject(current) ? Reflect.get(current, 'cause') : undefined;
  }
  return chain;
};

// "Připojené aplikace" management (lane mcp-connections-ui): session callers; grants via connection-grants services.
const connectionsAdminFailure = (error: ConnectionsAdminError) => {
  switch (error._tag) {
    case 'ConnectionsForbidden': {
      return failIdentityProblem(
        problemDetails(
          'ShellTargetForbiddenProblem',
          error.reason,
          403,
          'Module target forbidden',
          'https://ontos.dev/problems/module-target-forbidden',
        ),
      );
    }
    case 'ConnectionsInvalid': {
      return failIdentityProblem(
        problemDetails(
          'ShellPolicyUnprocessableProblem',
          error.reason,
          422,
          'Policy violation',
          'https://ontos.dev/problems/policy-violation',
        ),
      );
    }
    case 'ConnectionsGone': {
      return failIdentityProblem(
        problemDetails(
          'ShellPolicyConflictProblem',
          error.reason,
          409,
          'Policy conflict',
          'https://ontos.dev/problems/policy-conflict',
        ),
      );
    }
    case 'ConnectionsNotFound': {
      return failIdentityProblem(
        problemDetails(
          'ShellTargetNotFoundProblem',
          error.reason,
          404,
          'Target not found',
          'https://ontos.dev/problems/target-not-found',
        ),
      );
    }
    default: {
      // Unavailability is retryable for the caller, but the operator needs the underlying cause.
      return Effect.logWarning('Connections administration unavailable', causeChain(error.cause)).pipe(
        Effect.andThen(failIdentityProblem(shellCapabilityUnavailableProblem())),
      );
    }
  }
};

const connectionsCaller = Effect.fn('shell.connectionsAdmin.caller')(function* connectionsCaller(
  request: RequestWithHeaders,
  withAdminRight: boolean,
) {
  const caller = yield* agentPlatformSessionCaller(request);
  const isCompanyAdmin = withAdminRight
    ? yield* demoAccountCapability(caller).pipe(
        Effect.map((capability) => capability.canManage),
        Effect.orElseSucceed(() => false),
      )
    : false;
  const result: ConnectionsCaller = {
    isCompanyAdmin,
    legalEntityId: caller.principal.legalEntityId,
    legalName: caller.legalName,
    principalId: caller.principal.principalId,
    tenantId: caller.principal.tenantId,
  };
  return result;
});

/** CSRF defense in depth for the session mutations: refuse a cross-site `Origin` (design §3.4, like connect POSTs). */
const requireShellOrigin = Effect.fn('shell.connectionsAdmin.requireShellOrigin')(function* requireShellOrigin(
  request: RequestWithHeaders,
) {
  const config = yield* loadOAuthServerConfig;
  const issuerOrigin = URL.canParse(config.issuer) ? new URL(config.issuer).origin : '';
  if (!isSameOriginRequest(request.headers, issuerOrigin)) {
    return yield* failIdentityProblem(
      problemDetails(
        'ShellTargetForbiddenProblem',
        'Žádost nepřišla z OntOS. Otevřete Připojené aplikace v OntOS a zkuste to znovu.',
        403,
        'Module target forbidden',
        'https://ontos.dev/problems/module-target-forbidden',
      ),
    );
  }
});

const connectionsAdminDefect = (request: RequestWithHeaders) =>
  recoverUnexpectedDefect(request, 'Unexpected connections admin defect', () =>
    failIdentityProblem(shellInternalProblem()),
  );

const peopleAdministrationGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'peopleAdministration',
  (handlers) => {
    const principalFor = (request: RequestWithHeaders, scope: 'company' | 'tenant') =>
      Effect.gen(function* peoplePrincipal() {
        yield* noStore;
        const authentication = yield* AuthenticationService;
        if (scope === 'company') {
          const session = yield* authentication
            .resolveShellContext(requestHeaders(request.headers))
            .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
          yield* forwardSetCookieHeaders(session.setCookieHeaders);
          if (session.state !== 'authenticated') {
            return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
          }
          return { ...session.principal, legalEntityId: session.identity.legalEntityId };
        }
        const session = yield* authentication
          .resolveTenantContext(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
        yield* forwardSetCookieHeaders(session.setCookieHeaders);
        if (session.state !== 'authenticated') {
          return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
        }
        // Explicit tenant endpoint: never let a selected company leak into a tenant role's scope.
        const { legalEntityId: _selectedCompany, ...principal } = session.principal;
        return principal;
      });
    const commandContext = (request: RequestWithHeaders, headers: RequestHeaders, scope: 'company' | 'tenant') =>
      Effect.gen(function* peopleCommandContext() {
        yield* requireShellOrigin(request);
        const idempotencyKey = headerValue(headers, 'idempotency-key');
        if (idempotencyKey === undefined) {
          return yield* failIdentityProblem(shellPreconditionRequiredProblem());
        }
        const principal = yield* principalFor(request, scope);
        return { principal, transport: { correlationId: correlationFromRequest(request), idempotencyKey } };
      });
    const failure = (error: IdentityRuntimeError | Schema.SchemaError) =>
      Schema.isSchemaError(error)
        ? failIdentityProblem(shellInternalProblem())
        : failIdentityProblem(identityProblem(error));
    return handlers
      .handle('invitePerson', ({ headers, payload, request }) =>
        Effect.gen(function* invitePersonHandler() {
          const context = yield* commandContext(request, headers, 'company');
          const result = yield* invitePeoplePerson(context, payload).pipe(Effect.catch(failure));
          return yield* decodeResponse(InvitePeopleResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listCompanyRoleCatalog', ({ request }) =>
        Effect.gen(function* listCompanyRoleCatalogHandler() {
          const principal = yield* principalFor(request, 'company');
          const result = yield* listPeopleRoleCatalog(principal, correlationFromRequest(request)).pipe(
            Effect.catch(failure),
          );
          return yield* decodeResponse(PeopleRoleCatalogSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listTenantRoleCatalog', ({ request }) =>
        Effect.gen(function* listTenantRoleCatalogHandler() {
          const principal = yield* principalFor(request, 'tenant');
          const result = yield* listPeopleRoleCatalog(principal, correlationFromRequest(request)).pipe(
            Effect.catch(failure),
          );
          return yield* decodeResponse(PeopleRoleCatalogSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listCompanyPeople', ({ payload, request }) =>
        Effect.gen(function* listCompanyPeopleHandler() {
          const principal = yield* principalFor(request, 'company');
          const result = yield* listPeople(principal, payload, correlationFromRequest(request)).pipe(
            Effect.catch(failure),
          );
          return yield* decodeResponse(PeopleListResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listTenantPeople', ({ payload, request }) =>
        Effect.gen(function* listTenantPeopleHandler() {
          const principal = yield* principalFor(request, 'tenant');
          const result = yield* listPeople(principal, payload, correlationFromRequest(request)).pipe(
            Effect.catch(failure),
          );
          return yield* decodeResponse(PeopleListResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('setPeopleCompanyMembership', ({ headers, payload, request }) =>
        Effect.gen(function* setCompanyMembershipHandler() {
          const context = yield* commandContext(request, headers, 'company');
          const result = yield* setPeopleCompanyMembership(context, payload).pipe(Effect.catch(failure));
          return yield* decodeResponse(SetPeopleCompanyMembershipResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('setPeopleCompanyRole', ({ headers, payload, request }) =>
        Effect.gen(function* setCompanyRoleHandler() {
          const context = yield* commandContext(request, headers, 'company');
          const result = yield* setPeopleScopedRole(context, payload).pipe(Effect.catch(failure));
          return yield* decodeResponse(SetPeopleRoleResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('setPeopleTenantRole', ({ headers, payload, request }) =>
        Effect.gen(function* setTenantRoleHandler() {
          const context = yield* commandContext(request, headers, 'tenant');
          const result = yield* setPeopleScopedRole(context, payload).pipe(Effect.catch(failure));
          return yield* decodeResponse(SetPeopleRoleResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      );
  },
);

const connectionsAdminDeps = Effect.map(mcpResourceUrl, (mcpUrl) => ({
  directory: companyDirectoryLive,
  grants: grantAdminPortLive,
  mcpUrl,
}));

const oauthConnectionsAdminGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'oauthConnectionsAdmin',
  (handlers) =>
    handlers
      .handle('listMyConnections', ({ request }) =>
        Effect.gen(function* listMyConnectionsHandler() {
          yield* noStore;
          const caller = yield* connectionsCaller(request, false);
          const deps = yield* connectionsAdminDeps;
          const response = yield* listMine(caller, deps).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listCompanyConnections', ({ payload, request }) =>
        Effect.gen(function* listCompanyConnectionsHandler() {
          yield* noStore;
          const caller = yield* connectionsCaller(request, true);
          const deps = yield* connectionsAdminDeps;
          const response = yield* listForAdmin(caller, deps, payload).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('updateConnectionAccess', ({ payload, request }) =>
        Effect.gen(function* updateConnectionAccessHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const caller = yield* connectionsCaller(request, false);
          const deps = yield* connectionsAdminDeps;
          const response = yield* updateConnection(caller, deps, payload).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('revokeConnection', ({ payload, request }) =>
        Effect.gen(function* revokeConnectionHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const caller = yield* connectionsCaller(request, true);
          const deps = yield* connectionsAdminDeps;
          const response = yield* revokeConnection(caller, deps, payload).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listAgentEntities', ({ request }) =>
        Effect.gen(function* listAgentEntitiesHandler() {
          yield* noStore;
          const caller = yield* agentPlatformSessionCaller(request);
          const deps = yield* connectionsAdminDeps;
          const response = yield* listAgentEntities(caller, deps).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('manageAgentEntity', ({ headers, payload, request }) =>
        Effect.gen(function* manageAgentEntityHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const idempotencyKey = headers['idempotency-key'];
          if (idempotencyKey === undefined) {
            return yield* failIdentityProblem(shellPreconditionRequiredProblem());
          }
          const caller = yield* agentPlatformSessionCaller(request);
          const deps = yield* connectionsAdminDeps;
          const response = yield* manageAgentEntity(
            caller,
            payload,
            { correlationId: correlationFromRequest(request), idempotencyKey },
            deps,
          ).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('replaceAgentOperators', ({ payload, request }) =>
        Effect.gen(function* replaceAgentOperatorsHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const caller = yield* connectionsCaller(request, true);
          const deps = yield* connectionsAdminDeps;
          const response = yield* replaceAgentOperators(caller, deps, payload).pipe(
            Effect.catch(connectionsAdminFailure),
          );
          return response;
        }).pipe(connectionsAdminDefect(request)),
      ),
);

const corePersistenceLive = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
const defaultContextAccessLive = Layer.mergeAll(ContextAccessLive, StaffAuthenticationNamespaceRegistryLive);
const authPersistenceLive = AuthPersistenceLive.pipe(Layer.provide(AuthConfigLive));
const principalResolverLive = PrincipalResolverLive({
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
}).pipe(Layer.provide(corePersistenceLive));
const legalEntityContextLive = LegalEntityContextLive.pipe(Layer.provide(corePersistenceLive));
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(corePersistenceLive));
const authenticationDependenciesLive = Layer.mergeAll(
  authPersistenceLive,
  defaultContextAccessLive,
  legalEntityContextLive,
  principalResolverLive,
);
// The MCP connection grant's Better Auth hooks (consent reference = grant id, access-token grant claim).
const authenticationServiceLive = AuthenticationServiceLive.pipe(
  Layer.provide(
    Layer.merge(authenticationDependenciesLive, OAuthConnectionHooksLive.pipe(Layer.provide(authPersistenceLive))),
  ),
);
const apiKeyServiceLive = ApiKeyServiceLive.pipe(Layer.provide(authPersistenceLive));
const supportRecoveryPrincipalLive = SupportRecoveryPrincipalContextResolverLive({
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
}).pipe(Layer.provide(corePersistenceLive));

// @ontos-codesmith-core-read-server-groups:start

// @ontos-core-read legal-entity-detail
const coreReadLegalEntityDetailGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'coreReadLegalEntityDetail',
  (handlers) =>
    handlers.handle('executeLegalEntityDetail', ({ payload, request }) =>
      Effect.gen(function* executeLegalEntityDetailCoreRead() {
        const authentication = yield* AuthenticationService;
        const resolved = yield* authentication
          .resolveTenantContext(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
        yield* forwardSetCookieHeaders(resolved.setCookieHeaders);
        if (resolved.state !== 'authenticated') {
          return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
        }
        const runtime = yield* ReadRuntime;
        return yield* runtime
          .runRead({
            input: payload,
            principal: resolved.principal,
            registration: legalEntityDetailRead,
            transport: { correlationId: correlationFromRequest(request) },
          })
          .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell Core read defect', () =>
          failIdentityProblem(shellInternalProblem()),
        ),
      ),
    ),
);
// @ontos-codesmith-core-read-server-groups:end
const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

type ShellAuthenticationLayer = Layer.Layer<AuthenticationService, Layer.Error<typeof authenticationServiceLive>>;
type ShellModuleStateLayer = Layer.Layer<TenantModuleStateService, Layer.Error<typeof tenantModuleStateServiceLive>>;

const compositionHttpClientLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);
const compositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(compositionHttpClientLive));
const activeApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(compositionSourceLive),
);
const approvedModuleCatalogLive = ShellInstalledModuleCatalogLive.pipe(Layer.provide(activeApplicationCompositionLive));
const approvedGatewayIssuerLive = GatewayIssuerLive.pipe(Layer.provide(approvedModuleCatalogLive));

const defaultScopedModuleStateFactory: ShellScopedModuleStateFactory = (transaction) =>
  makeTenantModuleStateService({ executor: transaction });

type ShellAuthenticationApiRuntimeArguments = readonly [
  authenticationLayer: ShellAuthenticationLayer,
  issuerLayer: Layer.Layer<GatewayIssuer>,
  moduleStateLayer?: ShellModuleStateLayer,
  loadInstalledModuleCatalog?: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>,
  enableInstalledOutboxMatcher?: boolean,
  contextAccessLayer?: Layer.Layer<ContextAccess, Layer.Error<typeof defaultContextAccessLive>>,
  resourceGateways?: ShellResourceGateways,
  scopedModuleStateFactory?: ShellScopedModuleStateFactory,
  externalIdentityDeploymentLayer?: ExternalIdentityDeploymentLayer,
];

export const makeShellAuthenticationApiRuntime = (
  ...args: ShellAuthenticationApiRuntimeArguments
): EffectBffDefinition<typeof ShellAuthenticationApi> & EffectBffRuntime<typeof ShellAuthenticationApi> => {
  const [
    authenticationLayer,
    issuerLayer,
    moduleStateLayer = tenantModuleStateServiceLive,
    loadInstalledModuleCatalog,
    enableInstalledOutboxMatcher = false,
    contextAccessLayer = defaultContextAccessLive,
    resourceGateways = unavailableResourceGateways,
    scopedModuleStateFactory = defaultScopedModuleStateFactory,
    externalIdentityDeploymentLayer = ExternalIdentityNotInstalledLive,
  ] = args;
  const moduleCatalogLayer =
    loadInstalledModuleCatalog === undefined
      ? approvedModuleCatalogLive
      : Layer.succeed(ShellInstalledModuleCatalog, {
          load: loadInstalledModuleCatalog,
        });
  const moduleStateGateLayer = ModuleStateGateLive.pipe(Layer.provide(moduleStateLayer));
  const moduleEntrypointGatewayLayer = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLayer));
  const operationalScopeResolverLayer = OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(corePersistenceLive, contextAccessLayer)),
  );
  const sharedOperationLayers = Layer.mergeAll(
    corePersistenceLive,
    contextAccessLayer,
    moduleStateGateLayer,
    moduleEntrypointGatewayLayer,
    operationalScopeResolverLayer,
  );
  const lifecycleDependencies = Layer.mergeAll(
    corePersistenceLive,
    DatabaseConfigLive,
    activeApplicationCompositionLive,
    SpiceDbConfigLive,
  );
  const authorizationLifecycleLayer = ActionAuthorizationLifecycleLive.pipe(
    Layer.provide(
      Layer.merge(lifecycleDependencies, ScopedRoleMembershipLifecycleLive.pipe(Layer.provide(lifecycleDependencies))),
    ),
  );
  const readRuntimeLayer = ReadRuntimeLive.pipe(Layer.provide(sharedOperationLayers));
  const actionRuntimeLayer = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(
      Layer.mergeAll(
        sharedOperationLayers,
        activeApplicationCompositionLive,
        ActionRepositoryLive,
        ActionPermissionLive,
        BetterAuthPersonInvitationIdentityProviderLive,
      ),
    ),
  );
  const identityLifecycleLayer = IdentityLifecycleLive.pipe(
    Layer.provide(Layer.mergeAll(actionRuntimeLayer, apiKeyServiceLive, principalResolverLive)),
  );
  const shellGovernedReadsLayer = Layer.unwrap(
    GatewayIssuer.pipe(
      Effect.map((gatewayIssuer) => {
        const providerAssertionIssuer = {
          issueAssertion: ({
            appId,
            compositionRevision,
            context,
          }: {
            readonly appId: string;
            readonly compositionRevision: string;
            readonly context: ShellResourceContext;
          }) =>
            gatewayIssuer
              .issue({
                audience: appId,
                compositionRevision,
                principal: withOptionalProperty(
                  withOptionalProperty(
                    withOptionalProperty(
                      withOptionalProperty(
                        {
                          authMethod: context.authMethod,
                          principalId: context.principalId,
                          tenantId: context.tenantId,
                        },
                        context.legalEntityId !== undefined,
                        'legalEntityId',
                        context.legalEntityId,
                        {},
                      ),
                      context.authBindingId !== undefined,
                      'authBindingId',
                      context.authBindingId,
                      {},
                    ),
                    context.authContextRef !== undefined,
                    'authContextRef',
                    context.authContextRef,
                    {},
                  ),
                  context.impersonatedByPrincipalId !== undefined,
                  'impersonatedByPrincipalId',
                  context.impersonatedByPrincipalId,
                  {},
                ),
              })
              .pipe(
                Effect.map(({ token }) => `Bearer ${token}`),
                Effect.catchTag('GatewayIssuerError', () => Effect.fail(new ShellProviderUnavailableError())),
              ),
        };
        return createShellGovernedReadsLayer(resourceGateways, providerAssertionIssuer, scopedModuleStateFactory);
      }),
    ),
  ).pipe(
    Layer.provide(issuerLayer),
    Layer.provide(
      Layer.mergeAll(
        readRuntimeLayer,
        moduleStateLayer,
        moduleCatalogLayer,
        contextAccessLayer,
        ShellCompositionFactoryLive,
        ShellResourceServicesFactoryLive,
      ),
    ),
  );
  const supportImpersonationServiceLive = SupportImpersonationServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        authenticationLayer,
        authPersistenceLive,
        actionRuntimeLayer,
        contextAccessLayer,
        principalResolverLive,
        supportRecoveryPrincipalLive,
      ),
    ),
  );
  const outboxMatcherLayer = enableInstalledOutboxMatcher
    ? InstalledOutboxMatcherLive.pipe(
        Layer.provide(OutboxRuntimeLive.pipe(Layer.provide(OutboxRepositoryLive), Layer.provide(corePersistenceLive))),
      )
    : Layer.empty;
  const handlerDependenciesLive = Layer.mergeAll(
    BetterAuthPersonInvitationIdentityProviderLive,
    authenticationLayer,
    authPersistenceLive,
    actionRuntimeLayer,
    apiKeyServiceLive,
    identityLifecycleLayer,
    supportImpersonationServiceLive,
    principalResolverLive,
    operationalScopeResolverLayer,
    authorizationLifecycleLayer,
    legalEntityContextLive,
    issuerLayer,
    moduleStateLayer,
    moduleCatalogLayer,
    contextAccessLayer,
    shellGovernedReadsLayer,
    readRuntimeLayer,
    runtimeObservabilityLive,
    ShellCryptoLive,
    externalIdentityWorkloadAuthorizationLive,
    externalIdentityDeploymentLayer,
    OAuthFlowLive.pipe(Layer.provide(authPersistenceLive)),
  );
  const apiHandlersLive = Layer.mergeAll(
    authenticationGroupLive,
    identityGroupLive,
    tenantGroupLive,
    legalEntityGroupLive,
    compositionGroupLive,
    documentContextGroupLive,
    resourcesGroupLive,
    gatewayContextGroupLive,
    documentGatewayGroupLive,
    oauthConnectGroupLive,
    // @ontos-codesmith-core-read-server-layers:start

    // @ontos-core-read legal-entity-detail
    coreReadLegalEntityDetailGroupLive,
    // @ontos-codesmith-core-read-server-layers:end
    externalIdentityGroupLive,
    oauthConnectionsAdminGroupLive,
    peopleAdministrationGroupLive,
    agentPlatformGroupLive,
  );
  // Workers build these services for each request; handlers and transport routes share that request context.
  const requestServicesLive = outboxMatcherLayer.pipe(
    Layer.provideMerge(handlerDependenciesLive),
    Layer.provideMerge(activeApplicationCompositionLive),
    Layer.provideMerge(compositionSourceLive),
    Layer.provideMerge(ActionAuthorityLive),
    Layer.provideMerge(Reactivity.layer),
    Layer.orDie,
  );

  return assembleEffectBffRuntime({
    api: ShellAuthenticationApi,
    handlers: apiHandlersLive,
    services: requestServicesLive,
    transport: Layer.mergeAll(
      ModuleApiTransportLive,
      EmailTransportLive,
      // Resolves the same per-request authentication service as the handlers, backed by the isolate's Better Auth instance.
      OAuthServerTransportLive,
      InvitationTransportLive,
      // The MCP endpoint runs tools as the connection's principal, with the agent platform's request services.
      McpTransportLive,
    ),
  });
};

const apiRuntime = makeShellAuthenticationApiRuntime(
  authenticationServiceLive,
  approvedGatewayIssuerLive,
  tenantModuleStateServiceLive,
  undefined,
  true,
  ExternalIdentityProviderContextAccessLive.pipe(Layer.provide(approvedModuleCatalogLive)),
  unavailableResourceGateways,
  defaultScopedModuleStateFactory,
  ExternalIdentityProviderDeploymentLive.pipe(Layer.provide(approvedModuleCatalogLive)),
);

export default apiRuntime;

// The Cloudflare entry calls these optional BFF hooks before its normal prefix dispatch.

let rootRouteHandler: ReturnType<typeof apiRuntime.createHandler> | undefined;

/**
 * Node: the root `/mcp` and `/.well-known/oauth-protected-resource[/mcp]` middleware serves the canonical BFF route
 * in-process (the request path is already rewritten to the BFF route without its prefix).
 */
// @effect-diagnostics-next-line asyncFunction:off -- Required Node HTTP middleware Promise adapter; application work stays in the scoped BFF runtime.
export const handleRootRoute = async (request: Request): Promise<Response> => {
  rootRouteHandler ??= apiRuntime.createHandler();
  return rootRouteHandler.handler(request);
};

/** The Node root aliases use the same scoped Better Auth service as the canonical BFF route. */
// @effect-diagnostics-next-line asyncFunction:off -- Required Node HTTP middleware Promise adapter; the service program remains an Effect.
export const handleOAuthMetadata = async (request: Request): Promise<Response> =>
  Effect.runPromise(
    Effect.scoped(
      AuthenticationService.pipe(
        Effect.flatMap((service) =>
          service.oauth === undefined
            ? Effect.succeed(oauthNotFoundResponse())
            : forwardOAuthRequest(service.oauth)(request),
        ),
        // @effect-diagnostics-next-line strictEffectProvide:off -- Node entry point: the root OAuth metadata alias runs outside the BFF runtime, so it provides its own scoped authentication service.
        Effect.provide(authenticationServiceLive),
      ),
    ),
  );
