import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { Context } from 'effect';
import type { Cause } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type { Headers } from 'effect/unstable/http';
import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../shared/api.ts';
import type {
  AvailableLegalEntitiesResponse,
  AvailableTenantsResponse,
  LegalEntityAccessForbiddenProblem,
  MediaAttachmentResponse,
  SwitchLegalEntityPayload,
  SwitchLegalEntityResponse,
  SwitchTenantPayload,
  SwitchTenantResponse,
  TenantAccessForbiddenProblem,
  TenantAuthenticationRequiredProblem,
  TenantCapabilityUnavailableProblem,
  TenantInternalProblem,
  CurrentSession,
  AuthenticationInternalProblem,
  AuthenticationUnavailableProblem,
  InvalidCredentialsProblem,
  OntosIdentityForbiddenProblem,
  SignInPayload,
  SignInResponse,
  SignOutResponse,
  ResolveModuleTargetPayload,
  ResolvedModuleTarget,
  ShellAuthenticationRequiredProblem,
  ShellCapabilityUnavailableProblem,
  ShellComposition,
  ShellInternalProblem,
  IdentityProblem,
  ApiKeyIssueResponse,
  ApiKeyLifecycleResponse,
  ChangePrincipalStatusPayload,
  CreateNonHumanPrincipalPayload,
  IdentityListPayload,
  IssueApiKeyPayload,
  IssueManagedApiKeyPayload,
  ManagedApiKeyListResponse,
  PrincipalMutationResponse,
  RotateApiKeyPayload,
  RotateManagedApiKeyPayload,
  SelfApiKeyListResponse,
  SetApiKeyStatusPayload,
  SetManagedApiKeyStatusPayload,
  StartSupportImpersonationPayload,
  SupportImpersonationResponse,
  ShellSelectionRequiredProblem,
  ShellTargetForbiddenProblem,
  ShellTargetNotFoundProblem,
  ResourceRef,
  ShellResourceResponse,
  ShellSearchPayload,
  ShellSearchResponse,
} from '../../shared/api.ts';

export { issueGatewayContext } from '@app/shared-contracts';
export type {
  GatewayContextClientError,
  GatewayContextClientOptions,
  GatewayContextRequest,
  GatewayContextResponse,
} from '@app/shared-contracts';

type ShellAuthenticationApiGroups =
  typeof ShellAuthenticationApi extends HttpApi.HttpApi<infer _ApiId, infer Groups>
    ? Groups
    : never;

export type ShellAuthenticationClient = HttpApiClient.Client<
  Extract<ShellAuthenticationApiGroups, HttpApiGroup.Constraint>
>;

export interface ShellAuthenticationClientOptions {
  readonly baseUrl?: string | URL;
  readonly cookie?: string;
  readonly locale?: string;
  readonly timeoutMs?: number;
}

export type ShellAuthenticationClientError =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Cause.TimeoutError;

export type ShellAuthenticationClientEffect<Success> = Effect.Effect<
  Success,
  ShellAuthenticationClientError
>;

export type AvailableTenantsClientError =
  | TenantAuthenticationRequiredProblem
  | TenantCapabilityUnavailableProblem
  | TenantInternalProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Cause.TimeoutError;

export type SwitchTenantClientError = AvailableTenantsClientError | TenantAccessForbiddenProblem;

export type AvailableTenantsClientEffect = Effect.Effect<
  AvailableTenantsResponse,
  AvailableTenantsClientError
>;

export type SwitchTenantClientEffect = Effect.Effect<SwitchTenantResponse, SwitchTenantClientError>;

export type AvailableLegalEntitiesClientEffect = Effect.Effect<
  AvailableLegalEntitiesResponse,
  AvailableTenantsClientError
>;

export type SwitchLegalEntityClientError =
  | AvailableTenantsClientError
  | LegalEntityAccessForbiddenProblem;

export type SwitchLegalEntityClientEffect = Effect.Effect<
  SwitchLegalEntityResponse,
  SwitchLegalEntityClientError
>;

export type ShellCompositionClientError =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | IdentityProblem
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | Cause.TimeoutError;

export type ShellTargetClientError =
  | ShellCompositionClientError
  | ShellSelectionRequiredProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem;

export type ShellSearchClientError = ShellCompositionClientError | ShellSelectionRequiredProblem;
export type ShellResourceClientError = ShellTargetClientError;

export type IdentityClientError =
  | IdentityProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Cause.TimeoutError;

export interface IdentityClientOptions extends ShellAuthenticationClientOptions {
  readonly idempotencyKey: string;
}

