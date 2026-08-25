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
import { crmApi, crmApiContract, crmOperationContexts } from '../../shared/api.ts';
import type {
  ContactDetailRequest,
  ContactListRequest,
  ContactLifecyclePayload,
  CreateContactPayload,
  CreateCustomerPayload,
  CrmReadiness,
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

type CrmApiGroups =
  typeof crmApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type CrmClient = HttpApiClient.Client<Extract<CrmApiGroups, HttpApiGroup.Any>, never, never>;
export type CrmClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type CrmClientEffect<Success> = Effect.Effect<Success, CrmClientError, never>;

export interface CrmClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly traceparent?: string;
}

export interface CrmOperationOptions extends CrmClientOptions {
  readonly correlationId: string;
  readonly gateway?: GatewayContextClientOptions;
  readonly traceId?: string;
}

export interface CrmMutationOptions extends CrmOperationOptions {
  readonly idempotencyKey: string;
}

interface CrmClientAuthorization {
  readonly authorization: string;
  readonly correlationId: string;
  readonly traceId?: string;
}

const makeClient = (options: CrmClientOptions, authentication?: CrmClientAuthorization) => {
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
    baseUrl: options.baseUrl ?? crmApiContract.apiPrefix,
    requestContext,
  };
  if (authentication === undefined) {
    return makeEffectHttpApiClient(crmApi, config);
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
  return makeEffectHttpApiClient(crmApi, {
    ...config,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
  });
};

export const createCrmClient = (options: CrmClientOptions = {}): CrmClientEffect<CrmClient> =>
  makeClient(options);

const invoke = <Success, Failure>(
  options: CrmOperationOptions,
  context: OperationContext,
  operation: (client: CrmClient) => Effect.Effect<Success, Failure>,
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

const mutationHeaders = (options: CrmMutationOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

export const getCrmReadiness = (options: CrmClientOptions = {}): CrmClientEffect<CrmReadiness> =>
  createCrmClient({
    ...options,
    operationContext: options.operationContext ?? crmOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export const createCustomer = (payload: CreateCustomerPayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.createCustomer, (client) =>
    client.customerMutations.createCustomer({ headers: mutationHeaders(options), payload }),
  );
export const editCustomer = (payload: EditCustomerPayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.editCustomer, (client) =>
    client.customerMutations.editCustomer({ headers: mutationHeaders(options), payload }),
  );
export const archiveCustomer = (payload: CustomerLifecyclePayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.archiveCustomer, (client) =>
    client.customerMutations.archiveCustomer({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveCustomer = (payload: CustomerLifecyclePayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.unarchiveCustomer, (client) =>
    client.customerMutations.unarchiveCustomer({ headers: mutationHeaders(options), payload }),
  );

export const createContact = (payload: CreateContactPayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.createContact, (client) =>
    client.contactMutations.createContact({ headers: mutationHeaders(options), payload }),
  );
export const editContact = (payload: EditContactPayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.editContact, (client) =>
    client.contactMutations.editContact({ headers: mutationHeaders(options), payload }),
  );
export const archiveContact = (payload: ContactLifecyclePayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.archiveContact, (client) =>
    client.contactMutations.archiveContact({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveContact = (payload: ContactLifecyclePayload, options: CrmMutationOptions) =>
  invoke(options, crmOperationContexts.unarchiveContact, (client) =>
    client.contactMutations.unarchiveContact({ headers: mutationHeaders(options), payload }),
  );

export const getCustomerDetail = (payload: CustomerDetailRequest, options: CrmOperationOptions) =>
  invoke(options, crmOperationContexts.getCustomerDetail, (client) =>
    client.customerDetail.getCustomerDetail({ payload }),
  );
export const getCustomerList = (payload: CustomerListRequest, options: CrmOperationOptions) =>
  invoke(options, crmOperationContexts.getCustomerList, (client) =>
    client.customerList.getCustomerList({ payload }),
  );
export const lookupCustomerAres = (
  payload: CustomerAresLookupRequest,
  options: CrmOperationOptions,
) =>
  invoke(options, crmOperationContexts.lookupCustomerAres, (client) =>
    client.customerAresLookup.lookup({ payload }),
  );
export const getContact = (payload: ContactDetailRequest, options: CrmOperationOptions) =>
  invoke(options, crmOperationContexts.getContact, (client) =>
    client.contactDetail.getContact({ payload }),
  );
export const getContactList = (payload: ContactListRequest, options: CrmOperationOptions) =>
  invoke(options, crmOperationContexts.getContactList, (client) =>
    client.contactList.getContactList({ payload }),
  );
