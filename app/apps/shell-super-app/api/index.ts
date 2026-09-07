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
import type {
  ActionCoreError,
  ContextAccess,
  InstalledModuleCatalog,
  PrincipalManagementError,
  PrincipalResolutionError,
  ReadCoreError,
  TenantModuleStateService,
} from '@app/core-runtime';
import {
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  LegalEntityContextLive,
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
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import type { GatewayContextProblem } from '@app/shared-contracts';
import {
  Cause,
  Exit,
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
  ShellTargetForbiddenProblem,
  ShellTargetNotFoundProblem,
  SwitchTenantProblem,
  TenantAccessForbiddenProblem,
  TenantAuthenticationRequiredProblem,
  TenantCapabilityUnavailableProblem,
  TenantInternalProblem,
} from '../shared/api.ts';
import { AuthPersistenceLive } from './auth/runtime-infrastructure.ts';
import { AuthConfigLive } from './auth/config.ts';
import { ApiKeyService, ApiKeyServiceLive } from './auth/api-key-service.ts';
import { IdentityLifecycle, IdentityLifecycleLive } from './auth/identity-lifecycle.ts';
import {
  SupportImpersonationCorrelationId,
  SupportImpersonationService,
  SupportImpersonationServiceLive,
} from './auth/impersonation-service.ts';
import {
  GatewayIssuer,
  GatewayIssuerLive,
  issueGatewayContextAssertion,
} from './auth/gateway-issuer.ts';
import type { GatewayIssuerError } from './auth/gateway-issuer.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './auth/errors.ts';
import type { ApiKeyProviderError } from './auth/api-key-service.ts';
import type { IdentityLifecycleError } from './auth/identity-lifecycle.ts';
import type { SupportImpersonationError } from './auth/impersonation-service.ts';
import type { LegalEntitySelectionForbiddenError } from './auth/legal-entity-selection.ts';
import { validateAuthorizedLegalEntity } from './auth/legal-entity-selection.ts';
import { AuthenticationService, AuthenticationServiceLive } from './auth/service.ts';
import type { ShellContextResult } from './auth/service.ts';
import {
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from './modules/installed-module-catalog.ts';
import type { InstalledModuleCatalogError } from './modules/installed-module-catalog.ts';
import { InstalledOutboxMatcherLive } from './modules/installed-outbox-matcher.ts';
import {
  ShellGovernedReads,
  createShellGovernedReadsLayer,
} from './modules/shell-governed-reads.ts';
import type { ShellScopedModuleStateFactory } from './modules/shell-governed-reads.ts';
import { ShellCompositionFactoryLive } from './modules/shell-composition.ts';
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

const RequestHeadersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined]),
);
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
          ? Effect.annotateLogs(
              Effect.logError(message, exit.cause),
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

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const decodeResponse = <
  ResponseSchema extends Schema.Constraint,
  EncodedResponse extends object,
  Failure,
>(
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
  (Predicate.isTagged(gatewayProblem, 'GatewayAuthenticationRequiredProblem')
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(gatewayProblem)));
const failApiKeyGatewayProblem = <Failure extends GatewayContextProblem>(gatewayProblem: Failure) =>
  (Predicate.isTagged(gatewayProblem, 'GatewayAuthenticationRequiredProblem')
    ? apiKeyChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(gatewayProblem)));

const failIdentityProblem = (problem: IdentityProblem) =>
  (Predicate.isTagged(problem, 'ShellAuthenticationRequiredProblem')
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(problem)));
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
type IdentityActionPolicyDenied = Extract<
  IdentityRuntimeError,
  { readonly _tag: 'ActionPolicyDenied' }
>;
type IdentityApiKeyRateLimited = Extract<
  IdentityRuntimeError,
  { readonly _tag: 'ApiKeyRateLimitedError' }
>;
type IdentityReadPolicyDenied = Extract<
  IdentityRuntimeError,
  { readonly _tag: 'ReadPolicyDenied' }
