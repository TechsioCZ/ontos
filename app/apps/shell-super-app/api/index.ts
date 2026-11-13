import { PeopleSearchReadLive } from '@app/core-runtime/people/search';
import { ShellPeopleSystemSearchLive } from './modules/shell-system-search.ts';
import { requestPeopleSearchRebuild } from './people-search-rebuild.ts';
import { RequestPeopleSearchRebuildHttpResponseSchema } from '../shared/core-actions/request-people-search-rebuild.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  InstalledModuleCatalogServiceLive,
} from '@app/core-runtime/modules/active-application-composition';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistryEffect,
} from '@app/core-runtime/auth/external-identity-admission';
import { delegationUnavailable, logDelegationRefusal } from './auth/gateway-delegation-errors.ts';
import { GatewayDelegationVerificationLive } from './auth/gateway-delegation-verification.ts';
import { gatewayReleaseRefusal } from './auth/gateway-release-refusal.ts';
import type { GatewayReleaseRefusalHeaders } from './auth/gateway-release-refusal.ts';
import {
  staffAuthenticationNamespaceRegistration,
  STAFF_AUTHENTICATION_NAMESPACE_ID,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { GatewayDelegationExchangeLedgerLive } from './auth/gateway-delegation-exchanges.service.ts';
import { bindingsUnavailable, issueDelegatedGatewayContextAssertion } from './auth/gateway-delegation-issuer.ts';
import {
  admitIntegrationCredential,
  loadGatewayModuleBindings,
  ModuleCredentialEnrolmentSourceLive,
} from './auth/gateway-delegation-policy.ts';
import { GatewayOriginatorEvidenceLive } from './auth/gateway-originator-evidence.service.ts';
import { PlatformWorkloadKeyAdmission } from './auth/platform-workload-key-admission.ts';
import { PlatformWorkloadKeyAdmissionLive } from './auth/platform-workload-key-admission.service.ts';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import type {
  ActionCoreError,
  ActiveApplicationCompositionServiceContract,
  ContextAccess,
  DatabaseConnectionPair,
  PrincipalManagementError,
  PrincipalResolutionError,
  OperationalScope,
  OperationalScopeRequest,
  ReadCoreError,
  TenantModuleStateService,
  TrustedPrincipalContext,
} from '@app/core-runtime';

import {
  makeActionRuntimeLive,
  AgentProposalCommandPreparationLive,
  AgentProposalCommandAuthorizationPreflightLive,
  IdentityAdministrationDeniedAuditLive,
  oauthConnectionAdministrationRead,
  ActiveApplicationCompositionUnavailableError,
  makeReadRuntimeLive,
  ContextAccessLive,
  OperationalScopeResolver,
  CorePersistenceLive,
  CoreSearchProjectionStoreLive,
  DatabaseConfig,
  DatabaseConfigLive,
  GatewayScopeGrantRegistrarLive,
  LegalEntityContext,
  LegalEntityContextLive,
  legalEntityDetailRead,
  makeTenantModuleStateService,
  makeDatabaseIdentityEnrollmentLive,
  managedPrincipalsRead,
  companyManagedPrincipalsRead,
  OutboxRepositoryLive,
  OutboxRuntimeLive,
  OAuthAuthenticationAuditLive,
  OAuthConnectionCompaniesLive,
  OAuthGrantRegistryLive,
  PrincipalResolver,
  PrincipalResolverLive,
  ReadRuntime,
  ReadRuntimeLive,
  selfApiKeyBindingsRead,
  SupportRecoveryPrincipalContextResolverLive,
  TenantModuleStateServiceLive,
  TrustedCompanyPrincipalContextSchema,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';

import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionAuthorityLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  API_KEY_GATEWAY_CONTEXT_HEADER,
  GATEWAY_MODULE_NOT_INSTALLED_TYPE,
  GatewayContextResponseSchema,
} from '@app/shared-contracts';
import type { ApiKeyGatewayContextRequest, GatewayContextProblem, GatewayRefusalReason } from '@app/shared-contracts';
import {
  AccessDecisionGate,
  SubjectAccessInspectionLive,
  SubjectInspectionIdentitySourceLive,
} from '@app/core-runtime/access/enforcement';

import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { runEffectRequest } from '@modern-js/bff-effect/effect-client';
import { Cookies, HttpApiBuilder, HttpEffect, HttpServerResponse, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import {
  Cause,
  Context,
  Crypto,
  Clock,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Logger,
  ManagedRuntime,
  Match,
  Option,
  pipe,
  Predicate,
  Redacted,
  Ref,
  References,
  Result,
  Schema,
  Tracer,
} from 'effect';
import type { Types } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServerRequest, UrlParams } from 'effect/http';
import { authenticationQueryRedactions } from '@app/shared-contracts/credential-url';
import { Reactivity } from 'effect/reactivity';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from './database-identity-enrollment.ts';

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
import { ApprovalOwnerTransportLive } from './access-admin/approval-owner-transport.ts';
import { ApprovalOwnerModuleTransportLive } from './access-admin/approval-owner-module-transport.ts';
import { ApprovalOwnerIdentity, requireApprovalOwnerIdentity } from './access-admin/approval-owner-identity.ts';
import { approvalOwnerRefused, approvalOwnerUnavailable } from './access-admin/approval-owner-errors.ts';
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
import { AccessPeopleWritesProvenLive } from './access-admin/people-write-gate.ts';
import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { dispatchModuleApiRequest } from '../src/module-api/transport.ts';
import { withRoundTripLog } from './mcp/describe-timing.ts';
import { mcpRequestIdentityMiddleware } from './mcp/request-identity.ts';
import { McpEndpointTransportLive } from './mcp/transport.ts';
import { ShellTransportLive } from './shell-transport.ts';
import { LiveChangeHubLive } from './live-changes/hub.ts';
import { LiveChangeTailLive } from './live-changes/listener.ts';
import { LiveScopeResolver, SHELL_APP } from './live-changes/live-scope.ts';
import type { LiveScope } from './live-changes/live-scope.ts';
import { LiveScopeUnavailable } from './live-changes/live-scope-unavailable.ts';
import { LiveChangesRouteLive } from './live-changes/transport.ts';
import { dispatchEmailBatch } from '@app/email-delivery/dispatcher';
import { listDeliveries } from '@app/email-delivery/deliveries';

import { EmailRequestDatabaseLive } from './email/request-database.ts';
import { EmailDeliveryRequests, ShellEmailReceiptHandlersLive } from './email/transport.ts';
import type { EmailDeliveryQuery } from './email/transport.ts';
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
  ResolvedModuleTargetsSchema,
  SelfApiKeyListResponseSchema,
  ShellAuthenticationApi,
  ShellCompositionSchema,
  ShellDocumentContextSchema,
  ShellResourceResponseSchema,
  SignInResponseSchema,
  SupportImpersonationResponseSchema,
  SwitchLegalEntityResponseSchema,
  SwitchTenantResponseSchema,
  SwitchToTenantContextResponseSchema,
} from '../shared/api.ts';
import { moduleTargetSourceHeader, moduleTargetSourcePathHeader } from '../shared/module-target-diagnostics.ts';
import { moduleTargetLogAnnotations } from './modules/module-target-log.ts';
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
  ShellDocumentTarget,
  ModuleTargetSelector,
  ResolveModuleTargetPayload,
  ResolveModuleTargetsPayload,
  ShellInvalidRequestProblem,
  ShellSearchPayload,
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
import { decodeApiKeyGatewayReadRequest } from './auth/api-key-gateway-read-transport.ts';
import { invitePeoplePerson, listPeople, setPeopleCompanyMembership } from './auth/people-administration.ts';
import {
  InvitePeopleResponseSchema,
  PeopleListResponseSchema,
  SetPeopleCompanyMembershipResponseSchema,
} from '../shared/people-api.ts';
// @ontos-codesmith-core-read-server-imports:start

// @ontos-core-read legal-entity-detail
// legalEntityDetailRead uses the canonical @app/core-runtime import
// @ontos-codesmith-core-read-server-imports:end
import type { ApiKeyProviderError } from './auth/api-key-service.ts';
import { StaffAuthenticationNamespaceRegistryLive } from './auth/authentication-namespace-registry.ts';
import { AuthConfig, AuthConfigLive } from './auth/config.ts';
import { OAuthFlowLive } from './auth/db/oauth-flow-live.ts';
import { oauthConnectGroupLive } from './oauth-connections/connect-http.ts';
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
import { GatewayTimings, observeGatewayPhase } from './auth/gateway-timing.ts';
import { NoServerTimingLive } from './no-server-timing.ts';
import { preserveSystemPrincipalContextTrust } from '@app/core-runtime/auth/system-principal-context-provenance';
import { peopleAdministrationCapability } from './auth/demo-accounts.ts';
import { rebrandRentalDemoAccounts } from './auth/rental-demo-brand-runtime-infrastructure.ts';
import { listAgentEntities, manageAgentEntity } from './auth/agent-entities.ts';
import { IdentityLifecycle, IdentityLifecycleLive } from './auth/identity-lifecycle.ts';
import { ManagedApiKeyTargetEligibilityLive } from '@app/core-runtime/auth/managed-api-key-eligibility';
import type { IdentityLifecycleError } from './auth/identity-lifecycle.ts';
import {
  SupportImpersonationCorrelationId,
  SupportImpersonationService,
  SupportImpersonationServiceLive,
} from './auth/impersonation-service.ts';
import type { SupportImpersonationError } from './auth/impersonation-service.ts';
import type { LegalEntitySelectionForbiddenError } from './auth/legal-entity-selection.ts';
import { canSelectTenantContext, validateAuthorizedLegalEntity } from './auth/legal-entity-selection.ts';
import {
  AuthPersistenceLive,
  AuthPersistenceFromConfigLive,
  BetterAuthNativeAdapterLive,
  BetterAuthPersonInvitationIdentityProviderLive,
} from './auth/runtime-infrastructure.ts';
import { BetterAuthFrameworkLive } from './auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from './auth/better-auth-runtime.ts';

