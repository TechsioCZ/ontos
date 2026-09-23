import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Match, Redacted, Schema } from 'effect';

import { ReserveMarketRetirementApi, ReserveMarketRetirementPayloadSchema } from '../apis/reserve-market-retirement.ts';
import type { ReserveMarketRetirementPayload } from '../apis/reserve-market-retirement.ts';
import { operationGateway } from './action-gateway.ts';

export interface ReserveMarketRetirementClientOptions {
  readonly baseUrl?: string | URL;
  readonly gateway?: Parameters<typeof operationGateway.invoke>[1];
  readonly idempotencyKey: string;
}

type AuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options: ReserveMarketRetirementClientOptions,
];
type OperationInvocation = readonly [requestCorrelation: string, options: ReserveMarketRetirementClientOptions];

export const executeReserveMarketRetirementWithAuthorization = (
  payload: ReserveMarketRetirementPayload,
  ...[credential, requestCorrelation, options]: AuthorizedInvocation
) =>
  Schema.encodeUnknownEffect(ReserveMarketRetirementPayloadSchema)(payload).pipe(
    Effect.flatMap((encoded) =>
      makeGovernedEffectBffClient(
        {
          api: ReserveMarketRetirementApi,
          credential: Redacted.make(credential),
          defaultApiPrefix: '/commerce-customer-context-api',
          requestCorrelation,
        },
        options,
      ).pipe(
        Effect.flatMap((client) => {
          const request = {
            headers: { 'idempotency-key': options.idempotencyKey },
            params: {},
            query: {},
          } as const;
          return Match.value(encoded).pipe(
            Match.when({ operation: 'COMMIT' }, (commitPayload) =>
              client.reserveMarketRetirement.execute({ ...request, payload: commitPayload }),
            ),
            Match.when({ operation: 'RELEASE' }, (releasePayload) =>
              client.reserveMarketRetirement.execute({ ...request, payload: releasePayload }),
            ),
            Match.when({ operation: 'RESERVE' }, (reservePayload) =>
              client.reserveMarketRetirement.execute({ ...request, payload: reservePayload }),
            ),
            Match.exhaustive,
          );
        }),
      ),
    ),
  );

export const executeReserveMarketRetirement = (
  payload: ReserveMarketRetirementPayload,
  ...[requestCorrelation, options]: OperationInvocation
) =>
  operationGateway.invoke(
    (credential) => executeReserveMarketRetirementWithAuthorization(payload, credential, requestCorrelation, options),
    options.gateway,
  );
