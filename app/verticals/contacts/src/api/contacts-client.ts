/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- This is the published contract-derived client aggregate for governed Contacts operations. */
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
  AttachOrganizationEngagementPayload,
  AttachPersonEngagementPayload,
  ContactsReadiness,
  OperationContext,
  OrganizationEngagementLifecyclePayload,
  PersonEngagementLifecyclePayload,
} from '../../shared/api.ts';
import { actionGateway } from './action-gateway.ts';

export * from './organization-engagement-profile-client.ts';
export * from './person-engagement-profile-client.ts';
export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';

type ContactsApiGroups =
  typeof contactsApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type ContactsClient = HttpApiClient.Client<
  Extract<ContactsApiGroups, HttpApiGroup.Constraint>
>;
export type ContactsClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type ContactsClientEffect<Success> = Effect.Effect<Success, ContactsClientError>;

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

interface ContactsClientRequestContext {
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

interface ContactsClientHeaders extends Readonly<Record<string, string | undefined>> {
  authorization: string;
  'x-correlation-id': string;
  'x-trace-id'?: string;
}

const makeClient = (
  options: ContactsClientOptions,
  authentication?: ContactsClientAuthorization,
) => {
  const requestContext: ContactsClientRequestContext = {};
  if (options.locale !== undefined) {
    requestContext.locale = options.locale;
  }
  if (options.operationContext !== undefined) {
    requestContext.operationContext = options.operationContext;
  }
  if (options.traceparent !== undefined) {
    requestContext.traceparent = options.traceparent;
  }
  const config = {
    baseUrl: options.baseUrl ?? contactsApiContract.apiPrefix,
    requestContext,
  };
  if (authentication === undefined) {
    return makeEffectHttpApiClient(contactsApi, config);
  }
  const headers: ContactsClientHeaders = {
    authorization: authentication.authorization,
    'x-correlation-id': authentication.correlationId,
  };
  if (authentication.traceId !== undefined) {
    headers['x-trace-id'] = authentication.traceId;
  }
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

export const attachOrganizationEngagement = (
  payload: AttachOrganizationEngagementPayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.attachOrganizationEngagement, (client) =>
    client.organizationEngagementMutations.attach({
      headers: mutationHeaders(options),
      payload,
    }),
  );

export const archiveOrganizationEngagement = (
  payload: OrganizationEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.archiveOrganizationEngagement, (client) =>
    client.organizationEngagementMutations.archive({
      headers: mutationHeaders(options),
      payload,
    }),
  );

export const unarchiveOrganizationEngagement = (
  payload: OrganizationEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.unarchiveOrganizationEngagement, (client) =>
    client.organizationEngagementMutations.unarchive({
      headers: mutationHeaders(options),
      payload,
    }),
  );

export const attachPersonEngagement = (
  payload: AttachPersonEngagementPayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.attachPersonEngagement, (client) =>
    client.personEngagementMutations.attach({ headers: mutationHeaders(options), payload }),
  );

export const archivePersonEngagement = (
  payload: PersonEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.archivePersonEngagement, (client) =>
    client.personEngagementMutations.archive({ headers: mutationHeaders(options), payload }),
  );

export const unarchivePersonEngagement = (
  payload: PersonEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.unarchivePersonEngagement, (client) =>
    client.personEngagementMutations.unarchive({ headers: mutationHeaders(options), payload }),
  );
