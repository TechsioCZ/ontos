import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/bff-effect/effect-client';
import { taxApi, taxApiContract, taxOperationContexts } from '../../shared/api.ts';
import type { OperationContext, TaxReadiness } from '../../shared/api.ts';

// oxlint-disable-next-line effect-native/no-scattered-browser-effect-run -- Generated compatibility surface retained for existing callers.
export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export * from './correct-tax-rule-revision-action-client.ts';
export * from './create-tax-rule-action-client.ts';
export * from './create-tax-rule-revision-action-client.ts';
export * from './end-tax-fact-authority-contract-action-client.ts';
export * from './end-tax-rule-revision-action-client.ts';
export * from './establish-tax-fact-authority-contract-action-client.ts';
export * from './record-tax-source-assertion-action-client.ts';
export * from './revise-tax-fact-authority-contract-action-client.ts';
// </generated-action-http-client-exports>

type TaxApiGroups = typeof taxApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;
export type TaxClient = HttpApiClient.Client<Extract<TaxApiGroups, HttpApiGroup.Constraint>>;
export type TaxClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type TaxClientEffect<Success> = Effect.Effect<Success, TaxClientError>;

export interface TaxClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This public option is the caller-provided W3C wire header consumed by the generated HTTP transport; remove-when: the framework client accepts an ambient request context.
  readonly traceparent?: string;
}

export const createTaxClient = (options: TaxClientOptions = {}): TaxClientEffect<TaxClient> => {
  const requestContext = {};
  if (options.locale !== undefined) {
    Object.assign(requestContext, { locale: options.locale });
  }
  if (options.operationContext !== undefined) {
    Object.assign(requestContext, { operationContext: options.operationContext });
  }
  if (options.traceparent !== undefined) {
    Object.assign(requestContext, { traceparent: options.traceparent });
  }
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- Generated public factory binds caller-specific request metadata.
  return makeEffectHttpApiClient(taxApi, {
    baseUrl: options.baseUrl ?? taxApiContract.apiPrefix,
    requestContext,
  });
};

export const getTaxReadiness = (options: TaxClientOptions = {}): TaxClientEffect<TaxReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- Generated wrapper delegates caller-specific request metadata.
  createTaxClient({
    ...options,
    operationContext: options.operationContext ?? taxOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
