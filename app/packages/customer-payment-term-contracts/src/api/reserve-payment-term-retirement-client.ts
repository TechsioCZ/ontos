// Customer-owned generated-style client for the Payment Term retirement Action gateway.
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted, Schema } from 'effect';
import {
  ReservePaymentTermRetirementApi,
  ReservePaymentTermRetirementPayloadSchema,
} from '../apis/reserve-payment-term-retirement.ts';
import type { ReservePaymentTermRetirementPayload } from '../apis/reserve-payment-term-retirement.ts';
import { operationGateway } from './action-gateway.ts';

export interface ReservePaymentTermRetirementClientOptions {
  readonly baseUrl?: string | URL;
  readonly gateway?: Parameters<typeof operationGateway.invoke>[1];
  readonly idempotencyKey: string;
}

type AuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options: ReservePaymentTermRetirementClientOptions,
];
type OperationInvocation = readonly [requestCorrelation: string, options: ReservePaymentTermRetirementClientOptions];

export const executeReservePaymentTermRetirementWithAuthorization = (
  payload: ReservePaymentTermRetirementPayload,
  ...[credential, requestCorrelation, options]: AuthorizedInvocation
) =>
  Schema.encodeUnknownEffect(ReservePaymentTermRetirementPayloadSchema)(payload).pipe(
    Effect.flatMap((encoded) =>
      makeGovernedEffectBffClient(
        {
          api: ReservePaymentTermRetirementApi,
          credential: Redacted.make(credential),
          defaultApiPrefix: '/commerce-customer-context-api',
          requestCorrelation,
        },
        options,
      ).pipe(
        Effect.flatMap((client) =>
          client.reservePaymentTermRetirement.execute({
            headers: { 'idempotency-key': options.idempotencyKey },
            params: {},
            payload: encoded,
            query: {},
          }),
        ),
      ),
    ),
  );

export const executeReservePaymentTermRetirement = (
  payload: ReservePaymentTermRetirementPayload,
  ...[requestCorrelation, options]: OperationInvocation
) =>
  operationGateway.invoke(
    (credential) =>
      executeReservePaymentTermRetirementWithAuthorization(payload, credential, requestCorrelation, options),
    options.gateway,
  );
