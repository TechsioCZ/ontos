import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { Context } from 'effect';
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
  typeof ShellAuthenticationApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type ShellAuthenticationClient = HttpApiClient.Client<
  Extract<ShellAuthenticationApiGroups, HttpApiGroup.Constraint>
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

export type ShellAuthenticationClientEffect<Success> = Effect.Effect<Success, ShellAuthenticationClientError>;

export type AvailableTenantsClientError =
  | TenantAuthenticationRequiredProblem
  | TenantCapabilityUnavailableProblem
  | TenantInternalProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type SwitchTenantClientError = AvailableTenantsClientError | TenantAccessForbiddenProblem;

export type AvailableTenantsClientEffect = Effect.Effect<AvailableTenantsResponse, AvailableTenantsClientError>;

export type SwitchTenantClientEffect = Effect.Effect<SwitchTenantResponse, SwitchTenantClientError>;

export type AvailableLegalEntitiesClientEffect = Effect.Effect<
  AvailableLegalEntitiesResponse,
  AvailableTenantsClientError
>;

export type SwitchLegalEntityClientError = AvailableTenantsClientError | LegalEntityAccessForbiddenProblem;

export type SwitchLegalEntityClientEffect = Effect.Effect<SwitchLegalEntityResponse, SwitchLegalEntityClientError>;

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

export type IdentityClientError = IdentityProblem | HttpClientError.HttpClientError | Schema.SchemaError;

export interface IdentityClientOptions extends ShellAuthenticationClientOptions {
  readonly idempotencyKey: string;
}