import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';
import { OAuthEndpointGuardsLive } from './auth/oauth-server/endpoint-guards.ts';
import { OAuthAccessTokensLive } from './mcp/connection.ts';
import { forwardOAuthRequest } from './auth/oauth-server/forward.ts';
import { oauthNotFoundResponse } from './auth/oauth-server/policy.ts';
import type { ShellContextResult } from './auth/service.ts';
import type { AgentPlatformCaller } from './agent-platform/caller.ts';
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
import { logRequestServicesFailure } from './request-service-diagnostics.ts';
import { ShellCompositionFactoryLive } from './modules/shell-composition.ts';
import { CapturedShellCompositionCatalog, capturedShellCatalog } from './modules/captured-shell-catalog.ts';
import { ShellGovernedReadDefinitions } from './modules/shell-governed-read-definitions.ts';
import {
  ShellGovernedReads,
  TENANT_MODULE_TARGET_ACCESS_DECLARATION,
  createShellGovernedReadsLayer,
  createShellGovernedReadDefinitionsLayer,
} from './modules/shell-governed-reads.ts';
import type { ShellScopedModuleStateFactory } from './modules/shell-governed-reads.ts';
import { OAuthConnectionHooksLive } from './oauth-connections/better-auth-hooks.ts';
import { OAuthEndpointGuardDataLive, OAuthGrantOwnersLive } from './oauth-connections/grant-store.ts';
import { OAuthCredentialsLive } from './auth/db/oauth-credentials-live.ts';
import {
  StaffAccountDirectoryLive,
  BetterAuthStaffRoleTemplateAccountProviderLive,
} from './auth/db/staff-account-directory-live.ts';
import { AgentProposalQueueModuleReviewLive } from './agent-platform/module-review.ts';
import { AgentActionRequestIdentity } from './auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from './auth/agent-request-identity.ts';
import { CompanyDirectoryLive } from './oauth-connections-admin/company-directory-live.ts';
import { CompanyDirectory } from './oauth-connections-admin/company-directory.ts';
import { mcpResourceUrl } from './oauth-connections-admin/config.ts';
import { isSameOriginRequest } from './oauth-connections/request-origin.ts';
import { loadOAuthServerConfig } from './oauth-connections/server-config.ts';
import { GrantAdminLive } from './oauth-connections-admin/grant-port-live.ts';
import { GrantAdmin } from './oauth-connections-admin/ports.ts';
import {
  listForAdmin,
  listMine,
  replaceAgentOperators,
  revokeConnection,
  updateConnection,
} from './oauth-connections-admin/handlers.ts';
import type {
  ConnectionsAdminDeps,
  ConnectionsAdminError,
  ConnectionsCaller,
} from './oauth-connections-admin/ports.ts';
import {
  attachShellMedia,
  ShellProviderUnavailableError,
  ShellResourceServicesFactoryLive,
} from './modules/shell-resources.ts';
import type {
  ShellMediaAttachmentResolution,
  ShellProviderAssertionIssuer,
  ShellResourceGateways,
} from './modules/shell-resources.ts';
import { moduleSearchProviderGateway } from './modules/shell-search-provider-gateway.ts';

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

/** Register on the live HTTP request before API decoding and captured handler services, including problem responses. */
const shellSearchResponseCacheControl = Effect.fn('Shell.searchResponseCacheControl')(
  function* searchResponseCacheControl(
    response: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === 'POST' && new URL(request.url, 'http://localhost').pathname === '/shell/search') {
      yield* noStore;
    }
    return yield* response;
  },
);
export const makeShellSearchNoStoreLayer = () =>
  HttpRouter.middleware(shellSearchResponseCacheControl, { global: true });

const failGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (Predicate.isTagged(gatewayProblem, 'GatewayAuthenticationRequiredProblem') ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(gatewayProblem)),
  );
const failApiKeyGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (Predicate.isTagged(gatewayProblem, 'GatewayAuthenticationRequiredProblem') ? apiKeyChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(gatewayProblem)),
  );

const hasCompanyScope = Schema.is(TrustedCompanyPrincipalContextSchema);

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
/** A refused module call whose module is not installed for the tenant: a 403 that says exactly that (`type`). */
const gatewayModuleNotInstalledProblem = (): GatewayProblem<'GatewayForbiddenProblem'> =>
  problemDetails(
    'GatewayForbiddenProblem',
    'The module the call is for is not installed for the tenant.',
    403,
    'Module not installed',
    GATEWAY_MODULE_NOT_INSTALLED_TYPE,
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

/** The same problem, naming the step that refused it; a delegated call's caller logs that code. */
const withRefusalReason = <Problem extends GatewayContextProblem>(problem: Problem, reason: GatewayRefusalReason) => ({
  ...problem,
  reason,
});

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
  targetDiagnostics: Readonly<Record<string, LogAnnotation>> = {},
) =>
  Effect.annotateLogs(
    Effect.logError('Shell governed read failed'),
    requestLogAnnotations(request, {
      ...targetDiagnostics,
      failureReason: error.reason,
      failureTag: error._tag,
      operation,
    }),
  );

type ShellProblem =
  | ShellReloadRequiredProblem
  | ShellInvalidRequestProblem
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
          yield* noStore;
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
        yield* noStore;
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
          yield* noStore;
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
        yield* noStore;
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
        yield* noStore;
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
        yield* noStore;
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
        yield* noStore;
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
        yield* noStore;
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

/** Measures this gateway request's phases: each one is logged when it ends. */
const withGatewayTimings = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(Effect.provideService(GatewayTimings, true));

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
    const issuer = yield* GatewayIssuer;
    return yield* issuer.issueDocument({ audiences, compositionRevision, principal });
  },
);

/**
 * The single-target resolution, exported so the runtime boundary is testable. A verified tenant session without a
 * selected company may open only an explicitly opted-in page; every other page keeps the existing company
 * requirement and is answered 409 `selection_required`. A company session always takes the company Read and module
 * gate, even for an opted-in page. Every decision is asked of the composition's `AccessDecisionGate`.
 */
export const resolveModuleTargetHandler = Effect.fn('shell.composition.resolveModuleTarget')(
  function* resolveModuleTargetHandlerEffect(request: RequestWithHeaders, payload: ResolveModuleTargetPayload) {
    yield* noStore;
    const session = yield* requireShellSession(request.headers);
    if (session.state !== 'authenticated' && session.state !== 'tenant_authenticated') {
      return yield* failShellProblem(shellSelectionRequiredProblem());
    }
    const catalog = yield* captureShellRelease(payload.compositionRevision);
    const governedReads = yield* ShellGovernedReads;
    const correlationId = correlationFromRequest(request);
    const selector = {
      ...payload,
      // The captured release: the pinned one when the caller sent it, otherwise the current one.
      compositionRevision: catalog.composition.revision,
      correlationId,
      principal: session.principal,
    };
    const logTargetFailure = (error: ReadCoreError) =>
      logShellReadFailure(
        'module_target',
        request,
        error,
        moduleTargetLogAnnotations(catalog, {
          reportedSource: request.headers[moduleTargetSourceHeader],
          selector: payload,
          sourcePath: request.headers[moduleTargetSourcePathHeader],
        }),
      );
    if (session.state === 'tenant_authenticated') {
      // The tenant-only registration admits the target only when this exact page opted in and a genuine tenant
      // module.access permission allowed it; a company module decision is never consulted.
      const outcome = yield* governedReads.tenantModuleTarget(selector).pipe(
        Effect.provideService(CapturedShellCompositionCatalog, catalog),
        Effect.tapError(logTargetFailure),
        Effect.catch((error) => pipe(error, shellReadProblem, failShellProblem)),
      );
      if (outcome.state === 'selection_required') {
        return yield* failShellProblem(shellSelectionRequiredProblem());
      }
      return yield* decodeResponse(ResolvedModuleTargetSchema, outcome.target, shellInternalProblem);
    }
    const response = yield* governedReads.moduleTarget(selector).pipe(
      Effect.provideService(CapturedShellCompositionCatalog, catalog),
      Effect.tapError(logTargetFailure),
      Effect.catch((error) => pipe(error, shellReadProblem, failShellProblem)),
    );
    return yield* decodeResponse(ResolvedModuleTargetSchema, response, shellInternalProblem);
  },
);

/**
 * The targets the browser prepares together (every menu destination), with one session resolution and one captured
 * release. Each target is still its own governed read with its own evidence; its problem is its own outcome, while a
 * session or release problem fails the request. The `AccessDecisionGate` shares SpiceDB decisions only within this
 * request.
 */
export const moduleTargetsHandler = Effect.fn('shell.composition.moduleTargets')(function* moduleTargetsHandlerEffect(
  request: RequestWithHeaders,
  payload: ResolveModuleTargetsPayload,
) {
  const session = yield* requireAuthenticatedShellContext(request.headers);
  const catalog = yield* captureShellRelease(payload.compositionRevision);
  const governedReads = yield* ShellGovernedReads;
  const correlationId = correlationFromRequest(request);
  const outcomes = yield* Effect.forEach(
    payload.targets,
    (selector) =>
      governedReads
        .moduleTarget({
          ...selector,
          compositionRevision: catalog.composition.revision,
          correlationId,
          principal: session.principal,
        })
        .pipe(
          Effect.provideService(CapturedShellCompositionCatalog, catalog),
          Effect.map((target) => ({ state: 'resolved' as const, target })),
          Effect.tapError((error) =>
            logShellReadFailure(
              'module_target',
              request,
              error,
              moduleTargetLogAnnotations(catalog, {
                reportedSource: request.headers[moduleTargetSourceHeader],
                selector,
                sourcePath: request.headers[moduleTargetSourcePathHeader],
              }),
            ),
          ),
          Effect.catch((error) => Effect.succeed({ problem: shellReadProblem(error), state: 'failed' as const })),
        ),
    // Each read holds a pooled connection only for its own short transaction; this matches the pool size.
    { concurrency: 4 },
  );
  return yield* decodeResponse(ResolvedModuleTargetsSchema, { outcomes }, shellInternalProblem);
});

/**
 * What one live-changes connection may hear about: the session's tenant and selected legal entity, and the module
 * APIs its composition admits (the same gateway audiences the document gets). Resolved once per connection; the
 * connection ends after its maximum age, so a revoked permission stops reaching the browser within minutes.
 */
const resolveLiveChangeScopeOrProblem = Effect.fn('Shell.resolveLiveChangeScope')(
  function* resolveLiveChangeScopeEffect(request: RequestWithHeaders) {
    const session = yield* requireAuthenticatedShellContext(request.headers);
    const { principal } = session;
    if (!hasCompanyScope(principal)) {
      return Option.none<LiveScope>();
    }
    const catalog = yield* captureShellRelease();
    const governedReads = yield* ShellGovernedReads;
    const composition = yield* governedReads
      .composition({ correlationId: correlationFromRequest(request), principal })
      .pipe(Effect.provideService(CapturedShellCompositionCatalog, catalog));
    if (composition.state !== 'available') {
      return Option.none<LiveScope>();
    }
    return Option.some<LiveScope>({
      allowedApps: new Set([...composition.gatewayAudiences, SHELL_APP]),
      legalEntityId: principal.legalEntityId,
      moduleApps: new Map(
        catalog.contracts.map((contract) => [contract.manifest.module.id, contract.deployment.appId]),
      ),
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    });
  },
);

const liveScopeFailure = (error: { readonly _tag: string }) =>
  new LiveScopeUnavailable({ status: Predicate.isTagged(error, 'ShellAuthenticationRequiredProblem') ? 401 : 503 });

/** No company context or no available composition: nothing to subscribe to. */
const liveScopeOrRefusal = Option.match({
  onNone: () => Effect.fail(new LiveScopeUnavailable({ status: 409 })),
  onSome: (scope: LiveScope) => Effect.succeed(scope),
});

/**
 * A module page document's target: the same governed read `resolveModuleTargetHandler` runs for the same principal
 * (`tenantModuleTarget` for a tenant session), against the document's captured release. Its problem is its own
 * outcome, never the document's, exactly as the separate request answered it.
 */
