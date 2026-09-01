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
import { contactsApi, contactsApiContract, contactsOperationContexts } from '../../shared/api.ts';
import type {
  ContactDetailRequest,
  ContactListRequest,
  ContactLifecyclePayload,
  CreateContactPayload,
  CreateCustomerPayload,
  ContactsReadiness,
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

type ContactsApiGroups =
  typeof contactsApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type ContactsClient = HttpApiClient.Client<
  Extract<ContactsApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;
export type ContactsClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type ContactsClientEffect<Success> = Effect.Effect<Success, ContactsClientError, never>;

export interface ContactsClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly traceparent?: string;
}

export interface ContactsOperationOptions extends ContactsClientOptions {
  readonly correlationId: string;
  readonly gateway?: GatewayContextClientOptions;
  readonly traceId?: string;
}

export interface ContactsMutationOptions extends ContactsOperationOptions {
  readonly idempotencyKey: string;
}

interface ContactsClientAuthorization {
  readonly authorization: string;
  readonly correlationId: string;
  readonly traceId?: string;
}

const makeClient = (
  options: ContactsClientOptions,
  authentication?: ContactsClientAuthorization,
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
    baseUrl: options.baseUrl ?? contactsApiContract.apiPrefix,
    requestContext,
  };
  if (authentication === undefined) {
    return makeEffectHttpApiClient(contactsApi, config);
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
  return makeEffectHttpApiClient(contactsApi, {
    ...config,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
  });
};

export const createContactsClient = (
  options: ContactsClientOptions = {},
): ContactsClientEffect<ContactsClient> => makeClient(options);

const invoke = <Success, Failure>(
  options: ContactsOperationOptions,
  context: OperationContext,
  operation: (client: ContactsClient) => Effect.Effect<Success, Failure>,
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

const mutationHeaders = (options: ContactsMutationOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

export const getContactsReadiness = (
  options: ContactsClientOptions = {},
): ContactsClientEffect<ContactsReadiness> =>
  createContactsClient({
    ...options,
    operationContext: options.operationContext ?? contactsOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export const createCustomer = (payload: CreateCustomerPayload, options: ContactsMutationOptions) =>
  invoke(options, contactsOperationContexts.createCustomer, (client) =>
    client.customerMutations.createCustomer({ headers: mutationHeaders(options), payload }),
  );
export const editCustomer = (payload: EditCustomerPayload, options: ContactsMutationOptions) =>
  invoke(options, contactsOperationContexts.editCustomer, (client) =>
    client.customerMutations.editCustomer({ headers: mutationHeaders(options), payload }),
  );
export const archiveCustomer = (
  payload: CustomerLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.archiveCustomer, (client) =>
    client.customerMutations.archiveCustomer({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveCustomer = (
  payload: CustomerLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.unarchiveCustomer, (client) =>
    client.customerMutations.unarchiveCustomer({ headers: mutationHeaders(options), payload }),
  );

export const createContact = (payload: CreateContactPayload, options: ContactsMutationOptions) =>
  invoke(options, contactsOperationContexts.createContact, (client) =>
    client.contactMutations.createContact({ headers: mutationHeaders(options), payload }),
  );
export const editContact = (payload: EditContactPayload, options: ContactsMutationOptions) =>
  invoke(options, contactsOperationContexts.editContact, (client) =>
    client.contactMutations.editContact({ headers: mutationHeaders(options), payload }),
  );
export const archiveContact = (
  payload: ContactLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.archiveContact, (client) =>
    client.contactMutations.archiveContact({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveContact = (
  payload: ContactLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.unarchiveContact, (client) =>
    client.contactMutations.unarchiveContact({ headers: mutationHeaders(options), payload }),
  );

export const getCustomerDetail = (
  payload: CustomerDetailRequest,
  options: ContactsOperationOptions,
) =>
  invoke(options, contactsOperationContexts.getCustomerDetail, (client) =>
    client.customerDetail.getCustomerDetail({ payload }),
  );
export const getCustomerList = (payload: CustomerListRequest, options: ContactsOperationOptions) =>
  invoke(options, contactsOperationContexts.getCustomerList, (client) =>
    client.customerList.getCustomerList({ payload }),
  );
export const lookupCustomerAres = (
  payload: CustomerAresLookupRequest,
  options: ContactsOperationOptions,
) =>
  invoke(options, contactsOperationContexts.lookupCustomerAres, (client) =>
    client.customerAresLookup.lookup({ payload }),
  );
export const getContact = (payload: ContactDetailRequest, options: ContactsOperationOptions) =>
  invoke(options, contactsOperationContexts.getContact, (client) =>
    client.contactDetail.getContact({ payload }),
  );
export const getContactList = (payload: ContactListRequest, options: ContactsOperationOptions) =>
  invoke(options, contactsOperationContexts.getContactList, (client) =>
    client.contactList.getContactList({ payload }),
  );
