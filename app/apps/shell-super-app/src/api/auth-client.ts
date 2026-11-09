import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/bff-effect/effect-client';
import { Context, Crypto, PlatformError } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { AccessAdministrationApi } from '../../shared/access-admin-api.ts';
import type {
  AccessAdminProblem,
  AccessApproval,
  AccessPeopleMutationResponse,
  CreateAccessRolePayload,
  DecideAccessApprovalPayload,
  DecideAccessChangesPayload,
  DecideAccessChangesResponse,
  ExecuteAccessApprovalPayload,
  ExplainAccessPayload,
  ExplainAccessResponse,
  GetAccessRolePayload,
  GetAccessRoleResponse,
  ListAccessApprovalsPayload,
  ListAccessApprovalsResponse,
  ListAccessAssignmentsPayload,
  ListAccessAssignmentsResponse,
  ListAccessChangesPayload,
  ListAccessChangesResponse,
  ListAccessPeoplePayload,
  ListAccessPeopleOptionsResponse,
  ListAccessPeopleResponse,
  ListAccessRolesPayload,
  ListAccessRolesResponse,
  ListAccessRoleTemplatesPayload,
  ListAccessRoleTemplatesResponse,
  PreviewAccessChangesPayload,
  PreviewAccessChangesResponse,
  AccessRoleEditPayload,
  PreviewAccessRoleEditResponse,
  SaveAccessRoleEditPayload,
  SaveAccessRoleEditResponse,
  AssignAccessRolePayload,
  RevokeAccessAssignmentPayload,
  CreateAccessDelegationPayload,
  RevokeAccessDelegationPayload,
  SetAccessTeamMembershipPayload,
  TransferAccessOwnershipPayload,
} from '../../shared/access-admin-api.ts';
// @ontos-codesmith-core-read-client-imports:start

// @ontos-core-read legal-entity-detail
import type {
  LegalEntityDetailRequest,
  LegalEntityDetailResponse,
} from '../../shared/core-reads/legal-entity-detail.ts';
// @ontos-codesmith-core-read-client-imports:end
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
  ShellCompositionRequest,
  ShellReloadRequiredProblem,
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
  ShellResourceRequest,
  ShellResourceResponse,
  ShellSearchPayload,
  ShellSearchResponse,
} from '../../shared/browser-api.ts';

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
  | ShellReloadRequiredProblem
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

const shellAuthenticationClientOptions = {
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
};

const shellAuthenticationClient = makeEffectHttpApiClient(ShellAuthenticationApi, shellAuthenticationClientOptions);
const accessAdministrationClient = makeEffectHttpApiClient(AccessAdministrationApi, shellAuthenticationClientOptions);
type AccessAdministrationClient = HttpApiClient.Client<
  Extract<
    typeof AccessAdministrationApi extends HttpApi.HttpApi<infer _Id, infer Groups> ? Groups : never,
    HttpApiGroup.Constraint
  >
>;
export type AccessAdministrationClientError = AccessAdminProblem | HttpClientError.HttpClientError | Schema.SchemaError;
export interface AccessAdministrationWriteOptions extends ShellAuthenticationClientOptions {
  readonly idempotencyKey: string;
}
const accessWriteHeaders = (options: AccessAdministrationWriteOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

/** Secure, retry-stable command identity is created once at the UI boundary, then reused on retry. */
const browserCrypto = Crypto.make({
  digest: (algorithm, data) => {
    const input = new Uint8Array(data.byteLength);
    input.set(data);
    return Effect.tryPromise({
      catch: (cause) => PlatformError.systemError({ _tag: 'Unknown', cause, method: 'digest', module: 'WebCrypto' }),
      try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, algorithm, input),
    }).pipe(Effect.map((result) => new Uint8Array(result)));
  },
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});
export const createAccessAdministrationIdempotencyKey = (): Effect.Effect<string, PlatformError.PlatformError> =>
  browserCrypto.randomUUIDv4();
const invokeAccessAdministrationClient = <Success, Failure>(
  options: ShellAuthenticationClientOptions,
  operation: (client: AccessAdministrationClient) => Effect.Effect<Success, Failure>,
): Effect.Effect<Success, Failure> =>
  accessAdministrationClient.pipe(
    Effect.flatMap(operation),
    Effect.provideService(ShellAuthenticationRequestOptions, options),
  );

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
  payload: ShellCompositionRequest,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellComposition, ShellCompositionClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.composition.shellComposition({ query: payload }));

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
  payload: ShellResourceRequest,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellResourceResponse, ShellResourceClientError> =>
  invokeShellAuthenticationClient(options, (client) => client.resources.resourceDetail({ payload }));

