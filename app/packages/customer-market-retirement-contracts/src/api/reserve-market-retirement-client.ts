import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Match, Redacted, Schema } from 'effect';
import type { HttpApiClient } from 'effect/http-api';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';

import { ReserveMarketRetirementApi, ReserveMarketRetirementPayloadSchema } from '../apis/reserve-market-retirement.ts';
import type {
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '../apis/reserve-market-retirement.ts';
import { operationGateway } from './action-gateway.ts';

export interface ReserveMarketRetirementClientOptions {
  readonly baseUrl?: string | URL;
  readonly compositionRevision?: string;
  readonly gateway?: Parameters<typeof operationGateway.invoke>[1];
  readonly idempotencyKey: string;
  /**
   * O80: ask for a parked proposal instead of an immediate write. Omitted means the ordinary run, so a
   * refusal is never turned into a proposal on the caller's behalf.
   */
  readonly intent?: 'propose';
}

type AuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options: ReserveMarketRetirementClientOptions,
];
type OperationInvocation = readonly [requestCorrelation: string, options: ReserveMarketRetirementClientOptions];

type EndpointResult = ReturnType<
  HttpApiClient.ForApi<typeof ReserveMarketRetirementApi>['reserveMarketRetirement']['execute']
>;
type ClientResult = ReserveMarketRetirementResult | ActionProposalAccepted;
type AuthorizedResult = Effect.Effect<ClientResult, Effect.Error<EndpointResult> | Schema.SchemaError>;

export const executeReserveMarketRetirementWithAuthorization = (
  payload: ReserveMarketRetirementPayload,
  ...[credential, requestCorrelation, options]: AuthorizedInvocation
): AuthorizedResult =>
  Schema.encodeUnknownEffect(ReserveMarketRetirementPayloadSchema)(payload).pipe(
    Effect.flatMap((encoded) =>
      makeGovernedEffectBffClient(
        {
          api: ReserveMarketRetirementApi,
          credential: Redacted.make(credential),
          defaultApiPrefix: '/commerce-customer-context-api',
          idempotencyKey: options.idempotencyKey,
          intent: options.intent,
          requestCorrelation,
        },
        options,
      ).pipe(
        Effect.flatMap((client) =>
          Match.value(encoded).pipe(
            Match.when({ operation: 'COMMIT' }, (commitPayload) =>
              client.reserveMarketRetirement.execute({ payload: commitPayload }),
            ),
            Match.when({ operation: 'RELEASE' }, (releasePayload) =>
              client.reserveMarketRetirement.execute({ payload: releasePayload }),
            ),
            Match.when({ operation: 'RESERVE' }, (reservePayload) =>
              client.reserveMarketRetirement.execute({ payload: reservePayload }),
            ),
            Match.exhaustive,
          ),
        ),
      ),
    ),
  );

export const executeReserveMarketRetirement = (
  payload: ReserveMarketRetirementPayload,
  ...[requestCorrelation, options]: OperationInvocation
): ReturnType<typeof operationGateway.invoke<ClientResult, Effect.Error<AuthorizedResult>>> =>
  operationGateway.invoke(
    (credential, { apiBaseUrl, compositionRevision }) =>
      executeReserveMarketRetirementWithAuthorization(payload, credential, requestCorrelation, {
        ...options,
        baseUrl: apiBaseUrl,
        compositionRevision,
      }),
    options.gateway,
  );
