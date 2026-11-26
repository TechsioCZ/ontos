import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted, Schema } from 'effect';
import {
  RecordOwnerExecutionOutcomeApi,
  RecordOwnerExecutionOutcomePayloadSchema,
} from '../apis/record-owner-execution-outcome.ts';
import type { RecordOwnerExecutionOutcomePayload } from '../apis/record-owner-execution-outcome.ts';
import { operationGateway } from './action-gateway.ts';

const traceIdOption = 'traceId' as const;

export interface RecordOwnerExecutionOutcomeClientOptions {
  readonly baseUrl?: string | URL;
  readonly compositionRevision?: string;
  readonly gateway?: Parameters<typeof operationGateway.invoke>[1];
  readonly idempotencyKey: string;
  /**
   * O80: ask for a parked proposal instead of an immediate write. Omitted means the ordinary run, so a
   * refusal is never turned into a proposal on the caller's behalf.
   */
  readonly intent?: 'propose';
  readonly [traceIdOption]?: string;
}

type AuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options: RecordOwnerExecutionOutcomeClientOptions,
];
type OperationInvocation = readonly [requestCorrelation: string, options: RecordOwnerExecutionOutcomeClientOptions];

interface MakeClientOptions {
  readonly credential: Redacted.Redacted;
  readonly options: RecordOwnerExecutionOutcomeClientOptions;
  readonly requestCorrelation: string;
}

const makeClient = ({ credential, options, requestCorrelation }: MakeClientOptions) =>
  makeGovernedEffectBffClient(
    {
      api: RecordOwnerExecutionOutcomeApi,
      credential,
      defaultApiPrefix: '/privacy-api',
      idempotencyKey: options.idempotencyKey,
      intent: options.intent,
      requestCorrelation,
    },
    options,
  );

export const executeRecordOwnerExecutionOutcomeWithAuthorization = (
  payload: RecordOwnerExecutionOutcomePayload,
  ...[credential, requestCorrelation, options]: AuthorizedInvocation
) =>
  Schema.encodeUnknownEffect(RecordOwnerExecutionOutcomePayloadSchema)(payload).pipe(
    Effect.flatMap((encoded) =>
      makeClient({ credential: Redacted.make(credential), options, requestCorrelation }).pipe(
        Effect.flatMap((client) => client.recordOwnerExecutionOutcome.execute({ payload: encoded })),
      ),
    ),
  );

export const executeRecordOwnerExecutionOutcome = (
  payload: RecordOwnerExecutionOutcomePayload,
  ...[requestCorrelation, options]: OperationInvocation
) =>
  operationGateway.invoke(
    (credential, { apiBaseUrl, compositionRevision }) =>
      executeRecordOwnerExecutionOutcomeWithAuthorization(payload, credential, requestCorrelation, {
        ...options,
        baseUrl: apiBaseUrl,
        compositionRevision,
      }),
    options.gateway,
  );