>;

const gatewayAuthenticationRequiredProblem =
  (): GatewayProblem<'GatewayAuthenticationRequiredProblem'> =>
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
const gatewayRateLimitedProblem = (
  retryAfterSeconds: number,
): GatewayProblem<'GatewayRateLimitedProblem'> =>
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
): GatewayProblem<
  'GatewayAuthenticationRequiredProblem' | 'GatewayRateLimitedProblem' | 'GatewayUnavailableProblem'
> =>
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
): GatewayProblem<
  'GatewayAuthenticationRequiredProblem' | 'GatewayForbiddenProblem' | 'GatewayUnavailableProblem'
> =>
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
): GatewayProblem<'GatewayAudienceInvalidProblem'> | GatewayProblem<'GatewayUnavailableProblem'> =>
  error.code === 'gateway_audience_invalid'
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

const currentAccessBlockedResponse = (
  session: Extract<ShellContextResult, { readonly state: 'access_blocked' }>,
) => ({ identity: session.identity, state: 'access_blocked' as const });

const currentAnonymousResponse = () => ({ state: 'anonymous' as const });

const currentAuthenticatedResponse = (
  session: Extract<ShellContextResult, { readonly state: 'authenticated' }>,
) => ({ identity: session.identity, state: 'authenticated' as const });

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

const failTenantProblem = <Failure extends SwitchTenantProblem>(tenantFailure: Failure) =>
  (Predicate.isTagged(tenantFailure, 'TenantAuthenticationRequiredProblem')
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(tenantFailure)));

const legalEntityAccessForbiddenProblem = (): LegalEntityAccessForbiddenProblem =>
  problemDetails(
    'LegalEntityAccessForbiddenProblem',
    'The requested legal entity is not available to this session.',
    403,
    'Legal-entity access forbidden',
    'https://ontos.dev/problems/legal-entity-access-forbidden',
  );

const failLegalEntityProblem = <Failure extends LegalEntityProblem>(failure: Failure) =>
  (Predicate.isTagged(failure, 'TenantAuthenticationRequiredProblem')
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(failure)));

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

const shellReadPolicyProblem = (
  denial: Extract<ReadCoreError, { readonly _tag: 'ReadPolicyDenied' }>,
) => (denial.httpStatus === 409 ? shellPolicyConflictProblem() : shellPolicyUnprocessableProblem());

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
  return Predicate.isTagged(mappedProblem, 'ShellTargetNotFoundProblem')
    ? shellInternalProblem()
    : mappedProblem;
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
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellSelectionRequiredProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem;

const failShellProblem = <Failure extends ShellProblem>(failure: Failure) =>
  (Predicate.isTagged(failure, 'ShellAuthenticationRequiredProblem')
    ? bearerChallenge
    : Effect.void
  ).pipe(Effect.andThen(Effect.fail(failure)));

const mediaAttachmentForbidden = () => failShellProblem(shellTargetForbiddenProblem());
const mediaAttachmentNotFound = () => failShellProblem(shellTargetNotFoundProblem());
const mediaAttachmentResolved = (
  resolution: Extract<ShellMediaAttachmentResolution, { readonly outcome: 'resolved' }>,
) => decodeResponse(MediaAttachmentResponseSchema, resolution.result, shellInternalProblem);
const mediaAttachmentUnavailable = () => failShellProblem(shellCapabilityUnavailableProblem());

const authenticationGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'authentication',
  (handlers) =>
    handlers
      .handle(
        'signIn',
        Effect.fn('shell.authentication.signIn')(({ payload, request }) =>
          Effect.gen(function* signInHandler() {
            const authentication = yield* AuthenticationService;
            const result = yield* authentication
              .signIn(
                payload.email,
                Redacted.value(payload.password),
                requestHeaders(request.headers),
              )
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
          return yield* decodeResponse(
            CurrentSessionSchema,
            response,
            authenticationInternalProblem,
          );
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
              Effect.catch((error) =>
                pipe(error, tenantAuthenticationProblem, failLegalEntityProblem),
              ),
            );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          if (result.state === 'anonymous') {
            return yield* failLegalEntityProblem(tenantAuthenticationRequiredProblem());
          }
          const selectedLegalEntityId =
            result.state === 'authenticated' ? result.identity.legalEntityId : undefined;
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
          return yield* decodeResponse(
            AvailableLegalEntitiesResponseSchema,
            response,
            tenantInternalProblem,
          );
        }).pipe(
          recoverUnexpectedDefect(request, 'Unexpected legal-entity list defect', () =>
            failLegalEntityProblem(tenantInternalProblem()),
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
            failLegalEntityProblem(tenantInternalProblem()),
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
          .pipe(
            Effect.catch((error) => pipe(error, tenantAuthenticationProblem, failTenantProblem)),
          );
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return yield* decodeResponse(
          AvailableTenantsResponseSchema,
          { tenants: result.tenants },
          tenantInternalProblem,
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected tenant list defect', () =>
          failTenantProblem(tenantInternalProblem()),
        ),
      ),
    )
    .handle('switchTenant', ({ payload, request }) =>
      Effect.gen(function* switchTenantHandler() {
        const authentication = yield* AuthenticationService;
        const result = yield* authentication
          .switchTenant(payload.tenantId, requestHeaders(request.headers))
          .pipe(Effect.catch((error) => pipe(error, tenantProblem, failTenantProblem)));
        yield* forwardSetCookieHeaders(result.setCookieHeaders);
        return yield* decodeResponse(
          SwitchTenantResponseSchema,
          { selectedTenantId: result.selectedTenantId },
          tenantInternalProblem,
        );
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected tenant switch defect', () =>
          failTenantProblem(tenantInternalProblem()),
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
                pipe(error, shellProblemFromAuthenticationError, failShellProblem),
              ),
            );
          yield* forwardSetCookieHeaders(session.setCookieHeaders);
          if (session.state === 'anonymous') {
            return yield* failShellProblem(shellAuthenticationRequiredProblem());
          }
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
          const governedReads = yield* ShellGovernedReads;
          const correlationId = correlationFromRequest(request);
          const response = yield* governedReads
            .composition({
              correlationId,
              principal: session.principal,
            })
            .pipe(
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
          const authentication = yield* AuthenticationService;
          const session = yield* authentication
            .resolveShellContext(requestHeaders(request.headers))
            .pipe(
              Effect.catch((error) =>
                pipe(error, shellProblemFromAuthenticationError, failShellProblem),
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
          const correlationId = correlationFromRequest(request);
          const response = yield* governedReads
            .moduleTarget(
              withOptionalProperty(
                {
                  correlationId,
                },
                payload.entrypointKey !== undefined,
                'entrypointKey',
                payload.entrypointKey,
                {
                  moduleId: payload.moduleId,
                  principal: session.principal,
                },
              ),
            )
            .pipe(
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
        const authentication = yield* AuthenticationService;
        const session = yield* authentication
          .resolveShellContext(requestHeaders(request.headers))
          .pipe(
            Effect.catch((error) =>
              pipe(error, shellProblemFromAuthenticationError, failShellProblem),
            ),
          );
        yield* forwardSetCookieHeaders(session.setCookieHeaders);
        if (session.state === 'anonymous') {
          return yield* failShellProblem(shellAuthenticationRequiredProblem());
        }
        const governedReads = yield* ShellGovernedReads;
        const response = yield* governedReads
          .search({
            correlationId: correlationFromRequest(request),
            principal: session.principal,
            ...payload,
          })
          .pipe(Effect.catch((error) => pipe(error, shellListReadProblem, failShellProblem)));
        return yield* decodeResponse(ShellSearchResponseSchema, response, shellInternalProblem);
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell search defect', () =>
          failShellProblem(shellInternalProblem()),
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
              pipe(error, shellProblemFromAuthenticationError, failShellProblem),
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
        const response = yield* governedReads
          .resourceDetail({
            correlationId: correlationFromRequest(request),
            principal: session.principal,
            ref: payload,
          })
          .pipe(Effect.catch((error) => pipe(error, shellReadProblem, failShellProblem)));
        return yield* decodeResponse(ShellResourceResponseSchema, response, shellInternalProblem);
      }).pipe(
        recoverUnexpectedDefect(request, 'Unexpected Shell resource-detail defect', () =>
          failShellProblem(shellInternalProblem()),
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
              pipe(error, shellProblemFromAuthenticationError, failShellProblem),
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
            correlationId: correlationFromRequest(request),
            legalEntityId: session.identity.legalEntityId,
          },
          payload,
        );
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
      return { authentication, resolved };
    }),
  );
  const lifecycle = IdentityLifecycle;
  const correlation = correlationFromRequest;
  const requiredIdempotencyKey = (headers: RequestHeaders) => {
    const value = headerValue(headers, 'idempotency-key');
    return value === undefined
      ? failIdentityProblem(shellPreconditionRequiredProblem())
      : Effect.succeed(value);
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
  return handlers
    .handle('createNonHumanPrincipal', ({ headers, payload, request }) =>
      safeIdentity(
        request,
        Effect.gen(function* createNonHumanPrincipalHandler() {
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          const response = yield* service
            .createNonHumanPrincipal({
              correlationId: correlation(request),
              idempotencyKey,
              payload,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(
            PrincipalMutationResponseSchema,
            response,
            shellInternalProblem,
          );
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
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          const response = yield* service
            .issue(
              withOptionalProperty(
                {
                  correlationId: correlation(request),
                  idempotencyKey,
                },
                payload.name !== undefined,
                'name',
                payload.name,
                {
                  principal: resolved.principal,
                  requestHeaders: requestHeaders(request.headers),
                },
              ),
            )
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ApiKeyIssueResponseSchema, response, shellInternalProblem);
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
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          const items = yield* Effect.all(
            result.items.map((binding) =>
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
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          const response = yield* service
            .issue(
              withOptionalProperty(
                {
                  correlationId: correlation(request),
                  idempotencyKey,
                  managedPrincipalId: payload.principalId,
                },
                payload.name !== undefined,
                'name',
                payload.name,
                {
                  principal: resolved.principal,
                  requestHeaders: requestHeaders(request.headers),
                },
              ),
            )
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ApiKeyIssueResponseSchema, response, shellInternalProblem);
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
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          const items = yield* Effect.all(
            result.items.map((item) => {
              const authBindingId = Option.getOrNull(item.authBindingId);
              if (authBindingId === null) {
                const withoutKey = {
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
                  Effect.map(({ bindingState, metadata }) => ({
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
          const { resolved } = yield* authenticated(request);
          const idempotencyKey = yield* requiredIdempotencyKey(headers);
          const service = yield* lifecycle;
          const response = yield* service
            .setStatus({
              ...payload,
              correlationId: correlation(request),
              idempotencyKey,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(
            ApiKeyLifecycleResponseSchema,
            response,
            shellInternalProblem,
          );
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
          const response = yield* service
            .setStatus({
              ...statusPayload,
              correlationId: correlation(request),
              idempotencyKey,
              managedPrincipalId: principalId,
              principal: resolved.principal,
            })
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(
            ApiKeyLifecycleResponseSchema,
            response,
            shellInternalProblem,
          );
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
          const response = yield* service
            .rotate(
              withOptionalProperty(
                {
                  correlationId: correlation(request),
                  idempotencyKey,
                },
                payload.name !== undefined,
                'name',
                payload.name,
                {
                  oldAuthBindingId: payload.oldAuthBindingId,
                  principal: resolved.principal,
                  reason: payload.reason,
                  requestHeaders: requestHeaders(request.headers),
                },
              ),
            )
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ApiKeyIssueResponseSchema, response, shellInternalProblem);
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
          const response = yield* service
            .rotate(
              withOptionalProperty(
                {
                  correlationId: correlation(request),
                  idempotencyKey,
                  managedPrincipalId: payload.principalId,
                },
                payload.name !== undefined,
                'name',
                payload.name,
                {
                  oldAuthBindingId: payload.oldAuthBindingId,
                  oldManagedPrincipalId: payload.principalId,
                  principal: resolved.principal,
                  reason: payload.reason,
                  requestHeaders: requestHeaders(request.headers),
                },
              ),
            )
            .pipe(Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)));
          return yield* decodeResponse(ApiKeyIssueResponseSchema, response, shellInternalProblem);
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
              Effect.provideService(SupportImpersonationCorrelationId, correlation(request)),
              Effect.catch((error) => pipe(error, identityProblem, failIdentityProblem)),
            );
          yield* forwardSetCookieHeaders(result.setCookieHeaders);
          return yield* decodeResponse(
            SupportImpersonationResponseSchema,
            { active: result.active, targetPrincipalId: result.targetPrincipalId },
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
              Effect.provideService(SupportImpersonationCorrelationId, correlation(request)),
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

const gatewayContextGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'gatewayContext',
  (handlers) =>
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

          return yield* issueGatewayContextAssertion({
            audience: payload.audience,
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
          const keys = yield* ApiKeyService;
          const resolver = yield* PrincipalResolver;
          const { 'x-api-key': rawKey } = headers;
          if (rawKey === undefined || rawKey.trim().length === 0) {
            return yield* failApiKeyGatewayProblem(gatewayAuthenticationRequiredProblem());
          }
          const verified = yield* keys
            .verify(rawKey)
            .pipe(
              Effect.catch((error) =>
                failApiKeyGatewayProblem(apiKeyProviderGatewayProblem(error)),
              ),
            );
          const identity = yield* resolver
            .resolveBetterAuthApiKey(verified.providerKeyId)
            .pipe(
              Effect.catch((error) =>
                pipe(error, principalResolutionGatewayProblem, failApiKeyGatewayProblem),
              ),
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
          return yield* issueGatewayContextAssertion({
            audience: payload.audience,
            principal: withOptionalProperty(
              {
                authBindingId: identity.authBindingId,
                authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
                authMethod: 'api_key',
              },
              legalEntityId !== undefined,
              'legalEntityId',
              legalEntityId,
              {
                principalId: identity.principalId,
                tenantId: identity.tenantId,
              },
            ),
          }).pipe(
            Effect.tapError((error) => logGatewayIssuerFailure('api_key', request, error)),
            Effect.catch((error) => pipe(error, gatewayIssuerProblem, failGatewayProblem)),
          );
        }).pipe(
          recoverUnexpectedDefect(request, 'Unexpected API-key gateway assertion defect', () =>
            failGatewayProblem(gatewayInternalProblem()),
          ),
        ),
      ),
);

const corePersistenceLive = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
const authPersistenceLive = AuthPersistenceLive.pipe(Layer.provide(AuthConfigLive));
const principalResolverLive = PrincipalResolverLive.pipe(Layer.provide(corePersistenceLive));
const legalEntityContextLive = LegalEntityContextLive.pipe(Layer.provide(corePersistenceLive));
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(corePersistenceLive),
);
const authenticationDependenciesLive = Layer.mergeAll(
  authPersistenceLive,
  ContextAccessLive,
  legalEntityContextLive,
  principalResolverLive,
);
const authenticationServiceLive = AuthenticationServiceLive.pipe(
  Layer.provide(authenticationDependenciesLive),
);
const apiKeyServiceLive = ApiKeyServiceLive.pipe(Layer.provide(authPersistenceLive));
const supportRecoveryPrincipalLive = SupportRecoveryPrincipalContextResolverLive.pipe(
  Layer.provide(corePersistenceLive),
);

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

type ShellAuthenticationLayer = Layer.Layer<
  AuthenticationService,
  Layer.Error<typeof authenticationServiceLive>
>;
type ShellModuleStateLayer = Layer.Layer<
  TenantModuleStateService,
  Layer.Error<typeof tenantModuleStateServiceLive>
>;

const defaultScopedModuleStateFactory: ShellScopedModuleStateFactory = (transaction) =>
  makeTenantModuleStateService({ executor: transaction });

type ShellAuthenticationApiRuntimeArguments = readonly [
  authenticationLayer: ShellAuthenticationLayer,
  issuerLayer: Layer.Layer<GatewayIssuer>,
  moduleStateLayer?: ShellModuleStateLayer,
  loadInstalledModuleCatalog?: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError>,
  enableInstalledOutboxMatcher?: boolean,
  contextAccessLayer?: Layer.Layer<ContextAccess>,
  resourceGateways?: ShellResourceGateways,
  scopedModuleStateFactory?: ShellScopedModuleStateFactory,
];

export const makeShellAuthenticationApiRuntime = (
  ...args: ShellAuthenticationApiRuntimeArguments
): EffectBffDefinition<typeof ShellAuthenticationApi> &
  EffectBffRuntime<typeof ShellAuthenticationApi> => {
  const [
    authenticationLayer,
    issuerLayer,
    moduleStateLayer = tenantModuleStateServiceLive,
    loadInstalledModuleCatalog,
    enableInstalledOutboxMatcher = false,
    contextAccessLayer = ContextAccessLive,
    resourceGateways = unavailableResourceGateways,
    scopedModuleStateFactory = defaultScopedModuleStateFactory,
  ] = args;
  const moduleCatalogLayer =
    loadInstalledModuleCatalog === undefined
      ? ShellInstalledModuleCatalogLive
      : Layer.succeed(ShellInstalledModuleCatalog, { load: loadInstalledModuleCatalog });
  const moduleStateGateLayer = ModuleStateGateLive.pipe(Layer.provide(moduleStateLayer));
  const moduleEntrypointGatewayLayer = ModuleEntrypointGatewayLive.pipe(
    Layer.provide(moduleStateGateLayer),
  );
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
  const readRuntimeLayer = ReadRuntimeLive.pipe(Layer.provide(sharedOperationLayers));
  const actionRuntimeLayer = ActionRuntimeLive.pipe(
    Layer.provide(
      Layer.mergeAll(sharedOperationLayers, ActionRepositoryLive, ActionPermissionLive),
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
            context,
          }: {
            readonly appId: string;
            readonly context: ShellResourceContext;
          }) =>
            gatewayIssuer
              .issue({
                audience: appId,
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
                Effect.catchTag('GatewayIssuerError', () =>
                  Effect.fail(new ShellProviderUnavailableError()),
                ),
              ),
        };
        return createShellGovernedReadsLayer(
          resourceGateways,
          providerAssertionIssuer,
          scopedModuleStateFactory,
        );
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
        Layer.provide(
          OutboxRuntimeLive.pipe(
            Layer.provide(OutboxRepositoryLive),
            Layer.provide(corePersistenceLive),
          ),
        ),
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
        gatewayContextGroupLive,
        outboxMatcherLayer,
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        authenticationLayer,
        authPersistenceLive,
        actionRuntimeLayer,
        apiKeyServiceLive,
        identityLifecycleLayer,
        supportImpersonationServiceLive,
        principalResolverLive,
        legalEntityContextLive,
        issuerLayer,
        moduleStateLayer,
        moduleCatalogLayer,
        contextAccessLayer,
        shellGovernedReadsLayer,
        readRuntimeLayer,
        runtimeObservabilityLive,
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
  GatewayIssuerLive,
  tenantModuleStateServiceLive,
  undefined,
  true,
);

export default apiRuntime;