export const attachResourceMedia = (
  payload: ShellResourceRequest,
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

// @ontos-codesmith-core-read-client-operations:start

// @ontos-core-read legal-entity-detail
export const executeLegalEntityDetail = (
  payload: LegalEntityDetailRequest,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<LegalEntityDetailResponse, IdentityClientError> =>
  invokeShellAuthenticationClient(options, (client) =>
    client.coreReadLegalEntityDetail.executeLegalEntityDetail({ payload }),
  );
// @ontos-codesmith-core-read-client-operations:end

// All administration calls use the typed native HttpApi client. The authenticated tenant is
// resolved again by the BFF; neither a company selection nor a browser tenant id grants access.
export const listAccessRoles = (
  payload: ListAccessRolesPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessRolesResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminRoles.listAccessRoles({ payload }));
export const getAccessRole = (
  payload: GetAccessRolePayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<GetAccessRoleResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminRoles.getAccessRole({ payload }));
export const listAccessRoleTemplates = (
  payload: ListAccessRoleTemplatesPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessRoleTemplatesResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminRoles.listAccessRoleTemplates({ payload }));
export const previewAccessRoleEdit = (
  payload: AccessRoleEditPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<PreviewAccessRoleEditResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminRoles.previewAccessRoleEdit({ payload }));
export const saveAccessRoleEdit = (
  payload: SaveAccessRoleEditPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<SaveAccessRoleEditResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminRoles.saveAccessRoleEdit({ headers: accessWriteHeaders(options), payload }),
  );
export const createAccessRole = (
  payload: CreateAccessRolePayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<GetAccessRoleResponse['role'], AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminRoles.createAccessRole({ headers: accessWriteHeaders(options), payload }),
  );

export const listAccessPeople = (
  payload: ListAccessPeoplePayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessPeopleResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminPeople.listAccessPeople({ payload }));
export const listAccessPeopleOptions = (
  payload: ListAccessPeoplePayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessPeopleOptionsResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminPeople.listAccessPeopleOptions({ payload }));
export const listAccessAssignments = (
  payload: ListAccessAssignmentsPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessAssignmentsResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminPeople.listAccessAssignments({ payload }));
export const assignAccessRole = (
  payload: AssignAccessRolePayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessPeopleMutationResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminPeople.assignAccessRole({ headers: accessWriteHeaders(options), payload }),
  );
export const revokeAccessAssignment = (
  payload: RevokeAccessAssignmentPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessPeopleMutationResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminPeople.revokeAccessAssignment({ headers: accessWriteHeaders(options), payload }),
  );
export const setAccessTeamMembership = (
  payload: SetAccessTeamMembershipPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessPeopleMutationResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminPeople.setAccessTeamMembership({ headers: accessWriteHeaders(options), payload }),
  );
export const createAccessDelegation = (
  payload: CreateAccessDelegationPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessPeopleMutationResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminPeople.createAccessDelegation({ headers: accessWriteHeaders(options), payload }),
  );
export const revokeAccessDelegation = (
  payload: RevokeAccessDelegationPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessPeopleMutationResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminPeople.revokeAccessDelegation({ headers: accessWriteHeaders(options), payload }),
  );
export const transferAccessOwnership = (
  payload: TransferAccessOwnershipPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessPeopleMutationResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminPeople.transferAccessOwnership({ headers: accessWriteHeaders(options), payload }),
  );

export const listAccessChanges = (
  payload: ListAccessChangesPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessChangesResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminChanges.listAccessChanges({ payload }));
export const previewAccessChanges = (
  payload: PreviewAccessChangesPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<PreviewAccessChangesResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminChanges.previewAccessChanges({ payload }));
export const decideAccessChanges = (
  payload: DecideAccessChangesPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<DecideAccessChangesResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminChanges.decideAccessChanges({ headers: accessWriteHeaders(options), payload }),
  );

export const listAccessApprovals = (
  payload: ListAccessApprovalsPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ListAccessApprovalsResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminApprovals.listAccessApprovals({ payload }));
export const decideAccessApproval = (
  payload: DecideAccessApprovalPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessApproval, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminApprovals.decideAccessApproval({ headers: accessWriteHeaders(options), payload }),
  );
export const executeAccessApproval = (
  payload: ExecuteAccessApprovalPayload,
  options: AccessAdministrationWriteOptions,
): Effect.Effect<AccessApproval, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) =>
    client.accessAdminApprovals.executeAccessApproval({ headers: accessWriteHeaders(options), payload }),
  );

export const explainAccess = (
  payload: ExplainAccessPayload,
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ExplainAccessResponse, AccessAdministrationClientError> =>
  invokeAccessAdministrationClient(options, (client) => client.accessAdminExplain.explainAccess({ payload }));

export { Effect } from '@modern-js/bff-effect/effect-client';
