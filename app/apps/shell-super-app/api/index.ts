import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistryEffect,
} from '@app/core-runtime/auth/external-identity-admission';
import { delegationUnavailable } from './auth/gateway-delegation-errors.ts';
import { authenticationRequestId } from './auth/observability.ts';
import { withShellGatewayReleaseDiagnostic } from './auth/gateway-release-diagnostic.ts';
import { GatewayDelegationVerificationLive } from './auth/gateway-delegation-verification.ts';
import {
  staffAuthenticationNamespaceRegistration,
  STAFF_AUTHENTICATION_NAMESPACE_ID,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { GatewayDelegationExchangeLedgerLive } from './auth/gateway-delegation-exchanges.service.ts';
import { issueDelegatedGatewayContextAssertion } from './auth/gateway-delegation-issuer.ts';
import { admitIntegrationCredential, loadGatewayModuleBindings } from './auth/gateway-delegation-policy.ts';
import {
  acquireSymmyRouteScopeProof,
  issueSymmyRouteScopeAssertion,
  readSymmyRouteScope,
} from './auth/gateway-symmy-route-scope.ts';
import type { SymmyRouteScopeProof } from './auth/gateway-symmy-route-scope.ts';
import type { SymmyRouteContextRequestSchema } from '@app/symmy-integration/api/symmy-route-context';
import { GatewayOriginatorEvidenceLive } from './auth/gateway-originator-evidence.service.ts';
import {
  ActiveApplicationCompositionConfigLive,
  InstalledModuleCatalogServiceLive,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import type {
  ActionCoreError,
  ActiveApplicationCompositionServiceContract,
  DatabaseConnectionPair,
  ContextAccess,
  PrincipalManagementError,
  PrincipalResolutionError,
  ReadCoreError,
  TenantModuleStateService,
} from '@app/core-runtime';
import {
  makeActionRuntimeLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  makeReadRuntimeLive,
  ContextAccessLive,
  OperationalScopeResolver,
  CorePersistenceLive,
  DatabaseConfigLive,
  DatabaseConfig,
  GatewayScopeGrantRegistrarLive,
  LegalEntityContextLive,
  legalEntityDetailRead,
  makeTenantModuleStateService,
  managedPrincipalsRead,
  OutboxRepositoryLive,
  OutboxRuntimeLive,
  PrincipalResolver,
  PrincipalResolverLive,
  ReadRuntime,
  ReadRuntimeLive,
  selfApiKeyBindingsRead,
  SupportRecoveryPrincipalContextResolverLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { GatewayContextProblem } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Cookies, HttpApiBuilder, HttpEffect, HttpServerResponse, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import {
  Cause,
  Clock,
  DateTime,
  Effect,
  Exit,
  Logger,
  ManagedRuntime,
  Match,
  Option,
  pipe,
  Predicate,
  Redacted,
  References,
  Schema,
  Tracer,
} from 'effect';
import { FetchHttpClient, HttpServerRequest } from 'effect/http';
import { flow } from 'effect/Function';
import { AccessChangesCommandsLive } from '@app/core-runtime/access/changes/commands';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { AccessChangesStoreLive } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import { AccessMembershipStoreLive } from '@app/core-runtime/access/intent/memberships';
import { AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { ApprovalStoreLive } from '@app/core-runtime/access/approvals/drizzle-store';
import { FrozenCommandsLive } from '@app/core-runtime/access/approvals/frozen-command-drizzle-store';
import { AccessApprovalsInboxLive } from '@app/core-runtime/access/approvals/inbox';
import { AccessPeopleDirectoryLive } from '@app/core-runtime/access/intent/people-directory';
import { AccessPeopleStoreLive } from '@app/core-runtime/access/intent/people-store';
import { AccessTeamStoreLive } from '@app/core-runtime/access/intent/teams';
import { AccessPeopleCommandsLive } from '@app/core-runtime/access/lifecycle/people-service';
import { AccessApprovalsLive, accessApprovalActionsLayer } from './access-admin/approvals-live.ts';
import {
  AccessApprovalsBffLive,
  accessAdminApprovalsGroupLive,
  accessApprovalsDeclarations,
} from './access-admin/approvals.ts';
import { AccessAdminClock } from './access-admin/clock.ts';
import {
  AccessChangesBff,
  AccessChangesBffLive,
  AccessChangesWritesClosedLive,
  accessChangesDeclarations,
} from './access-admin/changes.ts';
import {
  AccessExplainBffWithMembershipsLive,
  accessAdminExplainGroupLive,
  accessExplainDeclarations,
} from './access-admin/explain.ts';
import { AccessPeopleBffLive, accessAdminPeopleGroupLive, accessPeopleDeclarations } from './access-admin/people.ts';
import { AccessAdminRolesBffLive, accessAdminRolesGroupLive, accessRolesDeclarations } from './access-admin/roles.ts';
import {
  AccessAdminSession,
  accessAdminAuthenticationRequiredProblem,
  accessAdminForbiddenProblem,
  accessAdminInternalProblem,
  accessAdminUnavailableProblem,
  accessAdminUnprocessableProblem,
} from './access-admin/session.ts';
import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { ModuleApiTransportLive } from '../src/module-api/transport.ts';
import {
  SymmyHostMount,
  SymmyHostMountLive,
  SymmyIngress,
  SymmyIngressHandlersLive,
  SymmyIngressSchemaErrorLive,
  SymmyIngressTransportLive,
} from './symmy/transport.ts';
import { symmyUnavailableProblem } from '../shared/symmy/contract.ts';
import {
  SymmyDefectBoundary,
  symmyInternalProblem,
  symmyRouteNotFoundProblem,
} from '../shared/symmy/defect-boundary.ts';
import {
  SymmyGovernedDispatch,
  SymmyGovernedDispatchLive,
  forwardSymmyOwnerRelease,
} from './symmy/governed-dispatch.ts';

import {
  ApiKeyIssueResponseSchema,
  ApiKeyLifecycleResponseSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  CurrentSessionSchema,
  ManagedApiKeyListResponseSchema,
  MediaAttachmentResponseSchema,
  PrincipalMutationResponseSchema,
  ResolvedModuleTargetSchema,
  SelfApiKeyListResponseSchema,
  ShellAuthenticationApi,
  ShellCompositionSchema,
  ShellResourceResponseSchema,
  ShellSearchResponseSchema,
  SignInResponseSchema,
  SupportImpersonationResponseSchema,
  SwitchLegalEntityResponseSchema,
  SwitchTenantResponseSchema,
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
// @ontos-codesmith-core-read-server-imports:start

// @ontos-core-read legal-entity-detail
// legalEntityDetailRead uses the canonical @app/core-runtime import
// @ontos-codesmith-core-read-server-imports:end
import type { ApiKeyProviderError } from './auth/api-key-service.ts';
import { StaffAuthenticationNamespaceRegistryLive } from './auth/authentication-namespace-registry.ts';
import { AuthConfig, AuthConfigLive } from './auth/config.ts';
import {
  CommerceExternalIdentityContextAccessLive,
  CommerceExternalIdentityDeploymentLive,
} from './auth/commerce-external-identity-deployment.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './auth/errors.ts';
import {
  GatewayIssuer,
  GatewayIssuerLive,
  ShellCryptoLive,
  issueGatewayContextAssertion,
  issueSymmyGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import {
  externalIdentityGroupLive,
  externalIdentityWorkloadAuthorizationLive,
} from './auth/external-identity/index.ts';
import { ExternalIdentityNotInstalledLive } from './auth/external-identity-runtime.ts';
import type { ExternalIdentityDeploymentLayer } from './auth/external-identity-runtime.ts';
import type { GatewayIssuerError } from './auth/gateway-issuer.ts';
import { IdentityLifecycle, IdentityLifecycleLive } from './auth/identity-lifecycle.ts';
import type { IdentityLifecycleError } from './auth/identity-lifecycle.ts';
import {
  SupportImpersonationCorrelationId,
  SupportImpersonationService,
  SupportImpersonationServiceLive,
} from './auth/impersonation-service.ts';
import type { SupportImpersonationError } from './auth/impersonation-service.ts';
import type { LegalEntitySelectionForbiddenError } from './auth/legal-entity-selection.ts';
import { validateAuthorizedLegalEntity } from './auth/legal-entity-selection.ts';
import { AuthPersistenceFromConfigLive, AuthPersistenceLive } from './auth/runtime-infrastructure.ts';
import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';
import type { ShellContextResult } from './auth/service.ts';
import { ShellInstalledModuleCatalog, ShellInstalledModuleCatalogLive } from './modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog, InstalledModuleCatalogError } from './modules/installed-module-catalog.ts';
import { InstalledOutboxMatcherLive } from './modules/installed-outbox-matcher.ts';
import { ShellCompositionFactoryLive } from './modules/shell-composition.ts';
import { CapturedShellCompositionCatalog, capturedShellCatalog } from './modules/captured-shell-catalog.ts';
import { ShellGovernedReadDefinitions } from './modules/shell-governed-read-definitions.ts';
import {
  ShellGovernedReads,
  createShellGovernedReadsLayer,
  createShellGovernedReadDefinitionsLayer,
} from './modules/shell-governed-reads.ts';
import type { ShellScopedModuleStateFactory } from './modules/shell-governed-reads.ts';
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

interface SanitizedCause {
  readonly reasons: readonly Cause.Reason<unknown>['_tag'][];
}

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
    describeCause: (cause: Cause.Cause<unknown>) => Cause.Cause<unknown> | SanitizedCause = (cause) => cause,
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
          ? Effect.annotateLogs(
              Effect.logError(message, describeCause(exit.cause)),
              requestLogAnnotations(request),
            ).pipe(Effect.andThen(fail()))
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

const accessAdminSessionLive = Layer.effect(
  AccessAdminSession,
  Effect.gen(function* accessAdminSessionLayer() {
    const authentication = yield* AuthenticationService;
    const resolver = yield* OperationalScopeResolver;
    const gate = yield* AccessDecisionGate;
    return {
      requireTenantContext: Effect.fn('ShellApi.accessAdminTenantContext')(function* accessAdminTenantContext(
        headers: Headers,
      ) {
        const responseRequest = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        if (Option.isSome(responseRequest)) {
          yield* noStore.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, responseRequest.value));
        }
        const session = yield* authentication.resolveTenantContext(headers).pipe(
          Effect.provideService(AccessDecisionGate, gate),
          Effect.mapError((error) =>
            Match.value(error).pipe(
              Match.tag('AuthenticationUnavailableError', accessAdminUnavailableProblem),
              Match.tag('AuthenticationInternalError', () => accessAdminInternalProblem('Session resolution failed.')),
              Match.tag('InvalidCredentialsError', accessAdminAuthenticationRequiredProblem),
              Match.tag('OntosIdentityForbiddenError', () =>
                accessAdminForbiddenProblem('The authenticated identity cannot access this tenant.'),
              ),
              Match.exhaustive,
            ),
          ),
        );
        if (Option.isSome(responseRequest)) {
          yield* forwardSetCookieHeaders(session.setCookieHeaders).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, responseRequest.value),
          );
        }
        if (session.state === 'anonymous') {
          return yield* Effect.fail(accessAdminAuthenticationRequiredProblem());
        }
        return yield* resolver
          .resolve({
            correlationId: headers.get('x-correlation-id') ?? 'missing',
            legalEntityScope: 'optional',
            principal: session.principal,
          })
          .pipe(
            Effect.mapError((error) =>
              Match.value(error).pipe(
                Match.tag('OperationAuthenticationRequired', accessAdminAuthenticationRequiredProblem),
                Match.tag('OperationContextDenied', () =>
                  accessAdminForbiddenProblem('The tenant context could not be admitted.'),
                ),
                Match.tag('OperationContextInvalid', () =>
                  accessAdminUnprocessableProblem('The tenant context is invalid.'),
                ),
                Match.tag('OperationContextUnavailable', accessAdminUnavailableProblem),
                Match.exhaustive,
              ),
            ),
          );
      }),
    };
  }),
);

/** The Shell module's declared administration capabilities, alongside the live BFF groups. */
export const shellAccessAdminDeclarations = Object.freeze({
  approvals: accessApprovalsDeclarations,
  changes: accessChangesDeclarations,
  explain: accessExplainDeclarations,
  people: accessPeopleDeclarations,
  roles: accessRolesDeclarations,
});

const accessAdminChangesGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'accessAdminChanges', (handlers) =>
  handlers
    .handle('listAccessChanges', ({ payload, request }) =>
      noStore.pipe(
        Effect.andThen(AccessChangesBff),
        Effect.flatMap((bff) => bff.list(requestHeaders(request.headers), payload)),
      ),
    )
    .handle('previewAccessChanges', ({ payload, request }) =>
      noStore.pipe(
        Effect.andThen(AccessChangesBff),
        Effect.flatMap((bff) => bff.preview(requestHeaders(request.headers), payload)),
      ),
    )
    .handle('decideAccessChanges', ({ payload, request }) =>
      noStore.pipe(
        Effect.andThen(AccessChangesBff),
        Effect.flatMap((bff) => bff.decide(requestHeaders(request.headers), payload)),
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
  const mutationContext = Effect.fn('shell.identity.mutationContext')(function* mutationContext(
    request: RequestWithHeaders,
    headers: RequestHeaders,
  ) {
    const resolved = yield* authenticated(request);
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
            (binding) => {
              if (binding.authBindingId === undefined) {
                return Effect.succeed({});
              }
              return resolver
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
                  Effect.map(({ bindingState, metadata }) =>
                    withOptionalProperty(
                      withOptionalProperty(
                        {
                          authBindingId: binding.authBindingId,
                          expiresAt: metadata.expiresAt,
                          name: metadata.name,
                          start: metadata.start,
                        },
                        binding.createdAt !== undefined,
                        'createdAt',
                        metadata.createdAt,
                        {},
                      ),
                      binding.status !== undefined,
                      'enabled',
                      metadata.enabled,
                      binding.status === undefined
                        ? {}
                        : { cleanupPending: metadata.enabled !== (bindingState.status === 'active') },
                    ),
                  ),
                  Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
                );
            },
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
          const { context, service } = yield* mutationContext(request, headers);
          return yield* service
            .issue(
              withOptionalProperty(
                {
                  ...context,
                  managedPrincipalId: payload.principalId,
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
          const resolved = yield* authenticated(request);
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
              const authBindingId = item.authBindingId === undefined ? null : Option.getOrNull(item.authBindingId);
              if (authBindingId === null) {
                return withOptionalProperty(
                  { key: null, kind: item.kind, principalId: item.principalId, principalStatus: item.principalStatus },
                  item.displayName !== undefined,
                  'displayName',
                  item.displayName,
                  {},
                );
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
                  Effect.map(({ bindingState, metadata }) =>
                    withOptionalProperty(
                      {
                        key: withOptionalProperty(
                          withOptionalProperty(
                            {
                              authBindingId,
                              expiresAt: metadata.expiresAt,
                              name: metadata.name,
                              start: metadata.start,
                            },
                            item.bindingCreatedAt !== undefined,
                            'createdAt',
                            metadata.createdAt,
                            {},
                          ),
                          item.bindingStatus !== undefined,
                          'enabled',
                          metadata.enabled,
                          item.bindingStatus === undefined
                            ? {}
                            : { cleanupPending: metadata.enabled !== (bindingState.status === 'active') },
                        ),
                        kind: item.kind,
                        principalId: item.principalId,
                        principalStatus: item.principalStatus,
                      },
                      item.displayName !== undefined,
                      'displayName',
                      item.displayName,
                      {},
                    ),
                  ),
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
          const { context, service } = yield* mutationContext(request, headers);
          const { principalId, ...statusPayload } = payload;
          const response = yield* service
            .setStatus({
              ...statusPayload,
              ...context,
              managedPrincipalId: principalId,
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
          const { context, service } = yield* mutationContext(request, headers);
          return yield* service
            .rotate(
              withOptionalProperty(
                {
                  ...context,
                  managedPrincipalId: payload.principalId,
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

const requireGatewayRelease = Effect.fn('ShellGateway.requireRelease')(function* requireGatewayReleaseEffect(
  compositionRevision?: string,
) {
  const authority = yield* ShellInstalledModuleCatalog;
  const catalog = yield* authority.load.pipe(
    Effect.catchTags({
      InstalledModuleCatalogInvalidError: () =>
        withShellGatewayReleaseDiagnostic(
          'catalog_invalid',
          failGatewayProblem(gatewayAuthenticationUnavailableProblem()),
        ),
      InstalledModuleCatalogUnavailableError: () =>
        withShellGatewayReleaseDiagnostic(
          'catalog_unavailable',
          failGatewayProblem(gatewayAuthenticationUnavailableProblem()),
        ),
    }),
  );
  if (
    (compositionRevision !== undefined && compositionRevision !== catalog.composition.revision) ||
    catalog.composition.shell.deployment.appId !== ultramodernDeliveryUnit.appId ||
    catalog.composition.shell.deployment.buildMarker !== ultramodernDeliveryUnit.buildMarker
  ) {
    return yield* withShellGatewayReleaseDiagnostic(
      compositionRevision !== undefined && compositionRevision !== catalog.composition.revision
        ? 'composition_revision_mismatch'
        : 'shell_marker_mismatch',
      failGatewayProblem(
        extendedProblemDetails(
          'GatewayReloadRequiredProblem',
          'The document release is no longer admitted. Reload to continue.',
          409,
          'Reload required',
          'https://ontos.dev/problems/gateway-reload-required',
          { reloadRequired: true as const },
        ),
      ),
    );
  }
  return catalog.composition.revision;
});

/** The staff namespace is registered for exactly the source apps the module credentials are enrolled for. */
const delegationNamespaceRegistryEffect = loadGatewayModuleBindings.pipe(
  Effect.flatMap((bindings) =>
    staffAuthenticationNamespaceRegistration([...new Set(bindings.map((binding) => binding.sourceAppId))]).pipe(
      Effect.flatMap((registration) => makeAuthenticationNamespaceRegistryEffect([registration])),
    ),
  ),
  Effect.mapError(delegationUnavailable),
);

const resolveApiKeyGatewayPrincipal = Effect.fn('ShellGateway.resolveApiKeyPrincipal')(function* resolveApiKeyPrincipal(
  rawKey: string | undefined,
  requestedLegalEntityId: string | undefined,
  request: RequestWithHeaders,
) {
  const keys = yield* ApiKeyService;
  const resolver = yield* PrincipalResolver;
  if (rawKey === undefined || rawKey.trim().length === 0) {
    return yield* failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem());
  }
  const verified = yield* keys
    .verify(rawKey)
    .pipe(Effect.catch((error) => failApiKeyGatewayProblem(apiKeyProviderGatewayProblem(error))));
  // A module credential acts only through the delegated endpoint, which names the subject it acts for.
  yield* admitIntegrationCredential(verified.providerKeyId).pipe(
    Effect.catchTag('GatewayDelegationError', (error) =>
      failApiKeyGatewayProblem(
        error.code === 'forbidden' ? gatewayForbiddenProblem() : gatewayAuthenticationUnavailableProblem(),
      ),
    ),
  );
  const identity = yield* resolver
    .resolveBetterAuthApiKey(verified.providerKeyId)
    .pipe(Effect.catch((error) => pipe(error, principalResolutionGatewayProblem, failApiKeyGatewayProblem)));
  let legalEntityId: string | undefined;
  const apiKeyContextRef = `better-auth-api-key:${verified.providerKeyId}`;
  if (requestedLegalEntityId !== undefined) {
    const selected = yield* validateAuthorizedLegalEntity({
      legalEntityId: requestedLegalEntityId,
      scope: {
        authBindingId: identity.authBindingId,
        authContextRef: apiKeyContextRef,
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'api_key',
        correlationId: correlationFromRequest(request),
        principalId: identity.principalId,
        tenantId: identity.tenantId,
      },
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
      authContextRef: apiKeyContextRef,
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
  return { principal, principalKind: identity.principalKind };
});

const acquireSymmyOwnerAssertion = Effect.fn('ShellGateway.acquireSymmyOwnerAssertion')(function* acquireSymmyOwner(
  rawKey: string,
  request: HttpServerRequest.HttpServerRequest,
  input: { readonly audience: string; readonly legalEntityId?: string },
  compositionRevision?: string,
  routeProof?: SymmyRouteScopeProof,
) {
  const identity = yield* resolveApiKeyGatewayPrincipal(
    rawKey,
    routeProof === undefined ? input.legalEntityId : undefined,
    request,
  );
  const { principalKind } = identity;
  if (principalKind !== 'integration') {
    return yield* Effect.fail(gatewayForbiddenProblem());
  }
  const revision = yield* requireGatewayRelease(compositionRevision).pipe(
    Effect.catchTags({
      GatewayReloadRequiredProblem: () => Effect.fail(symmyUnavailableProblem),
      GatewayUnavailableProblem: () => Effect.fail(symmyUnavailableProblem),
    }),
  );
  const assertion =
    routeProof === undefined
      ? yield* (
          input.audience === 'symmy-integration'
            ? issueSymmyGatewayContextAssertion({
                compositionRevision: revision,
                principal: identity.principal,
                principalKind,
              })
            : issueGatewayContextAssertion({
                audience: input.audience,
                compositionRevision: revision,
                principal: identity.principal,
              })
        ).pipe(Effect.catchTag('GatewayIssuerError', () => Effect.fail(symmyUnavailableProblem)))
      : yield* issueSymmyRouteScopeAssertion(
          routeProof,
          withOptionalProperty(
            { audience: input.audience, principal: identity.principal },
            input.legalEntityId !== undefined,
            'legalEntityId',
            input.legalEntityId,
            {},
          ),
        ).pipe(
          Effect.catchTag('GatewayDelegationError', (error) =>
            Effect.fail(error.code === 'forbidden' ? gatewayForbiddenProblem() : symmyUnavailableProblem),
          ),
        );
  return {
    apiBaseUrl: assertion.apiBaseUrl,
    assertion: Redacted.make(assertion.token),
    compositionRevision: assertion.compositionRevision,
  };
});

const acquireSymmyIngressRouteProof = Effect.fn('ShellGateway.acquireSymmyIngressRouteProof')(function* routeProof(
  rawKey: string,
  request: HttpServerRequest.HttpServerRequest,
  compositionRevision: string,
  routeRequest: typeof SymmyRouteContextRequestSchema.Encoded,
) {
  const { principal, principalKind } = yield* resolveApiKeyGatewayPrincipal(rawKey, undefined, request);
  if (principalKind !== 'integration') {
    return yield* Effect.fail(gatewayForbiddenProblem());
  }
  yield* requireGatewayRelease(compositionRevision).pipe(
    Effect.catchTags({
      GatewayReloadRequiredProblem: () => Effect.fail(symmyUnavailableProblem),
      GatewayUnavailableProblem: () => Effect.fail(symmyUnavailableProblem),
    }),
  );
  return yield* acquireSymmyRouteScopeProof({
    compositionRevision,
    principal,
    requestCorrelation: correlationFromRequest(request),
    routeRequest,
    sourcePurpose: ['adminCustomers', 'adminProducts', 'adminRegions', 'priceLists'].includes(routeRequest.routeKey)
      ? 'read'
      : 'admit',
  }).pipe(
    Effect.catchTag('GatewayDelegationError', (error) =>
      Effect.fail(error.code === 'forbidden' ? gatewayForbiddenProblem() : symmyUnavailableProblem),
    ),
  );
});

const admitSymmyIngress = Effect.fn('ShellGateway.admitSymmyIngress')(function* admitSymmyIngressEffect(
  rawKey: string,
  request: HttpServerRequest.HttpServerRequest,
) {
  const admission = yield* acquireSymmyOwnerAssertion(rawKey, request, { audience: 'symmy-integration' });
  const context =
    yield* Effect.context<
      Effect.Services<ReturnType<typeof acquireSymmyOwnerAssertion> | ReturnType<typeof acquireSymmyIngressRouteProof>>
    >();
  let selectedRoute: typeof SymmyRouteContextRequestSchema.Encoded | undefined;
  const acquireRoute = Effect.fn('ShellGateway.acquireSymmyRouteAssertion')(function* acquireRouteAssertion(
    input: typeof SymmyRouteContextRequestSchema.Encoded,
  ) {
    const proof = yield* acquireSymmyIngressRouteProof(rawKey, request, admission.compositionRevision, input);
    const route = yield* readSymmyRouteScope(proof).pipe(
      Effect.catchTag('GatewayDelegationError', () => Effect.fail(symmyUnavailableProblem)),
    );
    const target = withOptionalProperty(
      { audience: 'symmy-integration' },
      route.legalEntityId !== undefined,
      'legalEntityId',
      route.legalEntityId,
      {},
    );
    const assertion = yield* acquireSymmyOwnerAssertion(rawKey, request, target, admission.compositionRevision, proof);
    selectedRoute = { ...input };
    return { ...assertion, route };
  });
  const acquireOwner = Effect.fn('ShellGateway.acquireSymmyReadAssertion')(function* acquireOwnerAssertion(input: {
    readonly audience: string;
    readonly legalEntityId?: string;
  }) {
    if (input.legalEntityId === undefined) {
      return yield* acquireSymmyOwnerAssertion(rawKey, request, input, admission.compositionRevision);
    }
    if (selectedRoute === undefined) {
      return yield* Effect.fail(gatewayForbiddenProblem());
    }
    const proof = yield* acquireSymmyIngressRouteProof(rawKey, request, admission.compositionRevision, selectedRoute);
    return yield* acquireSymmyOwnerAssertion(rawKey, request, input, admission.compositionRevision, proof);
  });
  return {
    ...admission,
    acquireOwnerAssertion: (input: { readonly audience: string; readonly legalEntityId?: string }) =>
      acquireOwner(input).pipe(Effect.provide(context)),
    acquireRouteAssertion: (input: typeof SymmyRouteContextRequestSchema.Encoded) =>
      acquireRoute(input).pipe(Effect.provide(context)),
  };
});

export const SymmyIngressDefectLive = Layer.succeed(
  SymmyDefectBoundary,
  Effect.fn('SymmyIngress.sanitizeDefect')(function* sanitizeSymmyIngressDefect(operation) {
    if (!(yield* SymmyHostMount)) {
      return yield* Effect.fail(symmyRouteNotFoundProblem);
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestId = authenticationRequestId(new Headers(request.headers));
    const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan));
    const rawKey = request.headers['x-api-key']?.trim();
    const containsKey = (value: string) => rawKey !== undefined && rawKey.length > 0 && value.includes(rawKey);
    const traceId = span?.traceId;
    const safeTraceId = traceId !== undefined && !containsKey(traceId) ? traceId : undefined;
    const correlationId =
      requestId === 'missing' || requestId === 'invalid' || containsKey(requestId) ? safeTraceId : requestId;
    return yield* recoverUnexpectedDefect(
      { headers: { 'x-correlation-id': correlationId } },
      'Unexpected Symmy ingress defect',
      () => Effect.fail(symmyInternalProblem),
      // Defect values and annotations can contain credentials. Retain every reason's classification.
      (cause) => ({ reasons: cause.reasons.map((reason) => reason._tag) }),
    )(operation);
  }),
);

const gatewayContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'gatewayContext', (handlers) =>
  handlers
    .handle('issueGatewayContext', ({ payload, request }) =>
      Effect.gen(function* issueGatewayContextHandler() {
        yield* requireGatewayRelease(payload.compositionRevision);
        const authentication = yield* AuthenticationService;
        const sessionResult = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, gatewayAuthenticationProblem, failGatewayProblem)));
        yield* forwardSetCookieHeaders(sessionResult.setCookieHeaders);
        if (sessionResult.state !== 'authenticated') {
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
          Effect.tapError((error) => logGatewayIssuerFailure('session', request, error)),
          Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)),
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell gateway assertion defect', () =>
          failGatewayProblem(gatewayInternalProblem()),
        ),
      ),
    )
    .handle('issueApiKeyGatewayContext', ({ headers, payload, request }) =>
      Effect.gen(function* issueApiKeyGatewayContextHandler() {
        yield* requireGatewayRelease(payload.compositionRevision);
        const { principal } = yield* resolveApiKeyGatewayPrincipal(
          headers['x-api-key'],
          payload.legalEntityId,
          request,
        );
        return yield* issueGatewayContextAssertion({
          audience: payload.audience,
          compositionRevision: payload.compositionRevision,
          principal,
        }).pipe(
          Effect.tapError((error) => logGatewayIssuerFailure('api_key', request, error)),
          Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)),
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected API-key gateway assertion defect', () =>
          failGatewayProblem(gatewayInternalProblem()),
        ),
      ),
    )
    .handle('issueDelegatedGatewayContext', ({ headers, payload, request }) =>
      Effect.gen(function* issueDelegatedGatewayContextHandler() {
        yield* requireGatewayRelease(payload.compositionRevision);
        const keys = yield* ApiKeyService;
        const rawKey = headers['x-api-key'];
        if (rawKey === undefined || rawKey.trim().length === 0) {
          return yield* failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem());
        }
        const verified = yield* keys
          .verify(rawKey)
          .pipe(Effect.catch((error) => failApiKeyGatewayProblem(apiKeyProviderGatewayProblem(error))));
        const delegationNamespaceRegistry = yield* delegationNamespaceRegistryEffect.pipe(
          Effect.catchTag('GatewayDelegationError', () =>
            failApiKeyGatewayProblem(gatewayAuthenticationUnavailableProblem()),
          ),
        );
        return yield* issueDelegatedGatewayContextAssertion({
          payload,
          requestCorrelation: correlationFromRequest(request),
          verifiedProviderKeyId: verified.providerKeyId,
        }).pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, delegationNamespaceRegistry),
          Effect.catchTags({
            GatewayDelegationError: (error) =>
              Match.value(error.code).pipe(
                Match.when('authentication_required', () =>
                  failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem()),
                ),
                Match.when('forbidden', () => failApiKeyGatewayProblem(gatewayForbiddenProblem())),
                Match.when('unavailable', () => failApiKeyGatewayProblem(gatewayAuthenticationUnavailableProblem())),
                Match.when('reload_required', () =>
                  failApiKeyGatewayProblem(
                    extendedProblemDetails(
                      'GatewayReloadRequiredProblem',
                      'The document release is no longer admitted. Reload to continue.',
                      409,
                      'Reload required',
                      'https://ontos.dev/problems/gateway-reload-required',
                      { reloadRequired: true as const },
                    ),
                  ),
                ),
                Match.exhaustive,
              ),
            GatewayIssuerError: (error) => pipe(error, gatewayIssuerProblem, failApiKeyGatewayProblem),
          }),
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected gateway delegation defect', () =>
          failApiKeyGatewayProblem(gatewayInternalProblem()),
        ),
      ),
    ),
);

const corePersistenceLive = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
/**
 * The five enforcement ports this composition reads its authority through (CUTOVER-PLAN §3.1).
 * They stay in the output on purpose: the Action and Read runtimes bind the same gate through
 * `bindLiveAccessGate`, so one composition builds them once and shares them.
 */
const accessEnforcementPortsLive = AccessEnforcementPortsLive.pipe(
  Layer.provide(TenantIntentLoaderLive),
  Layer.provide(CorePersistenceLive),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(ShellCryptoLive),
);
/**
 * The one access gate of this composition: the seam over those five ports. Every Shell surface —
 * reads, navigation, page opens, search providers, company selection and impersonation — asks it,
 * and no Shell surface keeps a check of its own. A suite supplies its own gate through the runtime's
 * `accessDecisionLayer` argument, exactly as it already supplies its Context access and providers.
 */
const defaultAccessDecisionLive = AccessDecisionLive.pipe(Layer.provide(accessEnforcementPortsLive));
/** The gate layer a composition may be given; a suite's scripted gate is one of these. */
type ShellAccessDecisionLayer = Layer.Layer<AccessDecisionGate, Layer.Error<typeof defaultAccessDecisionLive>>;
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
const authenticationServiceLive = AuthenticationServiceLive.pipe(Layer.provide(authenticationDependenciesLive));
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
  Layer.effect(Tracer.Tracer, Tracer.Tracer),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

/** The scoped Fetch edge for generated Symmy clients uses the normal owner release transport. */
const symmyOwnerReleaseFetchLive = Layer.effect(
  FetchHttpClient.Fetch,
  Effect.gen(function* symmyOwnerReleaseFetchLayer() {
    const authority = yield* ActiveApplicationCompositionService;
    const nativeFetch = yield* FetchHttpClient.Fetch;
    const relayRuntime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          Layer.mergeAll(
            Layer.succeed(ActiveApplicationCompositionService, authority),
            Layer.succeed(FetchHttpClient.Fetch, nativeFetch),
            runtimeObservabilityLive,
          ),
        ),
      ),
      (runtime) => runtime.disposeEffect,
    );
    return flow(forwardSymmyOwnerRelease, relayRuntime.runPromise);
  }),
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
/** A suite may pin the Shell's own read authority; production reads the active composition. */
const shellReadAuthorityLayerFor = (shellReadAuthority: ActiveApplicationCompositionServiceContract | undefined) =>
  shellReadAuthority === undefined
    ? activeApplicationCompositionLive
    : Layer.succeed(ActiveApplicationCompositionService, shellReadAuthority);
const approvedGatewayIssuerLive = GatewayIssuerLive.pipe(
  Layer.provide(approvedModuleCatalogLive),
  Layer.provide(GatewayScopeGrantRegistrarLive),
);
type ShellGatewayIssuerLayer = Layer.Layer<GatewayIssuer, Layer.Error<typeof approvedGatewayIssuerLive>>;

const defaultScopedModuleStateFactory: ShellScopedModuleStateFactory = (transaction) =>
  makeTenantModuleStateService({ executor: transaction });

type ShellAuthenticationApiRuntimeArguments = readonly [
  authenticationLayer: ShellAuthenticationLayer,
  issuerLayer: ShellGatewayIssuerLayer,
  moduleStateLayer?: ShellModuleStateLayer,
  loadInstalledModuleCatalog?: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>,
  enableInstalledOutboxMatcher?: boolean,
  contextAccessLayer?: Layer.Layer<ContextAccess, Layer.Error<typeof defaultContextAccessLive>>,
  resourceGateways?: ShellResourceGateways,
  scopedModuleStateFactory?: ShellScopedModuleStateFactory,
  externalIdentityDeploymentLayer?: ExternalIdentityDeploymentLayer,
  /** The access gate this composition asks; a suite supplies a scripted one (never a production default). */
  accessDecisionLayer?: ShellAccessDecisionLayer,
  shellReadAuthority?: ActiveApplicationCompositionServiceContract,
  runtimeDatabase?: DatabaseConnectionPair,
];

export const makeShellAuthenticationApiRuntime = (
  ...args: ShellAuthenticationApiRuntimeArguments
): EffectBffDefinition<typeof ShellAuthenticationApi> & EffectBffRuntime<typeof ShellAuthenticationApi> => {
  const [
    authenticationLayer,
    issuerLayer,
    moduleStateLayer,
    loadInstalledModuleCatalog,
    enableInstalledOutboxMatcher = false,
    contextAccessLayer = defaultContextAccessLive,
    resourceGateways = unavailableResourceGateways,
    scopedModuleStateFactory = defaultScopedModuleStateFactory,
    externalIdentityDeploymentLayer = ExternalIdentityNotInstalledLive,
    accessDecisionLayer,
    shellReadAuthority,
    runtimeDatabase,
  ] = args;
  const runtimeCorePersistenceLive =
    runtimeDatabase === undefined
      ? corePersistenceLive
      : CorePersistenceLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, runtimeDatabase.runtime)));
  const runtimeAuthConfigLive =
    runtimeDatabase === undefined
      ? AuthConfigLive
      : Layer.effect(
          AuthConfig,
          AuthConfig.pipe(
            Effect.map((configuration) => ({
              ...configuration,
              connectionString: runtimeDatabase.runtime.connectionString,
            })),
          ),
        ).pipe(Layer.provide(AuthConfigLive));
  const runtimeAuthPersistenceLive =
    runtimeDatabase === undefined
      ? authPersistenceLive
      : AuthPersistenceFromConfigLive.pipe(Layer.provide(runtimeAuthConfigLive));
  const runtimePrincipalResolverLive =
    runtimeDatabase === undefined
      ? principalResolverLive
      : PrincipalResolverLive({
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        }).pipe(Layer.provide(runtimeCorePersistenceLive));
  const runtimeLegalEntityContextLive =
    runtimeDatabase === undefined
      ? legalEntityContextLive
      : LegalEntityContextLive.pipe(Layer.provide(runtimeCorePersistenceLive));
  const runtimeApiKeyServiceLive =
    runtimeDatabase === undefined
      ? apiKeyServiceLive
      : ApiKeyServiceLive.pipe(Layer.provide(runtimeAuthPersistenceLive));
  const runtimeSupportRecoveryPrincipalLive =
    runtimeDatabase === undefined
      ? supportRecoveryPrincipalLive
      : SupportRecoveryPrincipalContextResolverLive({
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        }).pipe(Layer.provide(runtimeCorePersistenceLive));
  const selectedModuleStateLayer =
    moduleStateLayer ??
    (runtimeDatabase === undefined
      ? tenantModuleStateServiceLive
      : TenantModuleStateServiceLive.pipe(Layer.provide(runtimeCorePersistenceLive)));
  const accessEnforcementPortsForRuntimeLive =
    runtimeDatabase === undefined
      ? accessEnforcementPortsLive
      : AccessEnforcementPortsLive.pipe(
          Layer.provide(TenantIntentLoaderLive),
          Layer.provide(runtimeCorePersistenceLive),
          Layer.provide(ShellCryptoLive),
        );
  const accessEnforcementLive = Layer.mergeAll(
    accessDecisionLayer ??
      (runtimeDatabase === undefined
        ? defaultAccessDecisionLive
        : AccessDecisionLive.pipe(Layer.provide(accessEnforcementPortsForRuntimeLive))),
    accessEnforcementPortsForRuntimeLive,
  );
  const shellReadAuthorityLayer = shellReadAuthorityLayerFor(shellReadAuthority);
  const moduleCatalogLayer =
    loadInstalledModuleCatalog === undefined
      ? approvedModuleCatalogLive
      : Layer.succeed(ShellInstalledModuleCatalog, {
          load: loadInstalledModuleCatalog,
        });
  const moduleStateGateLayer = ModuleStateGateLive.pipe(Layer.provide(selectedModuleStateLayer));
  const moduleEntrypointGatewayLayer = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLayer));
  const operationalScopeResolverLayer = OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, contextAccessLayer, accessEnforcementLive)),
  );
  const sharedOperationLayers = Layer.mergeAll(
    runtimeCorePersistenceLive,
    contextAccessLayer,
    moduleStateGateLayer,
    moduleEntrypointGatewayLayer,
    operationalScopeResolverLayer,
  );
  const readRuntimeLayer = ReadRuntimeLive.pipe(
    Layer.provide(Layer.mergeAll(sharedOperationLayers, accessEnforcementLive)),
  );
  const actionRuntimeLayer = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(
      Layer.mergeAll(
        sharedOperationLayers,
        activeApplicationCompositionLive,
        InstalledModuleCatalogServiceLive.pipe(Layer.provide(activeApplicationCompositionLive)),
        ActionRepositoryLive,
        ActionPermissionLive,
        accessEnforcementLive,
      ),
    ),
  );
  const identityLifecycleLayer = IdentityLifecycleLive.pipe(
    Layer.provide(Layer.mergeAll(actionRuntimeLayer, runtimeApiKeyServiceLive, runtimePrincipalResolverLive)),
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
        const definitionsLayer = createShellGovernedReadDefinitionsLayer(
          resourceGateways,
          providerAssertionIssuer,
          scopedModuleStateFactory,
        );
        return Layer.unwrap(
          Effect.gen(function* makeShellHostedReadRuntime() {
            const registrations = yield* ShellGovernedReadDefinitions;
            const authority = yield* ActiveApplicationCompositionService;
            const capturedAuthority = {
              load: authority.load.pipe(
                Effect.flatMap((snapshot) =>
                  capturedShellCatalog.pipe(
                    Effect.mapError(
                      (cause) =>
                        new ActiveApplicationCompositionUnavailableError({
                          cause,
                          reason: 'The Shell request release is unavailable',
                        }),
                    ),
                    Effect.filterOrFail(
                      (catalog) => catalog.composition.revision === snapshot.composition.revision,
                      () =>
                        new ActiveApplicationCompositionUnavailableError({
                          reason: 'The Shell request release changed',
                        }),
                    ),
                    Effect.as(snapshot),
                  ),
                ),
              ),
            };
            return createShellGovernedReadsLayer(registrations).pipe(
              Layer.provide(
                makeReadRuntimeLive(ultramodernDeliveryUnit, { shellSystemReads: registrations }).pipe(
                  Layer.provide(Layer.succeed(ActiveApplicationCompositionService, capturedAuthority)),
                ),
              ),
            );
          }),
        ).pipe(Layer.provide(definitionsLayer));
      }),
    ),
  ).pipe(
    Layer.provide(issuerLayer),
    Layer.provide(
      Layer.mergeAll(
        sharedOperationLayers,
        shellReadAuthorityLayer,
        selectedModuleStateLayer,
        moduleCatalogLayer,
        contextAccessLayer,
        accessEnforcementLive,
        ShellCompositionFactoryLive,
        ShellResourceServicesFactoryLive,
      ),
    ),
  );
  const supportImpersonationServiceLive = SupportImpersonationServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        authenticationLayer,
        runtimeAuthPersistenceLive,
        actionRuntimeLayer,
        contextAccessLayer,
        runtimePrincipalResolverLive,
        runtimeSupportRecoveryPrincipalLive,
      ),
    ),
  );
  const outboxMatcherLayer = enableInstalledOutboxMatcher
    ? InstalledOutboxMatcherLive.pipe(
        Layer.provide(
          OutboxRuntimeLive.pipe(Layer.provide(OutboxRepositoryLive), Layer.provide(runtimeCorePersistenceLive)),
        ),
      )
    : Layer.empty;
  const accessAdminStoresLive = Layer.mergeAll(
    AccessChangesStoreLive,
    AccessMembershipStoreLive,
    AccessPeopleDirectoryLive,
    AccessPeopleStoreLive,
    AccessTeamStoreLive,
    AccessWriteJournalStoreLive,
    TenantIntentLoaderLive,
  ).pipe(Layer.provide(runtimeCorePersistenceLive));
  const accessAdminCompilerLive = Layer.effect(
    AccessProjectionCompiler,
    Effect.gen(function* accessAdminCompilerLayer() {
      const configuration = yield* loadSpiceDbConfig().pipe(Effect.orDie);
      const transport = yield* Effect.acquireRelease(
        Effect.sync(() => makeAccessProjectionTransport(configuration)),
        (opened) => Effect.sync(() => opened.close()),
      );
      return makeAccessProjectionCompiler(transport);
    }),
  );
  const accessAdminProjectionWriterLive = AccessProjectionWriterLive.pipe(
    Layer.provide(Layer.mergeAll(accessAdminStoresLive, accessAdminCompilerLive, ShellCryptoLive)),
  );
  const accessAdminCommandsLive = AccessChangesCommandsLive.pipe(
    Layer.provide(Layer.mergeAll(accessAdminStoresLive, accessAdminProjectionWriterLive)),
  );
  const accessAdminPeopleCommandsLive = AccessPeopleCommandsLive.pipe(
    Layer.provide(Layer.mergeAll(accessAdminStoresLive, accessAdminProjectionWriterLive)),
  );
  // Approve, reject and withdraw run over Core's live inbox; execution stays closed, because the inbox
  // binds no owner transaction and the BFF refuses it first. This process registers no owner Action
  // that governs an amount, so a command whose published declaration names one answers "unavailable".
  const accessAdminApprovalsLive = AccessApprovalsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        accessApprovalActionsLayer([]),
        AccessApprovalsInboxLive.pipe(
          Layer.provide(ApprovalStoreLive),
          Layer.provide(FrozenCommandsLive),
          Layer.provide(Layer.mergeAll(accessAdminStoresLive, runtimeCorePersistenceLive, ShellCryptoLive)),
        ),
        accessAdminCommandsLive,
        accessAdminStoresLive,
      ),
    ),
  );
  const accessAdminRequestSessionLive = accessAdminSessionLive.pipe(
    Layer.provide(Layer.mergeAll(authenticationLayer, operationalScopeResolverLayer, accessEnforcementLive)),
  );
  const accessAdminClockLive = Layer.effect(
    AccessAdminClock,
    Clock.Clock.pipe(
      Effect.map((clock) => ({
        now: clock.currentTimeMillis.pipe(Effect.map((millis) => DateTime.toDateUtc(DateTime.makeUnsafe(millis)))),
      })),
    ),
  );
  const accessAdminBffsLive = Layer.mergeAll(
    AccessAdminRolesBffLive,
    AccessApprovalsBffLive,
    AccessChangesBffLive,
    AccessExplainBffWithMembershipsLive,
    AccessPeopleBffLive,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        accessAdminStoresLive,
        accessAdminProjectionWriterLive,
        accessAdminCommandsLive,
        accessAdminPeopleCommandsLive,
        accessAdminApprovalsLive,
        AccessChangesWritesClosedLive,
        accessAdminRequestSessionLive,
        accessAdminClockLive,
        accessEnforcementLive,
      ),
    ),
  );
  const accessAdminHandlersLive = Layer.mergeAll(
    accessAdminRolesGroupLive,
    accessAdminPeopleGroupLive,
    accessAdminChangesGroupLive,
    accessAdminApprovalsGroupLive,
    accessAdminExplainGroupLive,
  ).pipe(Layer.provide(accessAdminBffsLive));
  const delegationScopeResolverLayer = OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, contextAccessLayer, accessEnforcementLive)),
  );
  const delegationLedgerLayer = GatewayDelegationExchangeLedgerLive.pipe(Layer.provide(runtimeAuthPersistenceLive));
  const originatorEvidenceLayer = GatewayOriginatorEvidenceLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, runtimeAuthPersistenceLive)),
  );
  const handlerDependenciesLive = Layer.mergeAll(
    runtimeCorePersistenceLive,
    delegationScopeResolverLayer,
    delegationLedgerLayer,
    originatorEvidenceLayer,
    GatewayDelegationVerificationLive,
    authenticationLayer,
    runtimeAuthPersistenceLive,
    actionRuntimeLayer,
    runtimeApiKeyServiceLive,
    identityLifecycleLayer,
    supportImpersonationServiceLive,
    runtimePrincipalResolverLive,
    runtimeLegalEntityContextLive,
    issuerLayer,
    selectedModuleStateLayer,
    moduleCatalogLayer,
    contextAccessLayer,
    accessEnforcementLive,
    shellGovernedReadsLayer,
    readRuntimeLayer,
    runtimeObservabilityLive,
    externalIdentityWorkloadAuthorizationLive,
    externalIdentityDeploymentLayer,
  ).pipe(Layer.provideMerge(ShellCryptoLive));
  const symmyIngressLive = Layer.effect(
    SymmyIngress,
    Effect.gen(function* configureSymmyIngress() {
      const context =
        yield* Effect.context<
          Exclude<Effect.Services<ReturnType<typeof admitSymmyIngress>>, HttpServerRequest.HttpServerRequest>
        >();
      return {
        admit: (rawKey, request) => admitSymmyIngress(rawKey, request).pipe(Effect.provide(context)),
        dispatch: yield* SymmyGovernedDispatch,
      };
    }),
  ).pipe(
    Layer.provide(SymmyGovernedDispatchLive),
    Layer.provide(symmyOwnerReleaseFetchLive.pipe(Layer.provide(shellReadAuthorityLayer))),
  );
  const apiHandlersLive = Layer.mergeAll(
    authenticationGroupLive,
    identityGroupLive,
    tenantGroupLive,
    legalEntityGroupLive,
    compositionGroupLive,
    resourcesGroupLive,
    gatewayContextGroupLive,
    // @ontos-codesmith-core-read-server-layers:start

    // @ontos-core-read legal-entity-detail
    coreReadLegalEntityDetailGroupLive,
    // @ontos-codesmith-core-read-server-layers:end
    externalIdentityGroupLive,
    accessAdminHandlersLive,
    SymmyIngressHandlersLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          symmyIngressLive,
          SymmyIngressSchemaErrorLive,
          SymmyIngressDefectLive,
          symmyOwnerReleaseFetchLive.pipe(Layer.provide(shellReadAuthorityLayer)),
        ),
      ),
    ),
  ).pipe(
    Layer.provide(outboxMatcherLayer),
    Layer.provide(handlerDependenciesLive),
    Layer.provide(compositionSourceLive),
    Layer.orDie,
  );

  return assembleEffectBffRuntime({
    api: ShellAuthenticationApi,
    handlers: apiHandlersLive,
    transport: Layer.mergeAll(
      ModuleApiTransportLive.pipe(Layer.provide(activeApplicationCompositionLive)),
      SymmyIngressTransportLive.pipe(Layer.provide(SymmyHostMountLive)),
    ),
  });
};

/**
 * The production Shell runtime arguments without the access gate. The default export appends the
 * live gate; a test bundle that must not reach a real engine appends its own scripted gate instead
 * (CUTOVER-PLAN §3.1 step 8).
 */
export const shellProductionRuntimeArguments = Object.freeze([
  authenticationServiceLive,
  approvedGatewayIssuerLive,
  tenantModuleStateServiceLive,
  undefined,
  true,
  CommerceExternalIdentityContextAccessLive,
  unavailableResourceGateways,
  defaultScopedModuleStateFactory,
  CommerceExternalIdentityDeploymentLive,
] as const);

const apiRuntime = makeShellAuthenticationApiRuntime(...shellProductionRuntimeArguments);

export default apiRuntime;