const identityHeaders = (options: IdentityClientOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

/** Whole-operation budget, response decode included. Overridable per call so tests stay bounded. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The header `requestContext.locale` used to produce at construction; now produced per call. */
const LOCALE_HEADER = 'accept-language';

/** What one in-flight Shell authentication call contributes to its request; never held by the client. */
interface ShellAuthenticationCallTransport {
  readonly baseUrl: string;
  readonly headers: Headers.Input;
  readonly locale: string | undefined;
}

/**
 * A `Context.Reference`, not a service: it carries a default, so every public Effect keeps
 * `R = never`. That default is fail-closed — a request issued outside a prepared call dies instead
 * of borrowing whichever session cookie happened to be in scope.
 */
const CurrentShellAuthenticationCall = Context.Reference<ShellAuthenticationCallTransport | null>(
  'shell-super-app/CurrentShellAuthenticationCall',
  { defaultValue: () => null },
);

const routeRequest = (
  request: HttpClientRequest.HttpClientRequest,
  transport: ShellAuthenticationCallTransport,
): HttpClientRequest.HttpClientRequest => {
  const routed = request.pipe(
    HttpClientRequest.setHeaders(transport.headers),
    HttpClientRequest.prependUrl(transport.baseUrl),
  );
  // Same precedence `requestContext` had: the locale is a default an explicit header outranks.
  return transport.locale === undefined || routed.headers[LOCALE_HEADER] !== undefined
    ? routed
    : HttpClientRequest.setHeader(routed, LOCALE_HEADER, transport.locale);
};

/**
 * `HttpClient.mapRequestEffect` resolves its effect in the fiber that executes the request, so
 * interleaved calls each read their own base URL, cookie and locale off one shared client.
 */
const applyCallTransport = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.mapRequestEffect(client, (request) =>
    Effect.flatMap(Effect.service(CurrentShellAuthenticationCall), (transport) =>
      transport === null
        ? Effect.die('The Shell authentication client was used outside a prepared call')
        : Effect.succeed(routeRequest(request, transport)),
    ),
  );

/**
 * The app's single typed client, built once on its own root fiber at module load. Both
 * `HttpApiClient.makeClient` and `FetchHttpClient.layer` capture construction context and merge it
 * *under* every later request, so building inside the first caller would pin that caller's fetch,
 * logger and spans onto every later call. Building here leaves both captures empty. `baseUrl` stays
 * out of construction — it bakes into the transport — and moves to the per-call prefix below.
 */
const shellAuthenticationClient = Effect.runSync(
  makeEffectHttpApiClient(ShellAuthenticationApi, { transformClient: applyCallTransport }),
);

const callTransport = (
  options: ShellAuthenticationClientOptions,
): ShellAuthenticationCallTransport => ({
  baseUrl: (options.baseUrl ?? shellAuthenticationApiContract.apiPrefix).toString(),
  headers: options.cookie === undefined ? {} : { cookie: options.cookie },
  locale: options.locale,
});

/**
 * Binds one operation to its caller's transport and its own deadline. The budget sits outside the
 * operation so it covers connect, body and decode; expiry is a typed `TimeoutError` that interrupts
 * this call and is never retried — after a timed-out write the commit result is simply unknown.
 */
const prepared = <Success, Failure>(
  operation: Effect.Effect<Success, Failure>,
  options: ShellAuthenticationClientOptions,
): Effect.Effect<Success, Failure | Cause.TimeoutError> =>
  operation.pipe(
    Effect.provideService(CurrentShellAuthenticationCall, callTransport(options)),
    Effect.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

export const signIn = (
  payload: SignInPayload,
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignInResponse> =>
  prepared(shellAuthenticationClient.authentication.signIn({ payload }), options);

export const currentSession = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<CurrentSession> =>
  prepared(shellAuthenticationClient.authentication.currentSession({}), options);

export const availableTenants = (
  options: ShellAuthenticationClientOptions = {},
): AvailableTenantsClientEffect =>
  prepared(shellAuthenticationClient.tenants.availableTenants({}), options);

export const switchTenant = (
  payload: SwitchTenantPayload,
  options: ShellAuthenticationClientOptions = {},
): SwitchTenantClientEffect =>
  prepared(shellAuthenticationClient.tenants.switchTenant({ payload }), options);

export const availableLegalEntities = (
  options: ShellAuthenticationClientOptions = {},
): AvailableLegalEntitiesClientEffect =>
  prepared(shellAuthenticationClient.legalEntities.availableLegalEntities({}), options);

export const switchLegalEntity = (
  payload: SwitchLegalEntityPayload,
  options: ShellAuthenticationClientOptions = {},
): SwitchLegalEntityClientEffect =>
  prepared(shellAuthenticationClient.legalEntities.switchLegalEntity({ payload }), options);

export const shellComposition = (
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellComposition, ShellCompositionClientError> =>
  prepared(shellAuthenticationClient.composition.shellComposition({}), options);

export const resolveModuleTarget = (
  payload: ResolveModuleTargetPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ResolvedModuleTarget, ShellTargetClientError> =>
  prepared(shellAuthenticationClient.composition.resolveModuleTarget({ payload }), options);

export const searchResources = (
  payload: ShellSearchPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellSearchResponse, ShellSearchClientError> =>
  prepared(shellAuthenticationClient.resources.search({ payload }), options);

export const resourceDetail = (
  payload: ResourceRef,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellResourceResponse, ShellResourceClientError> =>
  prepared(shellAuthenticationClient.resources.resourceDetail({ payload }), options);

export const attachResourceMedia = (
  payload: ResourceRef,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<MediaAttachmentResponse, ShellResourceClientError> =>
  prepared(shellAuthenticationClient.resources.attachMedia({ payload }), options);

export const signOut = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignOutResponse> =>
  prepared(shellAuthenticationClient.authentication.signOut({}), options);

export const createNonHumanPrincipal = (
  payload: CreateNonHumanPrincipalPayload,
  options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.createNonHumanPrincipal({
      headers: identityHeaders(options),
      payload,
    }),
    options,
  );

export const changePrincipalStatus = (
  payload: ChangePrincipalStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse, IdentityClientError> =>
  prepared(
    // The overload is picked by the narrowed payload, so both arms stay.
    payload.newStatus === 'active'
      ? shellAuthenticationClient.identity.changePrincipalStatus({
          headers: identityHeaders(options),
          payload,
        })
      : shellAuthenticationClient.identity.changePrincipalStatus({
          headers: identityHeaders(options),
          payload,
        }),
    options,
  );

export const issueSelfApiKey = (
  payload: IssueApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.issueSelfApiKey({
      headers: identityHeaders(options),
      payload,
    }),
    options,
  );

export const listSelfApiKeys = (
  payload: IdentityListPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<SelfApiKeyListResponse, IdentityClientError> =>
  prepared(shellAuthenticationClient.identity.listSelfApiKeys({ payload }), options);

export const issueManagedApiKey = (
  payload: IssueManagedApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.issueManagedApiKey({
      headers: identityHeaders(options),
      payload,
    }),
    options,
  );

export const listManagedApiKeys = (
  payload: IdentityListPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ManagedApiKeyListResponse, IdentityClientError> =>
  prepared(shellAuthenticationClient.identity.listManagedApiKeys({ payload }), options);

export const setSelfApiKeyStatus = (
  payload: SetApiKeyStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyLifecycleResponse, IdentityClientError> =>
  prepared(
    // The overload is picked by the narrowed payload, so both arms stay.
    payload.newStatus === 'revoked'
      ? shellAuthenticationClient.identity.setSelfApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        })
      : shellAuthenticationClient.identity.setSelfApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        }),
    options,
  );

export const setManagedApiKeyStatus = (
  payload: SetManagedApiKeyStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyLifecycleResponse, IdentityClientError> =>
  prepared(
    // The overload is picked by the narrowed payload, so both arms stay.
    payload.newStatus === 'revoked'
      ? shellAuthenticationClient.identity.setManagedApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        })
      : shellAuthenticationClient.identity.setManagedApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        }),
    options,
  );

export const rotateSelfApiKey = (
  payload: RotateApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.rotateSelfApiKey({
      headers: identityHeaders(options),
      payload,
    }),
    options,
  );

export const rotateManagedApiKey = (
  payload: RotateManagedApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.rotateManagedApiKey({
      headers: identityHeaders(options),
      payload,
    }),
    options,
  );

export const startSupportImpersonation = (
  payload: StartSupportImpersonationPayload,
  options: IdentityClientOptions,
): Effect.Effect<SupportImpersonationResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.startSupportImpersonation({
      headers: identityHeaders(options),
      payload,
    }),
    options,
  );

export const stopSupportImpersonation = (
  options: IdentityClientOptions,
): Effect.Effect<SupportImpersonationResponse, IdentityClientError> =>
  prepared(
    shellAuthenticationClient.identity.stopSupportImpersonation({
      headers: identityHeaders(options),
    }),
    options,
  );

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
