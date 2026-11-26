import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted, Schema } from 'effect';
import {
  SubmitCommunicationRequestApi,
  SubmitCommunicationRequestPayloadSchema,
} from '../apis/submit-communication-request.ts';
import type { SubmitCommunicationRequestPayload } from '../apis/submit-communication-request.ts';
import { operationGateway } from './action-gateway.ts';

const traceIdOption = 'traceId' as const;

export interface SubmitCommunicationRequestClientOptions {
  readonly baseUrl?: string | URL;
  readonly compositionRevision?: string;
  readonly gateway?: Parameters<typeof operationGateway.invoke>[1];
  readonly idempotencyKey: string;
  readonly [traceIdOption]?: string;
}

type AuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options: SubmitCommunicationRequestClientOptions,
];
type OperationInvocation = readonly [requestCorrelation: string, options: SubmitCommunicationRequestClientOptions];

interface MakeClientOptions {
  readonly credential: Redacted.Redacted;
  readonly options: SubmitCommunicationRequestClientOptions;
  readonly requestCorrelation: string;
}

const makeClient = ({ credential, options, requestCorrelation }: MakeClientOptions) =>
  makeGovernedEffectBffClient(
    {
      api: SubmitCommunicationRequestApi,
      credential,
      defaultApiPrefix: '/communications-api',
      idempotencyKey: options.idempotencyKey,
      requestCorrelation,
    },
    options,
  );

export const executeSubmitCommunicationRequestWithAuthorization = (
  payload: SubmitCommunicationRequestPayload,
  ...[credential, requestCorrelation, options]: AuthorizedInvocation
) =>
  Schema.encodeUnknownEffect(SubmitCommunicationRequestPayloadSchema)(payload).pipe(
    Effect.flatMap((encoded) =>
      makeClient({ credential: Redacted.make(credential), options, requestCorrelation }).pipe(
        Effect.flatMap((client) => client.submitCommunicationRequest.execute({ payload: encoded })),
      ),
    ),
  );

export const executeSubmitCommunicationRequest = (
  payload: SubmitCommunicationRequestPayload,
  ...[requestCorrelation, options]: OperationInvocation
) =>
  operationGateway.invoke(
    (credential, { apiBaseUrl, compositionRevision }) =>
      executeSubmitCommunicationRequestWithAuthorization(payload, credential, requestCorrelation, {
        ...options,
        baseUrl: apiBaseUrl,
        compositionRevision,
      }),
    options.gateway,
  );
