import type { GatewayContextClientOptions } from '@app/shared-contracts';
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { projectsApi, projectsApiContract, projectsOperationContexts } from '../../shared/api.ts';
import type {
  ContactDetailRequest,
  ContactListRequest,
  ContactLifecyclePayload,
  CreateContactPayload,
  CreateCustomerPayload,
  ProjectsReadiness,
  CustomerAresLookupRequest,
  CustomerDetailRequest,
  CustomerLifecyclePayload,
  CustomerListRequest,
  EditContactPayload,
  EditCustomerPayload,
  OperationContext,
} from '../../shared/api.ts';
import { actionGateway } from './action-gateway.ts';

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';

type ProjectsApiGroups =
  typeof projectsApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type ProjectsClient = HttpApiClient.Client<
  Extract<ProjectsApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;
export type ProjectsClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type ProjectsClientEffect<Success> = Effect.Effect<Success, ProjectsClientError, never>;

export interface ProjectsClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly traceparent?: string;
}

export interface ProjectsOperationOptions extends ProjectsClientOptions {
  readonly correlationId: string;
  readonly gateway?: GatewayContextClientOptions;
  readonly traceId?: string;
}

export interface ProjectsMutationOptions extends ProjectsOperationOptions {
  readonly idempotencyKey: string;
}

interface ProjectsClientAuthorization {
  readonly authorization: string;
  readonly correlationId: string;
  readonly traceId?: string;
}

const makeClient = (
  options: ProjectsClientOptions,
  authentication?: ProjectsClientAuthorization,
) => {
  const localeContext = options.locale === undefined ? {} : { locale: options.locale };
  const operationContext =
    options.operationContext === undefined
      ? localeContext
      : { ...localeContext, operationContext: options.operationContext };
  const requestContext =
    options.traceparent === undefined
      ? operationContext
      : { ...operationContext, traceparent: options.traceparent };
  const config = {
    baseUrl: options.baseUrl ?? projectsApiContract.apiPrefix,
    requestContext,
  };
  if (authentication === undefined) {
    return makeEffectHttpApiClient(projectsApi, config);
  }
  const headers =
    authentication.traceId === undefined
      ? {
          authorization: authentication.authorization,
          'x-correlation-id': authentication.correlationId,
        }
      : {
          authorization: authentication.authorization,
          'x-correlation-id': authentication.correlationId,
          'x-trace-id': authentication.traceId,
        };
  return makeEffectHttpApiClient(projectsApi, {
    ...config,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
  });
};

export const createProjectsClient = (
  options: ProjectsClientOptions = {},
): ProjectsClientEffect<ProjectsClient> => makeClient(options);

const invoke = <Success, Failure>(
  options: ProjectsOperationOptions,
  context: OperationContext,
  operation: (client: ProjectsClient) => Effect.Effect<Success, Failure>,
) =>
  actionGateway.invoke((authorization) => {
    const operationContext =
      options.operationContext ??
      (options.traceId === undefined ? context : { ...context, traceId: options.traceId });
    const authentication =
      options.traceId === undefined
        ? { authorization, correlationId: options.correlationId }
        : { authorization, correlationId: options.correlationId, traceId: options.traceId };
    return makeClient({ ...options, operationContext }, authentication).pipe(
      Effect.flatMap(operation),
    );
  }, options.gateway);

const mutationHeaders = (options: ProjectsMutationOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

export const getProjectsReadiness = (
  options: ProjectsClientOptions = {},
): ProjectsClientEffect<ProjectsReadiness> =>
  createProjectsClient({
    ...options,
    operationContext: options.operationContext ?? projectsOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export const createCustomer = (payload: CreateCustomerPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.createCustomer, (client) =>
    client.customerMutations.createCustomer({ headers: mutationHeaders(options), payload }),
  );
export const editCustomer = (payload: EditCustomerPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.editCustomer, (client) =>
    client.customerMutations.editCustomer({ headers: mutationHeaders(options), payload }),
  );
export const archiveCustomer = (
  payload: CustomerLifecyclePayload,
  options: ProjectsMutationOptions,
) =>
  invoke(options, projectsOperationContexts.archiveCustomer, (client) =>
    client.customerMutations.archiveCustomer({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveCustomer = (
  payload: CustomerLifecyclePayload,
  options: ProjectsMutationOptions,
) =>
  invoke(options, projectsOperationContexts.unarchiveCustomer, (client) =>
    client.customerMutations.unarchiveCustomer({ headers: mutationHeaders(options), payload }),
  );

export const createContact = (payload: CreateContactPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.createContact, (client) =>
    client.contactMutations.createContact({ headers: mutationHeaders(options), payload }),
  );
export const editContact = (payload: EditContactPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.editContact, (client) =>
    client.contactMutations.editContact({ headers: mutationHeaders(options), payload }),
  );
export const archiveContact = (
  payload: ContactLifecyclePayload,
  options: ProjectsMutationOptions,
) =>
  invoke(options, projectsOperationContexts.archiveContact, (client) =>
    client.contactMutations.archiveContact({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveContact = (
  payload: ContactLifecyclePayload,
  options: ProjectsMutationOptions,
) =>
  invoke(options, projectsOperationContexts.unarchiveContact, (client) =>
    client.contactMutations.unarchiveContact({ headers: mutationHeaders(options), payload }),
  );

export const getCustomerDetail = (
  payload: CustomerDetailRequest,
  options: ProjectsOperationOptions,
) =>
  invoke(options, projectsOperationContexts.getCustomerDetail, (client) =>
    client.customerDetail.getCustomerDetail({ payload }),
  );
export const getCustomerList = (payload: CustomerListRequest, options: ProjectsOperationOptions) =>
  invoke(options, projectsOperationContexts.getCustomerList, (client) =>
    client.customerList.getCustomerList({ payload }),
  );
export const lookupCustomerAres = (
  payload: CustomerAresLookupRequest,
  options: ProjectsOperationOptions,
) =>
  invoke(options, projectsOperationContexts.lookupCustomerAres, (client) =>
    client.customerAresLookup.lookup({ payload }),
  );
export const getContact = (payload: ContactDetailRequest, options: ProjectsOperationOptions) =>
  invoke(options, projectsOperationContexts.getContact, (client) =>
    client.contactDetail.getContact({ payload }),
  );
export const getContactList = (payload: ContactListRequest, options: ProjectsOperationOptions) =>
  invoke(options, projectsOperationContexts.getContactList, (client) =>
    client.contactList.getContactList({ payload }),
  );