const identityHeaders = (options: IdentityClientOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

const ShellAuthenticationRequestOptions = Context.Reference<ShellAuthenticationClientOptions>(
  'ShellAuthenticationRequestOptions',
  { defaultValue: () => ({}) },
);

const shellAuthenticationClient = makeEffectHttpApiClient(ShellAuthenticationApi, {
  transformClient: HttpClient.mapRequestEffect((request) =>
    ShellAuthenticationRequestOptions.pipe(
      Effect.map((options) => {
        let nextRequest = HttpClientRequest.prependUrl(
          request,
          (options.baseUrl ?? shellAuthenticationApiContract.apiPrefix).toString(),
        );
        if (options.locale !== undefined && nextRequest.headers['accept-language'] === undefined) {
          nextRequest = HttpClientRequest.setHeader(nextRequest, 'accept-language', options.locale);
        }
        if (options.cookie !== undefined) {
          nextRequest = HttpClientRequest.setHeader(nextRequest, 'cookie', options.cookie);
        }
        return nextRequest;
      }),
    ),
  ),
});

const invokeShellAuthenticationClient = <Success, Failure>(
  options: ShellAuthenticationClientOptions,
  operation: (client: ShellAuthenticationClient) => Effect.Effect<Success, Failure>,
): Effect.Effect<Success, Failure> =>
  shellAuthenticationClient.pipe(
    Effect.flatMap(operation),
    Effect.provideService(ShellAuthenticationRequestOptions, options),
  );

export const signIn = (
  payload: SignInPayload,
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignInResponse> =>
  invokeShellAuthenticationClient(options, (client) => client.authentication.signIn({ payload }));

export const currentSession = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<CurrentSession> =>
  invokeShellAuthenticationClient(options, (client) => client.authentication.currentSession({}));

export const availableTenants = (options: ShellAuthenticationClientOptions = {}): AvailableTenantsClientEffect =>
  invokeShellAuthenticationClient(options, (client) => client.tenants.availableTenants({}));

export const switchTenant = (
  payload: SwitchTenantPayload,
  options: ShellAuthenticationClientOptions = {},
): SwitchTenantClientEffect =>
  invokeShellAuthenticationClient(options, (client) => client.tenants.switchTenant({ payload }));

export const availableLegalEntities = (
  options: ShellAuthenticationClientOptions = {},
): AvailableLegalEntitiesClientEffect =>
  invokeShellAuthenticationClient(options, (client) => client.legalEntities.availableLegalEntities({}));

export const switchLegalEntity = (
  payload: SwitchLegalEntityPayload,
  options: ShellAuthenticationClientOptions = {},
): SwitchLegalEntityClientEffect =>
  invokeShellAuthenticationClient(options, (client) => client.legalEntities.switchLegalEntity({ payload }));

export const shellComposition = (
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellComposition, ShellCompositionClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.composition.shellComposition({}));

export const resolveModuleTarget = (
  payload: ResolveModuleTargetPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ResolvedModuleTarget, ShellTargetClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.composition.resolveModuleTarget({ payload }));

export const searchResources = (
  payload: ShellSearchPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellSearchResponse, ShellSearchClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.resources.search({ payload }));

export const resourceDetail = (
  payload: ResourceRef,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellResourceResponse, ShellResourceClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.resources.resourceDetail({ payload }));

export const attachResourceMedia = (
  payload: ResourceRef,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<MediaAttachmentResponse, ShellResourceClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.resources.attachMedia({ payload }));

export const signOut = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignOutResponse> =>
  invokeShellAuthenticationClient(options, (client) => client.authentication.signOut({}));

export const createNonHumanPrincipal = (
  payload: CreateNonHumanPrincipalPayload,
  options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.createNonHumanPrincipal({
      headers: identityHeaders(options),
      payload,
    }),
  );

export const changePrincipalStatus = (
  payload: ChangePrincipalStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<PrincipalMutationResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    payload.newStatus === 'active'
      ? client.identity.changePrincipalStatus({
          headers: identityHeaders(options),
          payload,
        })
      : client.identity.changePrincipalStatus({
          headers: identityHeaders(options),
          payload,
        }),
  );

export const issueSelfApiKey = (
  payload: IssueApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.issueSelfApiKey({
      headers: identityHeaders(options),
      payload,
    }),
  );

export const listSelfApiKeys = (
  payload: IdentityListPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<SelfApiKeyListResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.identity.listSelfApiKeys({ payload }));

export const issueManagedApiKey = (
  payload: IssueManagedApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.issueManagedApiKey({
      headers: identityHeaders(options),
      payload,
    }),
  );

export const listManagedApiKeys = (
  payload: IdentityListPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ManagedApiKeyListResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.identity.listManagedApiKeys({ payload }));

export const setSelfApiKeyStatus = (
  payload: SetApiKeyStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyLifecycleResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    payload.newStatus === 'revoked'
      ? client.identity.setSelfApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        })
      : client.identity.setSelfApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        }),
  );

export const setManagedApiKeyStatus = (
  payload: SetManagedApiKeyStatusPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyLifecycleResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    payload.newStatus === 'revoked'
      ? client.identity.setManagedApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        })
      : client.identity.setManagedApiKeyStatus({
          headers: identityHeaders(options),
          payload,
        }),
  );

export const rotateSelfApiKey = (
  payload: RotateApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.rotateSelfApiKey({
      headers: identityHeaders(options),
      payload,
    }),
  );

export const rotateManagedApiKey = (
  payload: RotateManagedApiKeyPayload,
  options: IdentityClientOptions,
): Effect.Effect<ApiKeyIssueResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.rotateManagedApiKey({
      headers: identityHeaders(options),
      payload,
    }),
  );

export const startSupportImpersonation = (
  payload: StartSupportImpersonationPayload,
  options: IdentityClientOptions,
): Effect.Effect<SupportImpersonationResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.startSupportImpersonation({
      headers: identityHeaders(options),
      payload,
    }),
  );

export const stopSupportImpersonation = (
  options: IdentityClientOptions,
): Effect.Effect<SupportImpersonationResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.identity.stopSupportImpersonation({
      headers: identityHeaders(options),
    }),
  );

export { Effect } from '@modern-js/plugin-bff/effect-client';