const documentTarget = Effect.fn('shell.composition.documentTarget')(function* documentTargetEffect(
  request: RequestWithHeaders,
  selector: ModuleTargetSelector,
  principal: TrustedPrincipalContext,
  catalog: ShellInstalledCatalog,
  context: 'company' | 'tenant',
) {
  const governedReads = yield* ShellGovernedReads;
  const input = {
    ...selector,
    compositionRevision: catalog.composition.revision,
    correlationId: correlationFromRequest(request),
    principal,
  };
  const read: Effect.Effect<ShellDocumentTarget, ReadCoreError> =
    context === 'tenant'
      ? governedReads.tenantModuleTarget(input)
      : governedReads.moduleTarget(input).pipe(Effect.map((target) => ({ state: 'resolved' as const, target })));
  return yield* read.pipe(
    Effect.provideService(CapturedShellCompositionCatalog, catalog),
    Effect.tapError((error) =>
      logShellReadFailure(
        'module_target',
        request,
        error,
        moduleTargetLogAnnotations(catalog, {
          reportedSource: request.headers[moduleTargetSourceHeader],
          selector,
          sourcePath: request.headers[moduleTargetSourcePathHeader],
        }),
      ),
    ),
    Effect.catch((error) => Effect.succeed({ problem: shellReadProblem(error), state: 'failed' as const })),
    observeGatewayPhase('document-target'),
  );
});

/**
 * Server rendering of a Shell document reads everything it needs here, from one resolution of the session's context:
 * reading session, legal entities, tenants, composition and the people capability as separate requests resolved the
 * same context (Better Auth session plus legal-entity checks) five times per document, each in its own invocation on
 * the document's isolate. Each part keeps its own outcome; the browser keeps the separate, cached endpoints.
 * It issues no gateway assertions: the HTML waited for one signature and one scope-grant registration per audience
 * here, while the browser obtains them in one batch (`auth/gateway-contexts`) as soon as the document renders.
 */
export const documentContextHandler = Effect.fn('shell.composition.documentContext')(
  function* documentContextHandlerEffect(request: RequestWithHeaders, payload: ShellDocumentContextRequest) {
    yield* noStore;
    const authentication = yield* AuthenticationService;
    const headers = requestHeaders(request.headers);
    const { context, tenants: tenantResult } = yield* authentication
      .resolveDocumentContext(headers)
      .pipe(observeGatewayPhase('document-authentication'), Effect.mapError(problem));
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
    const tenants = Result.match(tenantResult, {
      onFailure: (error) => ({
        state: Predicate.isTagged(tenantAuthenticationProblem(error), 'TenantAuthenticationRequiredProblem')
          ? ('authentication_required' as const)
          : ('unavailable' as const),
      }),
      onSuccess: ({ tenants: available }) => ({ state: 'available' as const, tenants: available }),
    });
    // The company-switcher hint grants no composition or people access. Join it only when assembling the document.
    const { document, tenantContextAvailable } = yield* Effect.all(
      {
        document: Effect.gen(function* loadDocument() {
          if (context.state !== 'authenticated') {
            return {
              // Tenant authentication is valid, but a company composition still requires a selected company.
              composition: {
                navigation: [] as const,
                state: context.state === 'tenant_authenticated' ? ('selection_required' as const) : context.state,
              },
              session,
              tenants,
            };
          }
          const { legalEntityId } = context.identity;
          const { principal } = context;
          if (!hasCompanyScope(principal) || principal.legalEntityId !== legalEntityId) {
            return yield* Effect.fail(authenticationInternalProblem());
          }
          const capability = yield* Effect.forkChild(
            peopleAdministrationCapability({ principal }).pipe(
              Effect.map(({ canManage }) => canManage),
              Effect.orElseSucceed(() => false),
            ),
            { startImmediately: true },
          );
          const composition = Effect.gen(function* loadDocumentComposition() {
            const catalog = yield* captureShellRelease(payload.compositionRevision).pipe(
              observeGatewayPhase('document-admission'),
            );
            // The page target reads beside the composition, against the same captured release.
            const target =
              payload.target === undefined
                ? Option.none<Fiber.Fiber<ShellDocumentTarget>>()
                : Option.some(
                    yield* Effect.forkChild(documentTarget(request, payload.target, principal, catalog, 'company'), {
                      startImmediately: true,
                    }),
                  );
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
            return { catalog, composition: documentComposition, target };
          }).pipe(
            observeGatewayPhase('document-composition'),
            Effect.catch((error) =>
              Effect.succeed({
                catalog: null,
                composition: {
                  state: Predicate.isTagged(error, 'ShellReloadRequiredProblem')
                    ? ('reload_required' as const)
                    : ('unavailable' as const),
                },
                target: Option.none<Fiber.Fiber<ShellDocumentTarget>>(),
              }),
            ),
          );
          const captured = yield* composition;
          const documentComposition = captured.composition;
          const baseDocument = { composition: documentComposition, session, tenants };
          const base =
            documentComposition.state === 'available'
              ? { ...baseDocument, compositionRevision: documentComposition.compositionRevision }
              : baseDocument;
          if (documentComposition.state !== 'available' || captured.catalog === null) {
            return base;
          }
          // Shell-owned people navigation does not depend on a workforce module contributing a legacy capability item.
          const canManagePeople = yield* Fiber.join(capability);
          const home =
            payload.home === true
              ? yield* resolveDocumentHome({
                  canManagePeople,
                  composition: documentComposition,
                  principal,
                }).pipe(
                  observeGatewayPhase('document-home'),
                  Effect.provideService(CapturedShellCompositionCatalog, captured.catalog),
                  Effect.provideService(DocumentHomeCorrelationId, correlationFromRequest(request)),
                )
              : undefined;
          const withHome = home === undefined ? { ...base, canManagePeople } : { ...base, canManagePeople, home };
          return Option.isNone(captured.target)
            ? withHome
            : { ...withHome, target: yield* Fiber.join(captured.target.value) };
        }),
        tenantContextAvailable: canSelectTenantContext(context.principal).pipe(Effect.orElseSucceed(() => false)),
      },
      { concurrency: 2 },
    );
    let tenantRelease = Option.none<string>();
    let tenantTarget = Option.none<ShellDocumentTarget>();
    if (context.state === 'tenant_authenticated') {
      // The release hint serves only tenant-context page dispatch, so it goes to exactly the people that
      // dispatch admits: `core.shell.tenant-module-target.resolve`, asked in the tenant context (O28).
      const gate = yield* AccessDecisionGate;
      const decision = yield* gate.decide({
        carrier: { accessDeclaration: TENANT_MODULE_TARGET_ACCESS_DECLARATION },
        legalEntityScope: 'optional',
        now: yield* DateTime.nowAsDate,
        scope: preserveSystemPrincipalContextTrust(context.principal, {
          ...context.principal,
          correlationId: correlationFromRequest(request),
        }),
      });
      if (decision.outcome === 'ALLOWED') {
        const tenantCatalog = yield* captureShellRelease(payload.compositionRevision).pipe(Effect.option);
        tenantRelease = tenantCatalog.pipe(Option.map((catalog) => catalog.composition.revision));
        // A page target counts only beside the release hint; without it the page shows "select a company".
        if (Option.isSome(tenantCatalog) && payload.target !== undefined) {
          tenantTarget = Option.some(
            yield* documentTarget(request, payload.target, context.principal, tenantCatalog.value, 'tenant'),
          );
        }
      }
    }
    const result = {
      ...document,
      legalEntities: withOptionalProperty(
        { legalEntities: context.availableLegalEntities, tenantContextAvailable },
        context.state === 'authenticated',
        'selectedLegalEntityId',
        context.state === 'authenticated' ? context.identity.legalEntityId : undefined,
        { state: context.state },
      ),
    };
    if (Option.isNone(tenantRelease)) {
      return result;
    }
    const withRelease = { ...result, compositionRevision: tenantRelease.value };
    return Option.isSome(tenantTarget) ? { ...withRelease, target: tenantTarget.value } : withRelease;
  },
);

