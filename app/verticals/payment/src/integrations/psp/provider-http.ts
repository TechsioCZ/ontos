import { Context, Schema } from 'effect';
import type { Effect } from 'effect';
import type { HttpClientRequest } from 'effect/http';

import type { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayProviderOutcomeUnknownError, GatewayProviderUnavailableError } from './psp-errors.ts';

/**
 * The single outbound HTTP seam of the PSP adapters (#1158). Reads are retried within a small
 * bound; mutations are sent exactly once and an ambiguous transport outcome is OUTCOME_UNKNOWN.
 * No body, header or secret is logged or put into an error.
 */

/** Fully buffered provider response. Any status, including 4xx, is returned for classification. */
export const ProviderHttpResponseSchema = Schema.Struct({
  bodyText: Schema.String,
  status: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 599, minimum: 100 })),
});
export type ProviderHttpResponse = typeof ProviderHttpResponseSchema.Type;

export interface ProviderHttpReadRequest {
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  readonly request: HttpClientRequest.HttpClientRequest;
}

export interface ProviderHttpMutationRequest {
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  readonly operationId: typeof PaymentOperationIdSchema.Type;
  readonly request: HttpClientRequest.HttpClientRequest;
}

export interface ProviderHttpContract {
  /**
   * One attempt, 20 s. Timeout, a drop after the request was written, or 5xx is OUTCOME_UNKNOWN;
   * DNS failure or refused connection before the write is UNAVAILABLE; 4xx is returned. Never retried.
   */
  readonly mutate: (
    request: ProviderHttpMutationRequest,
  ) => Effect.Effect<ProviderHttpResponse, GatewayProviderOutcomeUnknownError | GatewayProviderUnavailableError>;
  /**
   * Up to 3 attempts, exponential backoff from 200 ms, 10 s per attempt; retries only transport
   * failures, 429 and 5xx. A final failure (including a final 429/5xx) is `GatewayProviderUnavailable`.
   */
  readonly read: (
    request: ProviderHttpReadRequest,
  ) => Effect.Effect<ProviderHttpResponse, GatewayProviderUnavailableError>;
}

export class ProviderHttp extends Context.Service<ProviderHttp, ProviderHttpContract>()(
  '@app/payment/integrations/psp/provider-http/ProviderHttp',
) {}
