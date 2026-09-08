/* eslint-disable oxc/no-barrel-file -- This is the generated client aggregate; remove-when: Codesmith emits direct re-exports. */
import type { GatewayContextClientOptions } from '@app/shared-contracts';
import { Effect } from '@modern-js/plugin-bff/effect-client';
import type { HttpClientError, Schema } from '@modern-js/plugin-bff/effect-client';
import { Redacted } from 'effect';
import {
  engagementProfileOperationContexts,
  partyRegistryOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, PartyRegistryReadiness } from '../../shared/api.ts';
import { operationGateway } from './action-gateway.ts';
import {
  authenticatePartyRegistryHttpRequest,
  createPartyRegistryHttpClient,
  invokePartyRegistryHttpClient,
  partyRegistryHttpRequestContext,
} from './party-registry-http-client.ts';
import type { PartyRegistryHttpClient } from './party-registry-http-client.ts';

export * from './organization-engagement-profile-client.ts';
export * from './person-engagement-profile-client.ts';
export { Effect } from '@modern-js/plugin-bff/effect-client';

export type ContactsClient = PartyRegistryHttpClient;
export type ContactsClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type ContactsClientEffect<Success> = Effect.Effect<Success, ContactsClientError>;

const correlationIdOption = 'correlationId' as const;
const traceIdOption = 'traceId' as const;
const traceparentOption = 'traceparent' as const;

export interface ContactsClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly [traceparentOption]?: string;
}

export interface ContactsOperationOptions extends ContactsClientOptions {
  readonly [correlationIdOption]: string;
  readonly gateway?: GatewayContextClientOptions;
  readonly [traceIdOption]?: string;
}

export interface ContactsMutationOptions extends ContactsOperationOptions {
  readonly idempotencyKey: string;
}

export const createContactsClient = (
  options: ContactsClientOptions = {},
): ContactsClientEffect<ContactsClient> => createPartyRegistryHttpClient(options);

const invoke = <Success, Failure>(
  options: ContactsOperationOptions,
  context: OperationContext,
  operation: (client: ContactsClient) => Effect.Effect<Success, Failure>,
) =>
  operationGateway.invoke((authorization) => {
    const operationContext = options.operationContext ?? context;
    const requestContext = authenticatePartyRegistryHttpRequest(
      partyRegistryHttpRequestContext({ ...options, operationContext }),
      Redacted.make(authorization),
      options[correlationIdOption],
      'x-correlation-id',
      options[traceIdOption],
    );
    return invokePartyRegistryHttpClient(requestContext, operation);
  }, options.gateway);

const engagementMutation =
  <Payload, Success, Failure>(
    context: OperationContext,
    endpoint: (
      client: ContactsClient,
    ) => (request: {
      headers: { 'idempotency-key': string };
      payload: Payload;
    }) => Effect.Effect<Success, Failure>,
  ) =>
  (payload: Payload, options: ContactsMutationOptions) =>
    invoke(options, context, (client) =>
      endpoint(client)({ headers: { 'idempotency-key': options.idempotencyKey }, payload }),
    );

export const getContactsReadiness = (
  options: ContactsClientOptions = {},
): ContactsClientEffect<PartyRegistryReadiness> =>
  createContactsClient({
    ...options,
    operationContext: options.operationContext ?? partyRegistryOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export const attachOrganizationEngagement = engagementMutation(
  engagementProfileOperationContexts.attachOrganizationEngagement,
  (client) => client.organizationEngagementMutations.attach,
);

export const archiveOrganizationEngagement = engagementMutation(
  engagementProfileOperationContexts.archiveOrganizationEngagement,
  (client) => client.organizationEngagementMutations.archive,
);

export const unarchiveOrganizationEngagement = engagementMutation(
  engagementProfileOperationContexts.unarchiveOrganizationEngagement,
  (client) => client.organizationEngagementMutations.unarchive,
);

export const attachPersonEngagement = engagementMutation(
  engagementProfileOperationContexts.attachPersonEngagement,
  (client) => client.personEngagementMutations.attach,
);

export const archivePersonEngagement = engagementMutation(
  engagementProfileOperationContexts.archivePersonEngagement,
  (client) => client.personEngagementMutations.archive,
);

export const unarchivePersonEngagement = engagementMutation(
  engagementProfileOperationContexts.unarchivePersonEngagement,
  (client) => client.personEngagementMutations.unarchive,
);
