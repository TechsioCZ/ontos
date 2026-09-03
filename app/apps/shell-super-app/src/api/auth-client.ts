import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
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
  Extract<ShellAuthenticationApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;

export interface ShellAuthenticationClientOptions {
  readonly baseUrl?: string | URL;
  readonly cookie?: string;
  readonly locale?: string;
}

export type ShellAuthenticationClientError =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type ShellAuthenticationClientEffect<Success> = Effect.Effect<
  Success,
  ShellAuthenticationClientError
>;

export type AvailableTenantsClientError =
  | TenantAuthenticationRequiredProblem
  | TenantCapabilityUnavailableProblem
  | TenantInternalProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

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
  | ShellInternalProblem;

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
  | Schema.SchemaError;

export interface IdentityClientOptions extends ShellAuthenticationClientOptions {
  readonly idempotencyKey: string;
}

const identityHeaders = (options: IdentityClientOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

const createShellAuthenticationClient = (
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellAuthenticationClient> => {
  const requestContext =
    options.locale === undefined
      ? {}
      : {
          requestContext: {
            locale: options.locale,
          },
        };
  const transformClient =
    options.cookie === undefined
      ? {}
      : {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader('cookie', options.cookie),
          ),
        };

  return makeEffectHttpApiClient(ShellAuthenticationApi, {
    baseUrl: options.baseUrl ?? shellAuthenticationApiContract.apiPrefix,
    ...requestContext,
    ...transformClient,
  });
};

export const signIn = (
  payload: SignInPayload,
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignInResponse> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.signIn({ payload })),
  );

export const currentSession = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<CurrentSession> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.currentSession({})),
  );

export const availableTenants = (
  options: ShellAuthenticationClientOptions = {},
): AvailableTenantsClientEffect =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.tenants.availableTenants({})),
  );

export const switchTenant = (
  payload: SwitchTenantPayload,
  options: ShellAuthenticationClientOptions = {},
): SwitchTenantClientEffect =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.tenants.switchTenant({ payload })),
  );

export const availableLegalEntities = (
  options: ShellAuthenticationClientOptions = {},
): AvailableLegalEntitiesClientEffect =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.legalEntities.availableLegalEntities({})),
  );

export const switchLegalEntity = (
  payload: SwitchLegalEntityPayload,
  options: ShellAuthenticationClientOptions = {},
): SwitchLegalEntityClientEffect =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.legalEntities.switchLegalEntity({ payload })),
  );

export const shellComposition = (
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellComposition, ShellCompositionClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.composition.shellComposition({})),
  );

export const resolveModuleTarget = (
  payload: ResolveModuleTargetPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ResolvedModuleTarget, ShellTargetClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.composition.resolveModuleTarget({ payload })),
  );

export const searchResources = (
  payload: ShellSearchPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellSearchResponse, ShellSearchClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.resources.search({ payload })),
  );

export const resourceDetail = (
  payload: ResourceRef,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellResourceResponse, ShellResourceClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.resources.resourceDetail({ payload })),
  );

export const attachResourceMedia = (
  payload: ResourceRef,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<MediaAttachmentResponse, ShellResourceClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.resources.attachMedia({ payload })),
  );

export const signOut = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignOutResponse> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.signOut({})),
  );

export const createNonHumanPrincipal = (
  payload: CreateNonHumanPrincipalPayload,
  options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.createNonHumanPrincipal({ headers: identityHeaders(options), payload }),
    ),
  );

export const changePrincipalStatus = (
  payload: ChangePrincipalStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      payload.newStatus === 'active'
        ? client.identity.changePrincipalStatus({ headers: identityHeaders(options), payload })
        : client.identity.changePrincipalStatus({ headers: identityHeaders(options), payload }),
    ),
  );

export const issueSelfApiKey = (
  payload: IssueApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.issueSelfApiKey({ headers: identityHeaders(options), payload }),
    ),
  );

export const listSelfApiKeys = (
  payload: IdentityListPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<SelfApiKeyListResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.identity.listSelfApiKeys({ payload })),
  );

export const issueManagedApiKey = (
  payload: IssueManagedApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.issueManagedApiKey({ headers: identityHeaders(options), payload }),
    ),
  );

export const listManagedApiKeys = (
  payload: IdentityListPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ManagedApiKeyListResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.identity.listManagedApiKeys({ payload })),
  );

export const setSelfApiKeyStatus = (
  payload: SetApiKeyStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyLifecycleResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      payload.newStatus === 'revoked'
        ? client.identity.setSelfApiKeyStatus({ headers: identityHeaders(options), payload })
        : client.identity.setSelfApiKeyStatus({ headers: identityHeaders(options), payload }),
    ),
  );

export const setManagedApiKeyStatus = (
  payload: SetManagedApiKeyStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyLifecycleResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      payload.newStatus === 'revoked'
        ? client.identity.setManagedApiKeyStatus({ headers: identityHeaders(options), payload })
        : client.identity.setManagedApiKeyStatus({ headers: identityHeaders(options), payload }),
    ),
  );

export const rotateSelfApiKey = (
  payload: RotateApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.rotateSelfApiKey({ headers: identityHeaders(options), payload }),
    ),
  );

export const rotateManagedApiKey = (
  payload: RotateManagedApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.rotateManagedApiKey({ headers: identityHeaders(options), payload }),
    ),
  );

export const startSupportImpersonation = (
  payload: StartSupportImpersonationPayload,
  options: IdentityClientOptions,
): Effect.Effect<SupportImpersonationResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.startSupportImpersonation({ headers: identityHeaders(options), payload }),
    ),
  );

export const stopSupportImpersonation = (
  options: IdentityClientOptions,
): Effect.Effect<SupportImpersonationResponse, IdentityClientError> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) =>
      client.identity.stopSupportImpersonation({ headers: identityHeaders(options) }),
    ),
  );

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
