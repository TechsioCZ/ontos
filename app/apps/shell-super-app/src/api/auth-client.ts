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
  Extract<ShellAuthenticationApiGroups, HttpApiGroup.Any>,
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

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