// Session, legal-entity and composition checks of one document share their SpiceDB decisions.
const documentContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'documentContext', (handlers) =>
  handlers.handle('documentContext', ({ payload, request }) =>
    documentContextHandler(request, payload).pipe(
      Effect.flatMap((response) => decodeResponse(ShellDocumentContextSchema, response, authenticationInternalProblem)),
      withGatewayTimings,
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
        yield* noStore;
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
      resolveModuleTargetHandler(request, payload).pipe(
        recoverUnexpectedDefect(request, 'Unexpected module target defect', () =>
          failShellProblem(shellInternalProblem()),
        ),
      ),
    )
    .handle('resolveModuleTargets', ({ payload, request }) =>
      moduleTargetsHandler(request, payload).pipe(
        recoverUnexpectedDefect(request, 'Unexpected module targets defect', () =>
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

/** Search selectors are caller input; an unknown or unadmitted selector is the same safe 400. */
const shellSearchReadProblem = (error: ReadCoreError) =>
  Predicate.isTagged(error, 'ReadInputValidationError')
    ? problemDetails(
        'ShellInvalidRequestProblem',
        'The search request is invalid.',
        400,
        'Invalid search request',
        'https://ontos.dev/problems/search-invalid-request',
      )
    : shellListReadProblem(error);

/** The governed search read already validated its response against ShellSearchResponseSchema, so it is returned as is. */
export const shellSearchHandler = (request: RequestWithHeaders, payload: ShellSearchPayload) =>
  Effect.gen(function* searchHandler() {
    const session = yield* requireShellSession(request.headers);
    if (session.state !== 'authenticated' && session.state !== 'tenant_authenticated') {
      return yield* failShellProblem(shellSelectionRequiredProblem());
    }
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
        Effect.catch((error) => pipe(error, shellSearchReadProblem, failShellProblem)),
      );
    return response;
  }).pipe(
    recoverUnexpectedDefect(request, 'Unexpected Shell search defect', () => failShellProblem(shellInternalProblem())),
  );

const resourcesGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'resources', (handlers) =>
  handlers
    .handle('search', ({ payload, request }) => shellSearchHandler(request, payload))
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
    const { principal } = session;
    if (!hasCompanyScope(principal) || principal.legalEntityId !== legalEntityId) {
      return yield* failIdentityProblem(shellTargetForbiddenProblem());
    }
    return {
      legalName:
        session.availableLegalEntities.find((entry) => entry.legalEntityId === legalEntityId)?.legalName ??
        legalEntityId,
      principal,
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
          yield* rebrandRentalDemoAccounts(context.principal.tenantId).pipe(
            Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
          );
          return yield* decodeResponse(ConfigureDemoCompaniesResponseSchema, response, shellInternalProblem);
        }),
      ),
    )
    .handle('demoAccountCapability', ({ request }) =>
      safeIdentity(
        request,
        Effect.gen(function* demoAccountCapabilityHandler() {
          const caller = yield* demoAccountCaller(request);
          const response = yield* peopleAdministrationCapability(caller);
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
          // Two canonical carriers, one owner implementation: the tenant-managed list is decided in
          // the tenant context, the company-agent list in the exact named company (O7, O28).
          const transport = { correlationId: correlationFromRequest(request) };
          const result = yield* (
            payload.scope === 'company-agent'
              ? runtime.runRead({
                  input: payload,
                  principal: resolved.principal,
                  registration: companyManagedPrincipalsRead,
                  transport,
                })
              : runtime.runRead({
                  input: payload,
                  principal: resolved.principal,
                  registration: managedPrincipalsRead,
                  transport,
                })
          ).pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
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

const requireGatewayRelease = Effect.fn('ShellGateway.requireRelease')(function* requireGatewayReleaseEffect(
  compositionRevision: string | undefined,
  /** For a browser-session endpoint: what to log when its document's release is refused. */
  caller?: { readonly endpoint: string; readonly headers: GatewayReleaseRefusalHeaders },
) {
  const authority = yield* ShellInstalledModuleCatalog;
  const catalog = yield* authority.load.pipe(
    observeGatewayPhase('gateway-release'),
    Effect.catchTags({
      InstalledModuleCatalogInvalidError: () =>
        failGatewayProblem(
          withRefusalReason(gatewayAuthenticationUnavailableProblem(), 'installed_release_unavailable'),
        ),
      InstalledModuleCatalogUnavailableError: () =>
        failGatewayProblem(
          withRefusalReason(gatewayAuthenticationUnavailableProblem(), 'installed_release_unavailable'),
        ),
    }),
  );
  if (
    (compositionRevision !== undefined && compositionRevision !== catalog.composition.revision) ||
    catalog.composition.shell.deployment.appId !== ultramodernDeliveryUnit.appId ||
    catalog.composition.shell.deployment.buildMarker !== ultramodernDeliveryUnit.buildMarker
  ) {
    if (caller !== undefined) {
      yield* Effect.logInfo('gateway release refused').pipe(
        Effect.annotateLogs({
          ...gatewayReleaseRefusal({
            currentRevision: catalog.composition.revision,
            endpoint: caller.endpoint,
            headers: caller.headers,
            sentRevision: compositionRevision ?? null,
          }),
          shellBuildCurrent: catalog.composition.shell.deployment.buildMarker === ultramodernDeliveryUnit.buildMarker,
        }),
      );
    }
    return yield* failGatewayProblem(
      extendedProblemDetails(
        'GatewayReloadRequiredProblem',
        'The document release is no longer admitted. Reload to continue.',
        409,
        'Reload required',
        'https://ontos.dev/problems/gateway-reload-required',
        { reason: 'release_changed' as const, reloadRequired: true as const },
      ),
    );
  }
  return catalog.composition.revision;
});

/** Mints a subject's gateway context for an integration API key; a module credential is never such a key. */
export const issueApiKeyContext = Effect.fn('ShellGateway.issueApiKeyContext')(function* issueApiKeyContextEffect(
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
  // A module credential acts only through the delegated endpoint, which names the subject it acts for.
  yield* admitIntegrationCredential(verified.providerKeyId).pipe(
    Effect.catchTag('GatewayDelegationError', (error) =>
      failApiKeyGatewayProblem(
        error.code === 'forbidden' ? gatewayForbiddenProblem() : gatewayAuthenticationUnavailableProblem(),
      ),
    ),
  );
  const identity = yield* resolver.resolveBetterAuthApiKey(verified.providerKeyId).pipe(
    observeGatewayPhase('principal-resolve'),
    Effect.catch((error) => pipe(error, principalResolutionGatewayProblem, failApiKeyGatewayProblem)),
  );
  // An internal workload principal acts only with the key the platform issued it for this release.
  yield* (yield* PlatformWorkloadKeyAdmission)
    .admit({
      legalEntityId: payload.legalEntityId ?? null,
      principalId: identity.principalId,
      providerKeyId: verified.providerKeyId,
      tenantId: identity.tenantId,
    })
    .pipe(
      Effect.catchTag('GatewayDelegationError', (error) =>
        failApiKeyGatewayProblem(
          error.code === 'forbidden'
            ? withRefusalReason(gatewayForbiddenProblem(), error.reason)
            : withRefusalReason(gatewayAuthenticationUnavailableProblem(), error.reason),
        ),
      ),
    );
  const principal = withOptionalProperty(
    {
      authBindingId: identity.authBindingId,
      authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      authMethod: 'api_key' as const,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    },
    payload.legalEntityId !== undefined,
    'legalEntityId',
    payload.legalEntityId,
    {},
  );
  const scopeResolver = yield* OperationalScopeResolver;
  const random = yield* Crypto.Crypto;
  const scope = yield* scopeResolver
    .resolve({
      correlationId: yield* random
        .randomUUIDv4()
        .pipe(
          Effect.catch((error) =>
            Effect.logError('Unable to create a gateway correlation identifier', error).pipe(
              Effect.andThen(failApiKeyGatewayProblem(gatewayAuthorizationUnavailableProblem())),
            ),
          ),
        ),
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
  if (payload.legalEntityId !== undefined) {
    yield* validateAuthorizedLegalEntity({
      legalEntityId: payload.legalEntityId,
      scope,
    }).pipe(
      Effect.catch((error) =>
        failApiKeyGatewayProblem(
          Predicate.isTagged(error, 'LegalEntitySelectionUnavailableError')
            ? gatewayAuthorizationUnavailableProblem()
            : gatewayForbiddenProblem(),
        ),
      ),
    );
  }
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
/**
 * The staff namespace is registered for exactly the source apps the module credentials are enrolled for. With no
 * bound module credential it is registered for none, and the issuer refuses the key as unbound.
 */
const delegationNamespaceRegistryEffect = loadGatewayModuleBindings.pipe(
  Effect.mapError(bindingsUnavailable),
  Effect.flatMap((bindings) =>
    (bindings.length === 0
      ? makeAuthenticationNamespaceRegistryEffect([])
      : staffAuthenticationNamespaceRegistration([...new Set(bindings.map((binding) => binding.sourceAppId))]).pipe(
          Effect.flatMap((registration) => makeAuthenticationNamespaceRegistryEffect([registration])),
        )
    ).pipe(Effect.mapError(delegationUnavailable('module_enrolment_unavailable'))),
  ),
);

/** The reason code of a key the provider could not verify, when the provider (not the key) is at fault. */
const apiKeyProviderRefusalReason = (error: ApiKeyProviderError): GatewayRefusalReason | null =>
  Match.value(error).pipe(
    Match.tags({
      ApiKeyCredentialInvalidError: () => null,
      ApiKeyProviderUnavailableError: () => 'key_provider_unavailable' as const,
      ApiKeyRateLimitedError: () => null,
      ApiKeyStateInconsistentError: () => 'key_state_inconsistent' as const,
    }),
    Match.exhaustive,
  );

const gatewayContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'gatewayContext', (handlers) =>
  handlers
    .handle('issueGatewayContext', ({ payload, request }) =>
      Effect.gen(function* issueGatewayContextHandler() {
        yield* noStore;
        yield* requireGatewayRelease(payload.compositionRevision, {
          endpoint: 'auth/gateway-context',
          headers: { referer: request.headers['referer'], 'user-agent': request.headers['user-agent'] },
        });
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
    .handle('readWithApiKeyGatewayContext', ({ headers, payload: payloadBytes, request }) =>
      Effect.gen(function* readWithApiKeyGatewayContextHandler() {
        yield* noStore;
        const payload = yield* decodeApiKeyGatewayReadRequest(payloadBytes);
        const issuerMetadata =
          payload.legalEntityId === undefined
            ? { audience: payload.audience }
            : { audience: payload.audience, legalEntityId: payload.legalEntityId };
        const context = yield* issueApiKeyContext(issuerMetadata, headers['x-api-key'], request);
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
        const body = yield* payload.ownerBody.pipe(Effect.orDie);
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
            HttpServerResponse.schemaJson(Schema.Struct({ code: Schema.Literal('gateway_dispatch_failed') }))(
              { code: 'gateway_dispatch_failed' },
              { status: Predicate.isTagged(error, 'ModuleApiDispatchError') ? error.status : 503 },
            ).pipe(Effect.map(HttpServerResponse.toWeb), Effect.orDie),
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
    )
    .handle('issueDelegatedGatewayContext', ({ headers, payload, request }) =>
      Effect.gen(function* issueDelegatedGatewayContextHandler() {
        // A refusal before the issuer runs: one warning, and its reason in the problem the caller receives. Nothing
        // here is authenticated yet, so the warning names no calling module and no tenant from the request body.
        const refuse = <Problem extends GatewayContextProblem>(refusedProblem: Problem, reason: GatewayRefusalReason) =>
          logDelegationRefusal({
            audience: payload.audience,
            context: {},
            reason,
            status: refusedProblem._tag,
          }).pipe(Effect.andThen(failApiKeyGatewayProblem(withRefusalReason(refusedProblem, reason))));
        yield* requireGatewayRelease(payload.compositionRevision).pipe(
          Effect.catch((releaseError) =>
            releaseError.reason === undefined ? Effect.fail(releaseError) : refuse(releaseError, releaseError.reason),
          ),
        );
        const keys = yield* ApiKeyService;
        const rawKey = headers['x-api-key'];
        if (rawKey === undefined || rawKey.trim().length === 0) {
          return yield* failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem());
        }
        const verified = yield* keys.verify(rawKey).pipe(
          Effect.catch((error) => {
            const reason = apiKeyProviderRefusalReason(error);
            return reason === null
              ? failApiKeyGatewayProblem(apiKeyProviderGatewayProblem(error))
              : refuse(apiKeyProviderGatewayProblem(error), reason);
          }),
        );
        const delegationNamespaceRegistry = yield* delegationNamespaceRegistryEffect.pipe(
          Effect.catchTag('GatewayDelegationError', (error) =>
            refuse(gatewayAuthenticationUnavailableProblem(), error.reason),
          ),
        );
        // The issuer writes the warning of its own refusals: it knows the calling module and the subject's tenant.
        return yield* issueDelegatedGatewayContextAssertion({
          payload,
          requestCorrelation: correlationFromRequest(request),
          verifiedProviderKeyId: verified.providerKeyId,
        }).pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, delegationNamespaceRegistry),
          Effect.catchTags({
            GatewayDelegationError: (error) =>
              failApiKeyGatewayProblem(
                withRefusalReason(
                  Match.value(error.code).pipe(
                    Match.when('authentication_required', () => gatewayAuthenticationRequiredProblem()),
                    Match.when('forbidden', () => gatewayForbiddenProblem()),
                    Match.when('module_not_installed', () => gatewayModuleNotInstalledProblem()),
                    Match.when('unavailable', () => gatewayAuthenticationUnavailableProblem()),
                    Match.when('reload_required', () =>
                      extendedProblemDetails(
                        'GatewayReloadRequiredProblem',
                        'The document release is no longer admitted. Reload to continue.',
                        409,
                        'Reload required',
                        'https://ontos.dev/problems/gateway-reload-required',
                        { reloadRequired: true as const },
                      ),
                    ),
                    Match.exhaustive,
                  ),
                  error.reason,
                ),
              ),
            GatewayIssuerError: (error) =>
              failApiKeyGatewayProblem(
                Match.value(gatewayIssuerProblem(error)).pipe(
                  Match.tag('GatewayUnavailableProblem', (issuerProblem) =>
                    withRefusalReason(issuerProblem, 'issuer_unavailable'),
                  ),
                  Match.orElse((issuerProblem) => issuerProblem),
                ),
              ),
          }),
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected gateway delegation defect', () =>
          failApiKeyGatewayProblem(gatewayInternalProblem()),
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
      yield* requireGatewayRelease(payload.compositionRevision, {
        endpoint: 'auth/gateway-contexts',
        headers: { referer: request.headers['referer'], 'user-agent': request.headers['user-agent'] },
      });
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

/** Refuse cross-site origins before session mutations. */
const requireShellOrigin = Effect.fn('shell.connectionsAdmin.requireShellOrigin')(function* requireShellOrigin(
  request: RequestWithHeaders,
) {
  const config = yield* loadOAuthServerConfig;
  const issuerOrigin = URL.canParse(config.issuer) ? new URL(config.issuer).origin : '';
  if (!isSameOriginRequest(request.headers, issuerOrigin)) {
    return yield* failIdentityProblem(
      problemDetails(
        'ShellTargetForbiddenProblem',
        'Žádost nepřišla z OntOS. Otevřete aplikaci v OntOS a zkuste to znovu.',
        403,
        'Module target forbidden',
        'https://ontos.dev/problems/module-target-forbidden',
      ),
    );
  }
  return yield* Effect.void;
});

// Platform approval layer for AI agents (lane approvals-platform). Agents use their API key; people their session.
type AgentPlatformError = Effect.Error<
  ReturnType<
    | typeof submitAgentProposals
    | typeof listOwnAgentBatches
    | typeof loadAgentActivity
    | typeof loadAgentQueue
    | typeof decideAgentItems
    | typeof revertAgentBatch
  >
>;

const agentPlatformFailure = (error: AgentPlatformError) => {
  if (Schema.isSchemaError(error)) {
    return failIdentityProblem(shellInvalidRequestProblem());
  }
  return Match.value(error).pipe(
    Match.tags({
      AgentModuleCallError: () => failIdentityProblem(shellCapabilityUnavailableProblem()),
      AgentPlatformForbidden: ({ reason }) =>
        failIdentityProblem(
          problemDetails(
            'ShellTargetForbiddenProblem',
            reason,
            403,
            'Module target forbidden',
            'https://ontos.dev/problems/module-target-forbidden',
          ),
        ),
      AgentPlatformInvalid: ({ reason }) =>
        failIdentityProblem(
          problemDetails(
            'ShellPolicyUnprocessableProblem',
            reason,
            422,
            'Policy violation',
            'https://ontos.dev/problems/policy-violation',
          ),
        ),
      AgentProposalCommandError: ({ code }) =>
        failIdentityProblem(
          Match.value(code).pipe(
            Match.when('agent_proposal_conflict', shellPolicyConflictProblem),
            Match.when('agent_proposal_invalid', shellPolicyUnprocessableProblem),
            Match.when('agent_proposal_unavailable', shellCapabilityUnavailableProblem),
            Match.exhaustive,
          ),
        ),
      AgentStoreUnavailable: () => failIdentityProblem(shellCapabilityUnavailableProblem()),
    }),
    Match.orElse((nativeError) => pipe(nativeError, identityProblem, failIdentityProblem)),
  );
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
  const { principal } = session;
  if (!hasCompanyScope(principal) || principal.legalEntityId !== legalEntityId) {
    return yield* failIdentityProblem(shellTargetForbiddenProblem());
  }
  // The one scope every gate question of this caller runs in: resolved once here, from the session's own carrier.
  const scopeResolver = yield* OperationalScopeResolver;
  const scope = yield* scopeResolver
    .resolve({
      correlationId: correlationFromRequest(request),
      legalEntityScope: 'required',
      principal,
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
  const caller: AgentPlatformCaller = {
    legalName:
      session.availableLegalEntities.find((entry) => entry.legalEntityId === legalEntityId)?.legalName ?? legalEntityId,
    principal,
    scope,
  };
  return caller;
});

export const agentPlatformKeyCaller = Effect.fn('shell.agentPlatform.keyCaller')(function* agentPlatformKeyCaller(
  rawKey: string | undefined,
  legalEntityId: string,
) {
  if (rawKey === undefined || rawKey.trim().length === 0) {
    return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
  }
  const keys = yield* ApiKeyService;
  const resolver = yield* PrincipalResolver;
  const verified = yield* keys.verify(rawKey).pipe(
    Effect.catchTags({
      ApiKeyCredentialInvalidError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      ApiKeyProviderUnavailableError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      ApiKeyRateLimitedError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      ApiKeyStateInconsistentError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
    }),
  );
  // A module credential acts only through the delegated endpoint, never as an agent of its own.
  yield* admitIntegrationCredential(verified.providerKeyId).pipe(
    Effect.catchTag('GatewayDelegationError', (error) =>
      failIdentityProblem(
        error.code === 'forbidden' ? shellTargetForbiddenProblem() : shellCapabilityUnavailableProblem(),
      ),
    ),
  );
  const identity = yield* resolver.resolveBetterAuthApiKey(verified.providerKeyId).pipe(
    Effect.catchTags({
      PrincipalBindingAmbiguousError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      PrincipalBindingInactiveError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      PrincipalBindingMissingError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      PrincipalInactiveError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      PrincipalResolverUnavailableError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
      TenantInactiveError: () => failIdentityProblem(shellAuthenticationRequiredProblem()),
    }),
  );
  // An internal workload principal acts only with the key the platform issued it, never as an agent caller.
  yield* (yield* PlatformWorkloadKeyAdmission)
    .admit({
      legalEntityId,
      principalId: identity.principalId,
      providerKeyId: verified.providerKeyId,
      tenantId: identity.tenantId,
    })
    .pipe(
      Effect.catchTag('GatewayDelegationError', (error) =>
        failIdentityProblem(
          error.code === 'forbidden' ? shellTargetForbiddenProblem() : shellCapabilityUnavailableProblem(),
        ),
      ),
    );
  const principal: AgentPlatformCaller['principal'] = {
    authBindingId: identity.authBindingId,
    authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'api_key' as const,
    legalEntityId,
    principalId: identity.principalId,
    tenantId: identity.tenantId,
  };
  const scopeResolver = yield* OperationalScopeResolver;
  const random = yield* Crypto.Crypto;
  // The one scope every gate question of this caller runs in: the API-key carrier revalidated against persistence.
  const scope = yield* scopeResolver
    .resolve({
      correlationId: yield* random
        .randomUUIDv4()
        .pipe(
          Effect.catch((error) =>
            Effect.logError('Unable to create an agent correlation identifier', error).pipe(
              Effect.andThen(failIdentityProblem(shellCapabilityUnavailableProblem())),
            ),
          ),
        ),
      legalEntityScope: 'required',
      principal,
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
  const selected = yield* validateAuthorizedLegalEntity({ legalEntityId, scope }).pipe(
    Effect.catchTags({
      LegalEntitySelectionForbiddenError: () => failIdentityProblem(shellTargetForbiddenProblem()),
      LegalEntitySelectionUnavailableError: () => failIdentityProblem(shellCapabilityUnavailableProblem()),
    }),
  );
  return { legalName: selected.legalName, principal, scope } satisfies AgentPlatformCaller;
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
        const transport = {
          correlationId: correlationFromRequest(request),
          idempotencyKey: yield* requiredIdempotencyKey(headers),
        };
        const response = yield* submitAgentProposals(agent, submission).pipe(
          Effect.provideService(AgentReadRequestIdentity, transport),
          Effect.provideService(AgentActionRequestIdentity, transport),
          Effect.catch(agentPlatformFailure),
        );
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('listOwnAgentProposals', ({ headers, payload, request }) =>
      Effect.gen(function* listOwnAgentProposalsHandler() {
        const agent = yield* agentPlatformKeyCaller(headers['x-api-key'], payload.legalEntityId);
        const response = yield* listOwnAgentBatches(agent).pipe(
          Effect.provideService(AgentReadRequestIdentity, { correlationId: correlationFromRequest(request) }),
          Effect.catch(agentPlatformFailure),
        );
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentQueue', ({ payload, request }) =>
      Effect.gen(function* agentQueueHandler() {
        const caller = yield* agentPlatformSessionCaller(request);
        const response = yield* withRoundTripLog('queue', loadAgentQueue(caller, payload)).pipe(
          Effect.provideService(AgentReadRequestIdentity, { correlationId: correlationFromRequest(request) }),
          Effect.catch(agentPlatformFailure),
        );
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentDecide', ({ headers, payload, request }) =>
      Effect.gen(function* agentDecideHandler() {
        yield* requireShellOrigin(request);
        const caller = yield* agentPlatformSessionCaller(request);
        const transport = {
          correlationId: correlationFromRequest(request),
          idempotencyKey: yield* requiredIdempotencyKey(headers),
        };
        const response = yield* withRoundTripLog('decide', decideAgentItems(caller, payload)).pipe(
          Effect.provideService(AgentReadRequestIdentity, transport),
          Effect.provideService(AgentActionRequestIdentity, transport),
          Effect.catch(agentPlatformFailure),
        );
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentRevert', ({ headers, payload, request }) =>
      Effect.gen(function* agentRevertHandler() {
        yield* requireShellOrigin(request);
        const caller = yield* agentPlatformSessionCaller(request);
        const transport = {
          correlationId: correlationFromRequest(request),
          idempotencyKey: yield* requiredIdempotencyKey(headers),
        };
        const response = yield* withRoundTripLog('revert', revertAgentBatch(caller, payload)).pipe(
          Effect.provideService(AgentReadRequestIdentity, transport),
          Effect.provideService(AgentActionRequestIdentity, transport),
          Effect.catch(agentPlatformFailure),
        );
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    )
    .handle('agentActivity', ({ payload, request }) =>
      Effect.gen(function* agentActivityHandler() {
        const caller = yield* agentPlatformSessionCaller(request);
        const transport = { correlationId: correlationFromRequest(request) };
        const services = yield* Layer.build(CompanyDirectoryLive({ principal: caller.principal, transport }));
        const response = yield* withRoundTripLog('activity', loadAgentActivity(caller, payload)).pipe(
          Effect.provideService(AgentReadRequestIdentity, transport),
          Effect.provide(services),
          Effect.catch(agentPlatformFailure),
        );
        yield* noStore;
        return response;
      }).pipe(agentPlatformDefect(request)),
    ),
);

// "Připojené aplikace" management (lane mcp-connections-ui): session callers; grants via connection-grants services.
const connectionsAdminFailure = (error: ConnectionsAdminError) =>
  Match.value(error).pipe(
    Match.tags({
      ConnectionsForbidden: ({ reason }) =>
        failIdentityProblem(
          problemDetails(
            'ShellTargetForbiddenProblem',
            reason,
            403,
            'Module target forbidden',
            'https://ontos.dev/problems/module-target-forbidden',
          ),
        ),
      ConnectionsGone: ({ reason }) =>
        failIdentityProblem(
          problemDetails(
            'ShellPolicyConflictProblem',
            reason,
            409,
            'Policy conflict',
            'https://ontos.dev/problems/policy-conflict',
          ),
        ),
      ConnectionsInvalid: ({ reason }) =>
        failIdentityProblem(
          problemDetails(
            'ShellPolicyUnprocessableProblem',
            reason,
            422,
            'Policy violation',
            'https://ontos.dev/problems/policy-violation',
          ),
        ),
      ConnectionsNotFound: ({ reason }) =>
        failIdentityProblem(
          problemDetails(
            'ShellTargetNotFoundProblem',
            reason,
            404,
            'Target not found',
            'https://ontos.dev/problems/target-not-found',
          ),
        ),
      // Unavailability is retryable for the caller, but the operator needs the underlying cause.
      ConnectionsUnavailable: (failure) =>
        Effect.logWarning('Connections administration unavailable', Cause.fail(failure)).pipe(
          Effect.andThen(failIdentityProblem(shellCapabilityUnavailableProblem())),
        ),
    }),
    Match.exhaustive,
  );

const connectionsCaller = Effect.fn('shell.connectionsAdmin.caller')(function* connectionsCaller(
  request: RequestWithHeaders,
  withAdminRight: boolean,
) {
  const caller = yield* agentPlatformSessionCaller(request);
  // The company's connected applications are administered through Core's own capability carrier,
  // `core.identity.oauth-connection.administer`: admitting the read is the answer.
  const isCompanyAdmin = withAdminRight
    ? yield* (yield* ReadRuntime)
        .runRead({
          input: {},
          principal: caller.principal,
          registration: oauthConnectionAdministrationRead,
          transport: { correlationId: correlationFromRequest(request) },
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
    : false;
  const result: ConnectionsCaller = {
    isCompanyAdmin,
    legalEntityId: caller.principal.legalEntityId,
    legalName: caller.legalName,
    principal: caller.principal,
    principalId: caller.principal.principalId,
    tenantId: caller.principal.tenantId,
  };
  return result;
});

const connectionsAdminDefect = (request: RequestWithHeaders) =>
  recoverUnexpectedDefect(request, 'Unexpected connections admin defect', () =>
    failIdentityProblem(shellInternalProblem()),
  );

const peopleAdministrationFailure = (error: IdentityRuntimeError | Schema.SchemaError) =>
  Schema.isSchemaError(error)
    ? failIdentityProblem(shellInternalProblem())
    : failIdentityProblem(identityProblem(error));

const peopleAdministrationGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'peopleAdministration',
  (handlers) => {
    const principalFor = Effect.fn('shell.peopleAdministration.principalFor')(function* peoplePrincipal(
      request: RequestWithHeaders,
      scope: 'company' | 'tenant',
    ) {
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
        if (!hasCompanyScope(session.principal) || session.principal.legalEntityId !== session.identity.legalEntityId) {
          return yield* failIdentityProblem(shellTargetForbiddenProblem());
        }
        return session.principal;
      }
      const session = yield* authentication
        .resolveTenantContext(requestHeaders(request.headers))
        .pipe(Effect.catch((error) => failIdentityProblem(identityProblem(error))));
      yield* forwardSetCookieHeaders(session.setCookieHeaders);
      if (session.state !== 'authenticated') {
        return yield* failIdentityProblem(shellAuthenticationRequiredProblem());
      }
      // Tenant admission must issue the original tenant carrier, never a modified company carrier.
      if (session.principal.legalEntityId !== undefined) {
        return yield* failIdentityProblem(shellTargetForbiddenProblem());
      }
      return session.principal;
    });
    const commandContext = Effect.fn('shell.peopleAdministration.commandContext')(function* peopleCommandContext(
      request: RequestWithHeaders,
      headers: RequestHeaders,
      scope: 'company' | 'tenant',
    ) {
      yield* requireShellOrigin(request);
      const idempotencyKey = headerValue(headers, 'idempotency-key');
      if (idempotencyKey === undefined) {
        return yield* failIdentityProblem(shellPreconditionRequiredProblem());
      }
      const principal = yield* principalFor(request, scope);
      return { principal, transport: { correlationId: correlationFromRequest(request), idempotencyKey } };
    });
    return handlers
      .handle('requestPeopleSearchRebuild', ({ headers, payload, request }) =>
        Effect.gen(function* rebuildPeopleSearchHandler() {
          const context = yield* commandContext(request, headers, 'tenant');
          const result = yield* requestPeopleSearchRebuild(context, payload).pipe(
            Effect.catch(peopleAdministrationFailure),
          );
          return yield* decodeResponse(RequestPeopleSearchRebuildHttpResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('invitePerson', ({ headers, payload, request }) =>
        Effect.gen(function* invitePersonHandler() {
          const context = yield* commandContext(request, headers, 'company');
          const result = yield* invitePeoplePerson(context, payload).pipe(Effect.catch(peopleAdministrationFailure));
          return yield* decodeResponse(InvitePeopleResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listCompanyPeople', ({ payload, request }) =>
        Effect.gen(function* listCompanyPeopleHandler() {
          const principal = yield* principalFor(request, 'company');
          const result = yield* listPeople(principal, payload, correlationFromRequest(request)).pipe(
            Effect.catch(peopleAdministrationFailure),
          );
          return yield* decodeResponse(PeopleListResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listTenantPeople', ({ payload, request }) =>
        Effect.gen(function* listTenantPeopleHandler() {
          const principal = yield* principalFor(request, 'tenant');
          const result = yield* listPeople(principal, payload, correlationFromRequest(request)).pipe(
            Effect.catch(peopleAdministrationFailure),
          );
          return yield* decodeResponse(PeopleListResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('setPeopleCompanyMembership', ({ headers, payload, request }) =>
        Effect.gen(function* setCompanyMembershipHandler() {
          const context = yield* commandContext(request, headers, 'company');
          const result = yield* setPeopleCompanyMembership(context, payload).pipe(
            Effect.catch(peopleAdministrationFailure),
          );
          return yield* decodeResponse(SetPeopleCompanyMembershipResponseSchema, result, shellInternalProblem);
        }).pipe(connectionsAdminDefect(request)),
      );
  },
);

const connectionsAdminDeps = Effect.fn('shell.connectionsAdmin.dependencies')(function* connectionsAdminDeps(
  caller: Pick<ConnectionsCaller, 'principal'>,
  transport: OperationalScopeRequest & { readonly idempotencyKey?: string },
) {
  const request = { principal: caller.principal, transport };
  const services = yield* Layer.build(Layer.merge(CompanyDirectoryLive(request), GrantAdminLive(request))).pipe(
    Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
  );
  const directory = Context.get(services, CompanyDirectory);
  const grants = Context.get(services, GrantAdmin);
  const mcpUrl = yield* mcpResourceUrl;
  const deps: ConnectionsAdminDeps<never> = {
    directory,
    grants,
    mcpUrl,
  };
  return deps;
});

const oauthConnectionsAdminGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'oauthConnectionsAdmin',
  (handlers) =>
    handlers
      .handle('listMyConnections', ({ request }) =>
        Effect.gen(function* listMyConnectionsHandler() {
          yield* noStore;
          const caller = yield* connectionsCaller(request, false);
          const deps = yield* connectionsAdminDeps(caller, { correlationId: correlationFromRequest(request) });
          const response = yield* listMine(caller, deps).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listCompanyConnections', ({ payload, request }) =>
        Effect.gen(function* listCompanyConnectionsHandler() {
          yield* noStore;
          const caller = yield* connectionsCaller(request, true);
          const deps = yield* connectionsAdminDeps(caller, { correlationId: correlationFromRequest(request) });
          const response = yield* listForAdmin(caller, deps, payload).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('updateConnectionAccess', ({ payload, request }) =>
        Effect.gen(function* updateConnectionAccessHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const caller = yield* connectionsCaller(request, false);
          const deps = yield* connectionsAdminDeps(caller, { correlationId: correlationFromRequest(request) });
          const response = yield* updateConnection(caller, deps, payload).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('revokeConnection', ({ payload, request }) =>
        Effect.gen(function* revokeConnectionHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const caller = yield* connectionsCaller(request, true);
          const deps = yield* connectionsAdminDeps(caller, { correlationId: correlationFromRequest(request) });
          const response = yield* revokeConnection(caller, deps, payload).pipe(Effect.catch(connectionsAdminFailure));
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('listAgentEntities', ({ request }) =>
        Effect.gen(function* listAgentEntitiesHandler() {
          yield* noStore;
          const caller = yield* agentPlatformSessionCaller(request);
          const deps = yield* connectionsAdminDeps(caller, { correlationId: correlationFromRequest(request) });
          const response = yield* listAgentEntities(caller, deps).pipe(
            Effect.provideService(AgentReadRequestIdentity, { correlationId: correlationFromRequest(request) }),
            Effect.catch(connectionsAdminFailure),
          );
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
          const transport = { correlationId: correlationFromRequest(request), idempotencyKey };
          const deps = yield* connectionsAdminDeps(caller, transport);
          const response = yield* manageAgentEntity(caller, payload, deps).pipe(
            Effect.provideService(AgentReadRequestIdentity, transport),
            Effect.provideService(AgentActionRequestIdentity, transport),
            Effect.catch(connectionsAdminFailure),
          );
          return response;
        }).pipe(connectionsAdminDefect(request)),
      )
      .handle('replaceAgentOperators', ({ payload, request }) =>
        Effect.gen(function* replaceAgentOperatorsHandler() {
          yield* noStore;
          yield* requireShellOrigin(request);
          const caller = yield* connectionsCaller(request, true);
          const deps = yield* connectionsAdminDeps(caller, { correlationId: correlationFromRequest(request) });
          const response = yield* replaceAgentOperators(caller, deps, payload).pipe(
            Effect.catch(connectionsAdminFailure),
          );
          return response;
        }).pipe(connectionsAdminDefect(request)),
      ),
);

// Only static configuration, ready Better Auth instances and imported public keys survive request scopes.
// Pools, adapters, session callbacks and JWKS reads remain bound to the current request.
const authenticationIsolateRuntime = ManagedRuntime.make(Layer.merge(BetterAuthRuntimeLive, OAuthAccessTokensLive));
const authenticationIsolateLive = Layer.effectContext(authenticationIsolateRuntime.contextEffect);
const corePersistenceLive = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
/**
 * The Shell's own database identity enrollment, owner-neutral for the API process: it declares only the
 * published identity contracts this process issues owner-scoped gateway grants for. Every Core access port
 * and store reads it beside `CoreDatabase`, so it is provided explicitly here and in the worker host.
 */
const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT);
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
  Layer.provide(databaseIdentitiesLive),
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
const betterAuthNativeAdapterLive = BetterAuthNativeAdapterLive.pipe(Layer.provide(authPersistenceLive));
const oauthAuthenticationAuditLive = OAuthAuthenticationAuditLive.pipe(Layer.provide(corePersistenceLive));
const oauthConnectionCompaniesLive = OAuthConnectionCompaniesLive.pipe(Layer.provide(corePersistenceLive));
const oauthGrantRegistryLive = OAuthGrantRegistryLive.pipe(Layer.provide(corePersistenceLive));
const oauthCredentialsLive = OAuthCredentialsLive.pipe(Layer.provide(authPersistenceLive));
const oauthGrantOwnersLive = OAuthGrantOwnersLive.pipe(Layer.provide(oauthGrantRegistryLive));
const oauthEndpointGuardDataLive = OAuthEndpointGuardDataLive.pipe(
  Layer.provide(Layer.merge(oauthGrantRegistryLive, oauthCredentialsLive)),
);
const principalResolverLive = PrincipalResolverLive({
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
}).pipe(Layer.provide(corePersistenceLive));
const legalEntityContextLive = LegalEntityContextLive.pipe(Layer.provide(corePersistenceLive));
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(corePersistenceLive));
const authenticationDependenciesLive = Layer.mergeAll(
  authenticationIsolateLive,
  authPersistenceLive,
  betterAuthNativeAdapterLive,
  oauthGrantRegistryLive,
  oauthCredentialsLive,
  oauthAuthenticationAuditLive,
  oauthEndpointGuardDataLive,
  defaultContextAccessLive,
  legalEntityContextLive,
  principalResolverLive,
);
// Framework dispatch, native session callbacks and guards stay in the same request scope.
const oauthConnectionHooksLive = OAuthConnectionHooksLive.pipe(Layer.provide(oauthGrantRegistryLive));
const betterAuthFrameworkLive = BetterAuthFrameworkLive().pipe(
  Layer.provide(Layer.merge(authenticationDependenciesLive, oauthConnectionHooksLive)),
);
const oauthEndpointGuardsLive = OAuthEndpointGuardsLive.pipe(
  Layer.provide(Layer.merge(authenticationDependenciesLive, betterAuthFrameworkLive)),
);
const authenticationServiceLive = AuthenticationServiceLive.pipe(
  Layer.provide(Layer.mergeAll(authenticationDependenciesLive, betterAuthFrameworkLive, oauthEndpointGuardsLive)),
  Layer.provide(ShellCryptoLive),
);
const apiKeyServiceLive = ApiKeyServiceLive.pipe(Layer.provide(Layer.merge(authPersistenceLive, ShellCryptoLive)));
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
  Layer.succeed(UrlParams.CurrentRedactedNames, authenticationQueryRedactions),
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
  Layer.provide(databaseIdentitiesLive),
);
type ShellGatewayIssuerLayer = Layer.Layer<GatewayIssuer, Layer.Error<typeof approvedGatewayIssuerLive>>;

/** Production provider projection: encode only canonical principal fields, never operational correlation/trace.
 * The real issuer still strictly decodes, binds the admitted audience/revision, signs and registers every assertion.
 */
export const issueShellSearchProviderAssertion = Effect.fn('ShellSearch.issueProviderAssertion')(
  function* issueProviderAssertion({
    appId,
    compositionRevision,
    context,
  }: Parameters<ShellProviderAssertionIssuer['issueAssertion']>[0]) {
    const gatewayIssuer = yield* GatewayIssuer;
    const principal = yield* Schema.encodeEffect(TrustedPrincipalContextSchema)(context).pipe(
      Effect.mapError((cause) => new ShellProviderUnavailableError({ cause })),
    );
    return yield* gatewayIssuer.issue({ audience: appId, compositionRevision, principal }).pipe(
      Effect.map(({ token }) => `Bearer ${token}`),
      Effect.catchTag('GatewayIssuerError', () => Effect.fail(new ShellProviderUnavailableError())),
    );
  },
);

const defaultScopedModuleStateFactory: ShellScopedModuleStateFactory = (transaction) =>
  makeTenantModuleStateService({ executor: transaction });

type ShellAuthenticationApiRuntimeArguments = readonly [
  authenticationLayer: ShellAuthenticationLayer,
  issuerLayer: ShellGatewayIssuerLayer,
  moduleStateLayer?: ShellModuleStateLayer,
  loadInstalledModuleCatalog?: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError> | undefined,
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
          Layer.provide(databaseIdentitiesLive),
        );
  const accessEnforcementLive = Layer.mergeAll(
    accessDecisionLayer ??
      (runtimeDatabase === undefined
        ? defaultAccessDecisionLive
        : AccessDecisionLive.pipe(Layer.provide(accessEnforcementPortsForRuntimeLive))),
    accessEnforcementPortsForRuntimeLive,
  );
  const actionAuthorityLayer = ActionAuthorityLive.pipe(
    Layer.provide(Layer.merge(activeApplicationCompositionLive, accessEnforcementLive)),
  );
  const subjectInspectionLayer = SubjectAccessInspectionLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        accessEnforcementLive,
        activeApplicationCompositionLive,
        SubjectInspectionIdentitySourceLive.pipe(
          Layer.provide(Layer.merge(runtimeCorePersistenceLive, databaseIdentitiesLive)),
        ),
      ),
    ),
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
    Layer.provide(
      Layer.mergeAll(runtimeCorePersistenceLive, databaseIdentitiesLive, contextAccessLayer, accessEnforcementLive),
    ),
  );
  const sharedOperationLayers = Layer.mergeAll(
    runtimeCorePersistenceLive,
    contextAccessLayer,
    moduleStateGateLayer,
    moduleEntrypointGatewayLayer,
    operationalScopeResolverLayer,
  );
  // The one read runtime: the canonical access gate's decisions join the read's own transaction, and the Shell's
  // database identity enrollment stays available to owner reads.
  const readRuntimeLayer = ReadRuntimeLive.pipe(
    Layer.provide(Layer.mergeAll(sharedOperationLayers, accessEnforcementLive)),
    Layer.provide(databaseIdentitiesLive),
  );
  // Agent-platform proposal preparation runs through the same canonical gate as every other protected surface.
  const proposalPreparationLayer = AgentProposalCommandPreparationLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeCorePersistenceLive,
        databaseIdentitiesLive,
        activeApplicationCompositionLive,
        contextAccessLayer,
        accessEnforcementLive,
        actionAuthorityLayer,
      ),
    ),
  );
  const proposalAuthorizationPreflightLayer = AgentProposalCommandAuthorizationPreflightLive.pipe(
    Layer.provide(proposalPreparationLayer),
  );
  const proposalModuleReviewLayer = Layer.unwrap(
    Effect.gen(function* proposalModuleReviewServices() {
      const composition = yield* ActiveApplicationCompositionService;
      const issuer = yield* GatewayIssuer;
      return AgentProposalQueueModuleReviewLive((program, transport) =>
        program.pipe(
          Effect.provideService(ActiveApplicationCompositionService, composition),
          Effect.provideService(GatewayIssuer, issuer),
          Effect.provideService(AgentReadRequestIdentity, transport),
        ),
      );
    }),
  ).pipe(Layer.provide(Layer.merge(activeApplicationCompositionLive, issuerLayer)));
  const identityDeniedAuditLayer = IdentityAdministrationDeniedAuditLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeCorePersistenceLive,
        databaseIdentitiesLive,
        operationalScopeResolverLayer,
        contextAccessLayer,
        accessEnforcementLive,
      ),
    ),
  );
  const staffAccountProviderLayer = BetterAuthStaffRoleTemplateAccountProviderLive.pipe(
    Layer.provide(StaffAccountDirectoryLive.pipe(Layer.provide(runtimeAuthPersistenceLive))),
  );
  const actionRuntimeLayer = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(
      Layer.mergeAll(
        sharedOperationLayers,
        InstalledModuleCatalogServiceLive.pipe(Layer.provide(activeApplicationCompositionLive)),
        ActionRepositoryLive,
        ActionPermissionLive,
        proposalAuthorizationPreflightLayer,
        BetterAuthPersonInvitationIdentityProviderLive,
      ).pipe(Layer.provideMerge(Layer.merge(activeApplicationCompositionLive, accessEnforcementLive))),
    ),
    Layer.provide(databaseIdentitiesLive),
  );
  const identityLifecycleLayer = IdentityLifecycleLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        actionRuntimeLayer,
        runtimeApiKeyServiceLive,
        runtimePrincipalResolverLive,
        ManagedApiKeyTargetEligibilityLive.pipe(Layer.provide(runtimeCorePersistenceLive)),
      ),
    ),
  );
  const shellGovernedReadsLayer = Layer.unwrap(
    GatewayIssuer.pipe(
      Effect.map((gatewayIssuer) => {
        const providerAssertionIssuer: ShellProviderAssertionIssuer = {
          issueAssertion: (input) =>
            issueShellSearchProviderAssertion(input).pipe(Effect.provideService(GatewayIssuer, gatewayIssuer)),
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
        databaseIdentitiesLive,
        ShellPeopleSystemSearchLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              readRuntimeLayer,
              accessEnforcementLive,
              PeopleSearchReadLive.pipe(
                Layer.provide(
                  CoreSearchProjectionStoreLive.pipe(
                    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, databaseIdentitiesLive)),
                  ),
                ),
              ),
            ),
          ),
        ),
        readRuntimeLayer,
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
  // These factories are installed with request services, but reach the database only after the email route has
  // authorized its work. Each operation owns a fresh scope; on the Node host it borrows the shared runtime pool.
  const emailDatabaseLive = EmailRequestDatabaseLive.pipe(
    Layer.provide(Layer.mergeAll(DatabaseConfigLive, Reactivity.layer)),
  );
  const emailDeliveryRequestsLive = Layer.succeed(EmailDeliveryRequests, {
    dispatch: Effect.scoped(
      Effect.gen(function* dispatchRequestEmailBatch() {
        const database = yield* Layer.build(emailDatabaseLive);
        return yield* dispatchEmailBatch.pipe(Effect.provideContext(database));
      }),
    ),
    list: (query: EmailDeliveryQuery) =>
      Effect.scoped(
        Effect.gen(function* listEmailDeliveries() {
          const database = yield* Layer.build(emailDatabaseLive);
          return yield* listDeliveries(query).pipe(Effect.provideContext(database));
        }),
      ).pipe(Effect.withSpan('Shell.emailDeliveries')),
  });
  const accessAdminStoresLive = Layer.mergeAll(
    AccessChangesStoreLive,
    AccessMembershipStoreLive,
    AccessPeopleDirectoryLive,
    AccessPeopleStoreLive,
    AccessTeamStoreLive,
    AccessWriteJournalStoreLive,
    TenantIntentLoaderLive,
  ).pipe(Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, databaseIdentitiesLive)));
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
  const approvalOwnerIdentityLive = Layer.effect(
    ApprovalOwnerIdentity,
    Effect.gen(function* approvalOwnerIdentityLayer() {
      const authentication = yield* AuthenticationService;
      const gate = yield* AccessDecisionGate;
      const legalEntityContext = yield* LegalEntityContext;
      return {
        resolve: Effect.fn('ShellApi.approvalOwnerIdentity')(function* resolveApprovalOwnerIdentity(
          headers: Headers,
          admitted: OperationalScope,
          legalEntityId?: string,
        ) {
          const session = yield* Effect.gen(function* resolveOriginalApprovalSession() {
            return legalEntityId === undefined
              ? yield* authentication.resolveTenantContext(headers)
              : yield* authentication.resolveShellContext(headers);
          }).pipe(
            Effect.provideService(AccessDecisionGate, gate),
            Effect.provideService(LegalEntityContext, legalEntityContext),
            Effect.mapError((error) =>
              Match.value(error).pipe(
                Match.tag('InvalidCredentialsError', 'OntosIdentityForbiddenError', approvalOwnerRefused),
                Match.tag('AuthenticationUnavailableError', 'AuthenticationInternalError', approvalOwnerUnavailable),
                Match.exhaustive,
              ),
            ),
          );
          const responseRequest = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
          if (Option.isSome(responseRequest)) {
            yield* forwardSetCookieHeaders(session.setCookieHeaders).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, responseRequest.value),
            );
          }
          if (session.state !== 'authenticated') {
            return yield* Effect.fail(approvalOwnerRefused());
          }
          return yield* requireApprovalOwnerIdentity(admitted, session.principal, legalEntityId).pipe(
            Effect.mapError(approvalOwnerRefused),
          );
        }),
      };
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(authenticationLayer, accessEnforcementLive, contextAccessLayer, runtimeLegalEntityContextLive),
    ),
  );
  const approvalOwnerTransportLive = ApprovalOwnerTransportLive.pipe(
    Layer.provide(
      Layer.mergeAll(approvalOwnerIdentityLive, issuerLayer, moduleCatalogLayer, ApprovalOwnerModuleTransportLive),
    ),
  );
  // The inbox keeps tenant-scoped storage and rejection/withdrawal services. Approval crosses the
  // published owner HTTP boundary; only that owner holds the original Action and governing Read.
  const accessAdminApprovalsLive = AccessApprovalsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        accessApprovalActionsLayer([]),
        approvalOwnerTransportLive,
        AccessApprovalsInboxLive.pipe(
          Layer.provide(ApprovalStoreLive),
          Layer.provide(FrozenCommandsLive),
          Layer.provide(
            Layer.mergeAll(accessAdminStoresLive, runtimeCorePersistenceLive, databaseIdentitiesLive, ShellCryptoLive),
          ),
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
        AccessPeopleWritesProvenLive,
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
  );
  const delegationScopeResolverLayer = OperationalScopeResolverLive.pipe(
    Layer.provide(
      Layer.mergeAll(runtimeCorePersistenceLive, databaseIdentitiesLive, contextAccessLayer, accessEnforcementLive),
    ),
  );
  const delegationLedgerLayer = GatewayDelegationExchangeLedgerLive.pipe(Layer.provide(runtimeAuthPersistenceLive));
  const originatorEvidenceLayer = GatewayOriginatorEvidenceLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, runtimeAuthPersistenceLive)),
  );
  const moduleCredentialEnrolmentLayer = ModuleCredentialEnrolmentSourceLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, runtimeAuthPersistenceLive)),
  );
  const platformWorkloadKeyAdmissionLayer = PlatformWorkloadKeyAdmissionLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeCorePersistenceLive, runtimeAuthPersistenceLive, moduleCatalogLayer)),
  );
  const handlerDependenciesLive = Layer.mergeAll(
    platformWorkloadKeyAdmissionLayer,
    emailDeliveryRequestsLive,
    authenticationIsolateLive,
    BetterAuthPersonInvitationIdentityProviderLive,
    oauthGrantRegistryLive,
    oauthCredentialsLive,
    oauthAuthenticationAuditLive,
    oauthConnectionCompaniesLive,
    oauthGrantOwnersLive,
    proposalPreparationLayer,
    proposalModuleReviewLayer,
    identityDeniedAuditLayer,
    staffAccountProviderLayer,
    delegationScopeResolverLayer,
    delegationLedgerLayer,
    originatorEvidenceLayer,
    moduleCredentialEnrolmentLayer,
    GatewayDelegationVerificationLive,
    authenticationLayer,
    runtimeAuthPersistenceLive,
    actionRuntimeLayer,
    runtimeApiKeyServiceLive,
    identityLifecycleLayer,
    supportImpersonationServiceLive,
    runtimePrincipalResolverLive,
    runtimeLegalEntityContextLive,
    accessAdminBffsLive,
    accessAdminProjectionWriterLive,
    // The Agents page offers the tenant's v2 roles from the People page's own source.
    accessAdminPeopleCommandsLive,
    issuerLayer,
    selectedModuleStateLayer,
    moduleCatalogLayer,
    contextAccessLayer,
    actionAuthorityLayer,
    subjectInspectionLayer,
    shellGovernedReadsLayer,
    readRuntimeLayer,
    runtimeObservabilityLive,
    externalIdentityWorkloadAuthorizationLive.pipe(Layer.provide(moduleCredentialEnrolmentLayer)),
    externalIdentityDeploymentLayer,
    OAuthFlowLive.pipe(Layer.provide(authPersistenceLive)),
  ).pipe(Layer.provideMerge(Layer.mergeAll(ShellCryptoLive, accessEnforcementLive, activeApplicationCompositionLive)));
  // Built once with the API: the handlers and the Shell-owned transport routes build in one Layer and share these
  // memoized service instances. A service that cannot be built is logged, and the runtime dies with it.
  // The installed Outbox matcher (or no layer) is built from the same handler dependencies.
  // The live-changes route resolves each connection's scope with the handlers' own session and composition services.
  const liveScopeResolverLive = Layer.effect(
    LiveScopeResolver,
    Effect.map(
      Effect.context<
        Exclude<
          Effect.Services<ReturnType<typeof resolveLiveChangeScopeOrProblem>>,
          HttpServerRequest.HttpServerRequest
        >
      >(),
      (services) => ({
        resolve: (request: HttpServerRequest.HttpServerRequest) =>
          resolveLiveChangeScopeOrProblem({ headers: request.headers }).pipe(
            Effect.mapError(liveScopeFailure),
            Effect.flatMap(liveScopeOrRefusal),
            Effect.provideContext(services),
          ),
      }),
    ),
  );
  const liveChangesLive = Layer.mergeAll(
    liveScopeResolverLive,
    LiveChangeHubLive.pipe(Layer.provide(LiveChangeTailLive), Layer.provide(DatabaseConfigLive)),
  );
  const apiServicesLive = Layer.mergeAll(outboxMatcherLayer, liveChangesLive).pipe(
    Layer.provideMerge(handlerDependenciesLive),
    Layer.provideMerge(activeApplicationCompositionLive),
    Layer.provideMerge(compositionSourceLive),
    Layer.provideMerge(Reactivity.layer),
    Layer.provideMerge(databaseIdentitiesLive),
    Layer.tapCause(logRequestServicesFailure),
    Layer.orDie,
  );

  // Shell-owned routes outside the HTTP API resolve their request services from the same memoized instances as the
  // handlers: the middleware captures them once when the API builds and provides them to each request.
  const shellTransportServicesLive = HttpRouter.middleware<{ provides: Layer.Success<typeof apiServicesLive> }>()(
    Effect.map(
      Effect.context<Layer.Success<typeof apiServicesLive>>(),
      (services) =>
        (
          route: Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            Types.unhandled,
            Layer.Success<typeof apiServicesLive>
          >,
        ) =>
          Effect.provideContext(route, services),
    ),
  ).layer;
  // The MCP endpoint runs tools as the connection's principal, with the agent platform's services.
  const mcpEndpointRoutesLive = McpEndpointTransportLive.pipe(
    Layer.provide(mcpRequestIdentityMiddleware.layer),
    Layer.provide(shellTransportServicesLive),
  );
  // The governed handler Layer provides the route middleware as an immutable Layer value, not a constructor call.
  // NoServerTimingLive is global too: no response leaves the Shell with `server-timing`, whichever route or
  // in-process Action added it.
  const shellSearchNoStoreLayer = makeShellSearchNoStoreLayer();
  const apiHandlersLive = Layer.mergeAll(
    ShellEmailReceiptHandlersLive,
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
    accessAdminHandlersLive,
    oauthConnectionsAdminGroupLive,
    peopleAdministrationGroupLive,
    agentPlatformGroupLive,
  ).pipe(Layer.provide(apiServicesLive), Layer.provide(shellSearchNoStoreLayer), Layer.provide(NoServerTimingLive));

  return assembleEffectBffRuntime({
    api: ShellAuthenticationApi,
    handlers: apiHandlersLive,
    transport: Layer.mergeAll(ShellTransportLive, LiveChangesRouteLive).pipe(
      // Building the MCP endpoint's route Layer registers it beside the other Shell routes.
      Layer.provide(mcpEndpointRoutesLive),
      Layer.provide(shellTransportServicesLive),
      Layer.provide(apiServicesLive),
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
  ExternalIdentityProviderContextAccessLive.pipe(Layer.provide(approvedModuleCatalogLive)),
  // Search reaches each provider's approved owner release; resource detail providers are not served yet.
  { resource: unavailableResourceGateways.resource, search: moduleSearchProviderGateway },
  defaultScopedModuleStateFactory,
  ExternalIdentityProviderDeploymentLive.pipe(Layer.provide(approvedModuleCatalogLive)),
] as const satisfies ShellAuthenticationApiRuntimeArguments);

const apiRuntime = makeShellAuthenticationApiRuntime(...shellProductionRuntimeArguments);

export default apiRuntime;

// The Cloudflare entry calls these optional BFF hooks before its normal prefix dispatch.

const rootRouteHandler = Ref.makeUnsafe<Option.Option<ReturnType<typeof apiRuntime.createHandler>>>(Option.none());

/**
 * Node: the root `/mcp` and `/.well-known/oauth-protected-resource[/mcp]` middleware serves the canonical BFF route
 * in-process (the request path is already rewritten to the BFF route without its prefix).
 */
export const handleRootRoute = Effect.fn('Shell.handleRootRoute')(
  function* serveRootRoute(request: Request) {
    const resolved = yield* Ref.modify(rootRouteHandler, (handler) => {
      const instance = Option.getOrElse(handler, () => apiRuntime.createHandler());
      return [instance, Option.some(instance)] as const;
    });
    // The BFF owns the request scope; the Node edge forwards cancellation and never retries a request.
    return yield* Effect.promise((signal): PromiseLike<Response> =>
      resolved.handler(new Request(request, { signal: AbortSignal.any([request.signal, signal]) })),
    );
  },
  Effect.timeout('30 seconds'),
  runEffectRequest,
);

/** The Node root aliases use the same scoped Better Auth service as the canonical BFF route. */
export const handleOAuthMetadata = Effect.fn('Shell.handleOAuthMetadata')(function* serveOAuthMetadata(
  request: Request,
) {
  return yield* Effect.scoped(
    Effect.gen(function* forwardOAuthMetadata() {
      const services = yield* Layer.build(authenticationServiceLive);
      const service = Context.get(services, AuthenticationService);
      return yield* service.oauth === undefined
        ? Effect.succeed(oauthNotFoundResponse())
        : forwardOAuthRequest(service.oauth)(request);
    }),
  );
}, runEffectRequest);
